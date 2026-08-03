# reviewer-1 reliability findings — baseline smoke run (Task 3 gate)

**Date:** 2026-08-03
**Command:** `pnpm exec tsx scripts/reviewer-smoke.ts --timeout-sec 300`
**Result:** exit 1, no reply within 300s. **Gate tripped — the 2026-07-27 fault reproduced.**

## Summary

The read-only-filesystem crash first seen on 2026-07-27 (`Read-only file
system (os error 30)` surfacing through Codex's `Reconnecting... N/5:` retry
wrapper) reproduced again today, on an independent run six days later. The
task's own `finally` cleanup (added in Task 2) worked correctly — no stray
task was left in `ncl tasks list`.

## Exact error

From the newest archived conversation,
`groups/reviewer-1/conversations/2026-08-03-codex-019fc7b3-c87b-7a51-9299-00bc3527a3c0.md`:

```
**Assistant**: Error: Reconnecting... 2/5: Read-only file system (os error 30)
```

Archived at 2026-08-03 08:57 (local), status: error.

## Which diagnostic commands produced what

1. **`docker ps -a --format '{{.Names}}\t{{.Status}}' | grep n3m1xl`** — no
   rows. The reviewer-1 container is not present at any status (not even
   `Exited`), because the container runner spawns with `--rm`. Absence here is
   expected regardless of success or failure and does not by itself indicate
   an immediate-exit (image-tag) problem.

2. **Image tag check** —
   `pnpm exec tsx scripts/q.ts data/v2.db "SELECT image_tag FROM container_configs WHERE agent_group_id='ag-1779729652625-n3m1xl'"`
   returned an empty string (no per-group override), so the spawn falls back
   to the default `nanoclaw-agent-v2-edb15411:latest`, which exists in
   `docker images` and is the same tag several other live agent-group
   containers are currently running on. **Ruled out: wrong/missing image
   tag.**

3. **`tail -50 logs/nanoclaw.error.log`** — no reviewer-1-specific fatal entries
   near the failure window; only unrelated Telegram polling network errors and
   an unrelated `ads` group OneCLI timeout from a different agent group.
   Nothing host-side flagged a spawn failure for reviewer-1, consistent with
   the container starting and running Codex, then Codex itself faulting
   internally.

4. **`ls -lt groups/reviewer-1/conversations/ | head -3`** — newest file is
   the one quoted above, timestamp matching the smoke run. Confirms the
   archived transcript is genuinely from this run, not a stale artifact.

5. **`ls -la data/v2-sessions/ag-1779729652625-n3m1xl/.codex-shared/`** —
   `config.toml` mtime is `Aug 3 08:57`, i.e. written at the exact failure
   timestamp. This confirms (per the brief) that the write to
   `.codex-shared` (mounted `readonly: false` at
   `src/providers/codex.ts:69`) succeeded — the read-only-filesystem fault is
   **not** there.

6. **`onecli agents list`** — reviewer-1's `secretMode` is `"selective"`
   (`id: f2fafcfb-acf0-448f-9a20-46221e7a8514`). Not directly implicated in
   the EROFS fault (see below), but noted as a standing configuration detail.

7. **`codex --version` inside the image** — `codex-cli 0.145.0`. This is the
   pinned, current version (the 2026-07 "`gpt-5.6-terra` requires a newer
   version of Codex" issue is confirmed fixed; not a version problem).

## Deeper trace: internal Codex logs (`logs_2.sqlite`)

Querying `data/v2-sessions/ag-1779729652625-n3m1xl/.codex-shared/logs_2.sqlite`
(Codex's own structured log, inside the RW-mounted `.codex-shared` dir) for
the failure window (`ts >= 1785761800`, i.e. ~2026-08-03 12:57:54 UTC /
08:57:54 local) shows:

- A `thread/start` app-server request begins a `session_init` span, which
  enters a `startup_prewarm` sub-span (`session_init:startup_prewarm{...}`,
  `codex-mcp/src/connection_manager.rs:615`).
- Immediately prior/alongside, several **401 `token_expired`** errors appear
  on ChatGPT-backend calls (`list_models`, plugins catalog warm, analytics
  events) — ancillary background calls, logged as `WARN`/non-fatal
  ("continuing with cached tools"), not the crash itself.
- The log then **stops abruptly at id=30649**, mid-way through the
  `startup_prewarm` span, with no further rows in the table. There is no
  explicit `os error 30` string logged this time (unlike 2026-07-27, where
  `id=30520`, target `codex_core::session_startup_prewarm`,
  `core/src/session_startup_prewarm.rs:168`, logged verbatim: `startup
  websocket prewarm setup failed: Read-only file system (os error 30)`).

**Interpretation:** both runs fail inside the same internal code path —
`session_init` → `startup_prewarm` (`codex_core::session_startup_prewarm`,
`session_startup_prewarm.rs:168`). On 2026-07-27 the fatal EROFS message
itself was captured in the log before the process gave up. On 2026-08-03 the
crash happened before that final line could be flushed to
`logs_2.sqlite` (which lives in the RW `.codex-shared` mount) — consistent
with the same underlying fault, one write earlier in the sequence than last
time got hit. The user-facing `Reconnecting... 2/5: Read-only file system (os
error 30)` text in the archived conversation is the same error class as the
2026-07-27 incident, just surfaced one layer up (agent-runner's retry
wrapper around the crashed Codex process) rather than from the internal log
line.

Per the brief's guidance, the write is **not** to `.codex-shared`
(confirmed by `config.toml`'s successful write at the same timestamp). The
`startup_prewarm` step's job is to warm up MCP/tool connections and
(per Codex's naming) resolve/cache websocket connection state — the likely
target of the failing write is one of the container's read-only-mounted
paths layered inside otherwise-writable directories:

- `/app/*` (agent-runner source + skills, `readonly: true`,
  `src/container-runner.ts:382,387`)
- `/workspace/agent/AGENTS.md` (single-file RO mount over the RW group dir,
  `src/providers/codex.ts:74`)
- `/workspace/agent/.agents` (RO subtree mount, `src/providers/codex.ts:78`)
- `/home/node/.agents` (RO subtree mount, mirrored for user-level skill
  discovery, `src/providers/codex.ts:86`)

No container process was still alive to inspect directly (removed by
`--rm` on exit), so the exact syscall path could not be captured with an
strace-equivalent in this pass. Pinning down which of the four candidate
paths is being written requires either reproducing with a modified/patched
image (out of scope for this gate — script and prompt are frozen) or adding
temporary diagnostic logging inside the container, which is a Task 4/5-scope
change.

## Does it reproduce on a second run?

Not re-run a second consecutive time in this session — doing so would incur
another live container spawn and real Codex API tokens beyond what this gate
requires. However, the fault has now been observed on **two independent
days, six days apart** (2026-07-27 and 2026-08-03), both crashing at the same
internal code path with the same user-facing error text, against a history
of exactly one successful review ever. This is strong evidence the fault is
a **stable, reproducible defect**, not an intermittent flake — it is the
dominant outcome, not the exception.

## What was ruled out

- **Wrong image tag / immediate container exit** — ruled out; default tag
  resolves correctly and is in active use by other groups.
- **Auth (401) as the root cause** — the 401s seen in this run's logs are
  against ancillary ChatGPT-backend calls (model list refresh, plugin
  catalog warm, analytics events), logged as recoverable warnings, and are a
  separate signal from the fatal EROFS crash in `startup_prewarm`. They may
  be worth investigating separately (token refresh timing via OneCLI) but do
  not explain the read-only-filesystem fault.
- **Codex version mismatch** — ruled out; `codex-cli 0.145.0` in the image,
  no "requires a newer version" error present.

## Verdict / handoff

**Gate result: FAIL.** Per the brief, Task 4 (prompt rewrite) must not begin
until this is fixed. The most likely root cause is a Codex internal
`startup_prewarm` write landing inside one of the container's read-only
mounts (`/app`, `/workspace/agent/AGENTS.md`, `/workspace/agent/.agents`, or
`/home/node/.agents`). A follow-up plan should:

1. Instrument (temporarily) or strace the container process during a
   controlled repro to identify the exact path Codex's `startup_prewarm`
   step is writing to.
2. Once identified, either relocate that write target into a writable mount
   (most likely candidate: extend the `/home/node/.codex` RW mount, or add a
   narrowly-scoped RW mount for whatever cache/state directory
   `startup_prewarm` needs) or set the relevant Codex config/env to point
   its cache elsewhere.
3. Re-run `pnpm exec tsx scripts/reviewer-smoke.ts --timeout-sec 300` after
   the fix and confirm a reply is produced (exit 0 or exit 1-with-reply are
   both acceptable outcomes post-fix; exit 1-with-no-reply is not).

## Task cleanup verification

`pnpm run -s ncl tasks list --group ag-1779729652625-n3m1xl` after the run
returned `No tasks.` — the `finally`-block deletion added in Task 2 worked
correctly on its first live exercise; no stray task was left behind.

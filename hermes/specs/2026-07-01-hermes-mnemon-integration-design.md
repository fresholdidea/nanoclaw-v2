# Hermes ↔ mnemon Integration — Design Spec

- **Date:** 2026-07-01 (designed and deployed) · 2026-07-07 (re-verified)
- **Status:** ✅ Implemented and live — **do not re-run `mnemon setup --target hermes --global`**
- **Author:** Brad + Claude
- **Topic:** Give the Hermes agent (Nous Research) a mnemon recall/remember loop against the shared `~/.mnemon` store.

## Context

Brad runs NanoClaw across ~22 agent groups (Zed, Falcone, the `*-am` groups, wiki, home, paid-media, …). Persistent memory is provided by **mnemon** — a standalone memory daemon whose shared store at `~/.mnemon` is already used by the host Claude Code plus 18/20 nanoclaw groups. Agents recall relevant memories before responding and remember new insights after.

Brad separately runs the **Hermes agent** (Nous Research) at `~/.hermes/hermes-agent/` — a distinct Python agent framework (multi-model: glm, deepseek, owl-alpha, …) with its own CLI, TUI gateway, desktop app, and dashboard. Today Hermes has **no mnemon integration**.

This spec covers wiring mnemon into Hermes. It is explicitly framed as **step 1 of a larger workstream**: Brad intends to run NanoClaw and Hermes **side by side**, and this "might become a full migration project." The `hermes/` folder in this repo is the home for that workstream (specs, plans, notes). Shared memory across both stacks is a prerequisite for a meaningful side-by-side evaluation, which is why it comes first.

## Goal & Success Criteria

Give Hermes the same "recall before / remember after" memory loop the other agents have, against the shared store, without disturbing Hermes' own memory system.

Done when:
1. ✅ A Hermes session recalls relevant insights from the shared `~/.mnemon` store.
2. ✅ New insights from a Hermes session are written back to the same shared store (and are subsequently recallable by nanoclaw agents / host Claude Code — proving it's genuinely shared).
3. ✅ Hermes' native memory (`MEMORY.md` / `USER.md`) is left functioning and untouched. (Note: this profile does not have a native `MEMORY.md` / `USER.md` on disk, so criterion is vacuously satisfied. The hooks do not create or touch these files.)
4. ✅ The integration is cleanly reversible.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Relationship to Hermes' built-in memory | **Complement** (run alongside) | Lowest risk; matches how other agents use mnemon; Hermes keeps its curated `MEMORY.md`/`USER.md`. |
| Memory store | **Shared `~/.mnemon`** (unified) | Cross-agent continuity; mnemon's relevance ranking keeps cross-domain noise down. It is mnemon's default `--data-dir`. |
| Integration mechanism | **Official installer** — `mnemon setup --target hermes --global` | mnemon ships first-class Hermes support ("Hermes Agent uses its native user config at `~/.hermes/`"). Blessed path, consistent with the existing Claude Code install, reversible via `--eject`. |

### Approaches considered and rejected
- **B — hand-rolled shell hooks** (`on_session_start` recall / `on_session_end` remember + a `hooks:` config block). Reinvents what the installer does; higher maintenance against Hermes upgrades. Rejected.
- **C — mnemon as a Hermes tool/MCP.** Agent-driven, not the automatic loop requested. Possible future add-on, not the core. Rejected for now.

## Background: relevant facts discovered

**mnemon CLI surface** (`mnemon --help`):
- `recall [keyword] --limit N` — intent-aware graph-enhanced retrieval (`--basic` for SQL LIKE).
- `remember [content] --cat --imp --tags --entities --source` — store an insight.
- `event emit` — append a lifecycle event to the harness eventlog (how harness integrations signal session start/end/etc.).
- `setup --target hermes [--global] [--eject] [--yes]` — deploy/remove mnemon integration for a target CLI. Supported targets: claude-code, codex, openclaw, nanobot, pi, **hermes**.
- Default `--data-dir` = `/Users/bradhess/.mnemon` (the shared store). Embeddings via Ollama (`nomic-embed-text`) — already provisioned machine-wide (existing `mnemon recall` returns results).

**Hermes extension surfaces** (from codebase exploration):
- Shell-hook system with a `hooks:` config block in `~/.hermes/config.yaml`; hooks `on_session_start`, `on_session_end`, `post_llm_call`, `on_session_finalize`. Payload delivered as JSON on stdin. Mirrors Claude Code's SessionStart/UserPromptSubmit model.
- First shell-hook run requires allowlist approval (`~/.hermes/shell-hooks-allowlist.json`); can be pre-accepted.
- Hermes **already** has memory: curated `MEMORY.md`/`USER.md` injected into the system prompt's volatile tier, plus a pluggable `MemoryProvider` ABC (mem0/honcho/supermemory/…). mnemon runs as a **separate layer**, not through this ABC.
- Prompt caching is guarded — the volatile tier is frozen mid-session. mnemon must not mutate the system prompt per turn; it operates via hooks/eventlog, not prompt injection.

## Implementation Plan (Approach A)

1. **Snapshot** current `~/.hermes/` config surface (`config.yaml`, any `hooks:` block, `shell-hooks-allowlist.json`) so we can diff and revert precisely.
2. **Run the installer interactively** first: `mnemon setup --target hermes --global` — read its stated plan before confirming (no blind `--yes`).
3. **Diff & verify** what it wrote:
   - Recall/remember wired into Hermes' hook / `event` lifecycle.
   - Points at the shared `~/.mnemon` store (default data-dir; no separate store created).
   - Hermes' native `MEMORY.md`/`USER.md` untouched (complement, not replace).
4. **Test end-to-end:**
   - Recall: start a Hermes session, confirm it pulls a known shared-store memory.
   - Remember: have Hermes store a uniquely-tagged insight, then confirm it's recallable from outside Hermes (`mnemon recall` on the host) — proving the shared store round-trips.
5. **Report** the exact changes; if anything is off, `mnemon setup --eject --target hermes` and reconsider.

## Verification Criteria
- [x] `mnemon recall` from a Hermes session returns shared-store insights.
- [x] An insight written during a Hermes session is visible to host `mnemon recall` (round-trip proof of shared store).
- [x] `~/.hermes/.../MEMORY.md` and `USER.md` still load and are unmodified by the install. *(Profile has neither file; hooks do not create them.)*
- [x] Data-dir is `~/.mnemon` (no stray per-Hermes store).
- [ ] `--eject` cleanly removes the integration (rollback verified, at least by dry-run/inspection). — **Not yet tested.** Do not run `--eject` without intent; it would remove the live integration.

## Risks & Rollback
- **Risk:** installer wires something unexpected or replaces native memory. **Mitigation:** interactive run + snapshot/diff before accepting; `--eject` to revert.
- **Risk:** shell-hook allowlist prompt blocks automated sessions. **Mitigation:** pre-accept via the allowlist / config during install.
- **Risk:** Hermes auto-updates from upstream may disturb the integration. **Mitigation:** integration lives in user config (`~/.hermes/`), not the repo tree; re-run `setup` if an update clobbers it.
- **Rollback:** `mnemon setup --eject --target hermes` + restore snapshot.

## Open Questions / To Verify at Implementation Time
1. Exact files `setup --target hermes` writes, and whether it uses `hooks:` + `event emit`, or an AGENTS.md/system-prompt nudge, or a tool. (Diff will reveal.)
2. Whether Hermes recalls/remembers **automatically** (hook-driven) or via an instruction nudge the model must act on — and if the latter, whether that's acceptable or we layer a tool.
3. Granularity: session-boundary vs per-turn recall (Hermes hooks are session-level; `post_llm_call` is per-turn). Decide only if step 4 testing shows session-level is too coarse.
4. Confirm Ollama embedding backend is reachable from Hermes' runtime the same way it is for host tools.

## Non-Goals
- Migrating nanoclaw → Hermes (that is the larger workstream this seeds, not this slice).
- Porting nanoclaw memories or reshaping the store.
- mnemon-as-tool / MCP (possible later add-on).
- Changing Hermes' native memory behavior.

---

## Post-implementation evidence (re-verified 2026-07-07)

**Hooks wired in `~/.hermes/config.yaml`:**

```yaml
hooks:
  on_session_start:
    - command: /Users/bradhess/.hermes/agent-hooks/mnemon/prime.sh
      timeout: 10
  pre_llm_call:
    - command: /Users/bradhess/.hermes/agent-hooks/mnemon/remind.sh
      timeout: 10
  post_llm_call:
    - command: /Users/bradhess/.hermes/agent-hooks/mnemon/nudge.sh
      timeout: 10
hooks_auto_accept: true
```

**Approvals (in `~/.hermes/shell-hooks-allowlist.json`):** prime.sh, nudge.sh, remind.sh — granted 2026-07-01T02:54Z. `compact.sh` is also approved (on_session_finalize) but no script by that name exists and the event is not declared in `config.yaml` — **stale entry, harmless, see Loose ends below**.

**Store state (re-verified 2026-07-07):** `~/.mnemon/data/default/mnemon.db` — 1.88 MB, **80 insights, 2432 edges, 367 oplog entries**. Categories: 30 context, 30 fact, 12 preference, 5 insight, 3 decision. Top entities include LinkedIn (23), Brad (23), Cubby (13), HubSpot (12), meshberg (10) — matches the rest of the nanoclaw agent population, confirming this is the shared store, not a Hermes-only partition.

**Round-trip test (2026-07-07):**
- Wrote: `Hermes+mnemon verification: integration is already live as of 2026-07-01` (id `53740fcb-...`, score 0.859 on recall).
- Recalled prior 2026-07-01 verification memory: `Hermes agent mnemon integration installed and verified 2026-07-01` (id `aaf3f992-...`, score 0.619) — proves the integration was already installed and recorded on its own install day.
- Recalled third-party fact: `Deepline CLI on Brad's Mac (2026-06-30)` (id `a716abb3-...`, score via entity match) — proves the shared store is genuinely shared with host tools.

**Loose ends (cosmetic, not blocking):**
- `~/.hermes/shell-hooks-allowlist.json` has a stale `compact.sh` approval referencing a non-existent file and an event (`on_session_finalize`) not declared in `config.yaml`. Inert. Leave or hand-edit; do not run `mnemon setup --eject` to clean it up — that would remove the whole working integration.
- The spec was never updated from "Draft" to "Implemented" after the 2026-07-01 install. This is the gap that produced the false re-deploy question. **Lesson:** when the install succeeds, edit the spec to "done" the same session.

**Why this doc sat open as "Draft" for 6 days despite working:** the original install session wrote a verification memory and confirmed success but did not flip the doc's status. Future spec-driven installs should follow this checklist as a hard step in the install flow:
1. Run the installer
2. Diff & verify on disk
3. Update the spec doc to "implemented" with on-disk evidence
4. Remember a verification memory
5. Tell the user the spec status is "done," not "draft"

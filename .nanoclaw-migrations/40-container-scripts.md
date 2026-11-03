# 40 - Container image, agent-runner (non-provider), container skills, scripts/setup, top-level config

Refs used throughout: `KEEP=ed7eccd6` (local `main` tip), `BASE=64706602` (merge-base), `UP=f7440e85` (`origin/main`).
Everything below was derived from `git diff $BASE $KEEP` for my paths. Where I say "applies clean" I ran
`git apply --check` of that exact local diff against the `origin/main` version of the file in a scratch copy
(nothing in the repo was touched). Verdicts: REAPPLY / ALREADY-UPSTREAM / OBSOLETE / DROP.

Mechanical port recipe (only for files marked "clean"):
`git diff 64706602 ed7eccd6 -- <path> | git apply` run on the fresh origin/main tree.
Wholly-ours files/dirs: `git checkout ed7eccd6 -- <path>` (keeps the exec bit, which matters for `gws-account`).

Version rule applied everywhere: no local pin is NEWER than upstream. Where upstream moved, take upstream (table in Risks).

---

## Container image

Live image facts (read-only `docker run` of `nanoclaw-agent-v2-edb15411:latest`): Debian 12, python 3.11.2, node 22.23.3,
bun 1.4.0, claude-code 2.1.280, mnemon-real 0.1.14, nlm 0.8.7, pnpm globals sit directly in `/pnpm` (agent-browser, claude,
codex, gws, opencode; no `/pnpm/bin`). Default tag stays slug-based `nanoclaw-agent-v2-edb15411:latest`; `container/build.sh` is
untouched locally, so upstream's copy is used as-is (it derives the slug from `setup/lib/install-slug.sh`).

### Already upstream / take upstream verbatim (ALREADY-UPSTREAM)
Nothing local to carry; just do not overwrite with the old values:
- Base `FROM node:22.23.4-slim@sha256:...` (local was floating `node:22-slim`), Bun 1.4.4 + build-time version check, `poppler-utils`,
  `libnss3-tools` (needed by new `src/browser-trust.ts` gateway-CA trust), removal of the `NPM_VERSION` pin block.
- `container/pull.sh`, new `container/release-image.sh`, `dockerfile.test.ts`, `base-image.test.ts`: upstream-only.
- `container/install-cli-tools.sh`, `entrypoint.sh`, `build.sh`, `cli-tools.test.ts`: unchanged locally.

### I1. `python3` apt package - REAPPLY (required by the nlm install below)
Hunk rejects against upstream (neighbouring line moved). Do by hand in the base `apt-get install` list, alphabetical:
```
        git \
        poppler-utils \
        python3 \
        tini \
        unzip \
```
Keep the list a single `RUN ... apt-get install -y --no-install-recommends <pkgs> && ...`: upstream's `container/dockerfile.test.ts`
regex parses it and only asserts `poppler-utils` is present.

### I2. mnemon block - REAPPLY (Dockerfile + 2 wholly-ours files)
- Copy as-is: `container/mnemon-shim.sh`, `container/mnemon-queue.mjs` (mode 644 is fine; Dockerfile chmods the shim).
- Dockerfile block goes immediately ABOVE `# ---- Bun runtime` (the add-mnemon skill says the same). `ARG MNEMON_VERSION=0.1.14`; release binary
  installed as `/usr/local/bin/mnemon-real`; `COPY mnemon-shim.sh /usr/local/bin/mnemon`; `COPY mnemon-queue.mjs /usr/local/lib/mnemon-queue.mjs`;
  `RUN chmod +x /usr/local/bin/mnemon`; `ENV MNEMON_DATA_DIR=/workspace/extra/mnemon`. Take it verbatim with
  `git diff 64706602 ed7eccd6 -- container/Dockerfile | git apply --reject` (hunks 2-4 apply, see below).
- Guard tests that must stay green: `src/mnemon-dockerfile.test.ts` (greps `mnemon-real`, the two COPY lines, `ENV MNEMON_DATA_DIR=`),
  `src/mnemon-queue.test.ts`, and the inverted `mnemon-entrypoint.test.ts` (entrypoint must NOT run `mnemon setup`; upstream entrypoint
  already has no mnemon, so nothing to do).
- Pin is OLDER than the host binary (host Homebrew mnemon 0.2.8, latest release v0.2.13). The container only reads a host-built
  `VACUUM INTO` snapshot with `--readonly`; do not bump the pin without testing snapshot reads across the version gap.

### I3. notebooklm `nlm` block - REAPPLY (Dockerfile only)
`ARG NOTEBOOKLM_CLI_VERSION=0.8.7`, `ENV UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_DOWNLOADS=never`, curl-install uv
(`UV_UNMANAGED_INSTALL=/usr/local/bin`), `uv tool install --python /usr/bin/python3 "notebooklm-mcp-cli==${NOTEBOOKLM_CLI_VERSION}"`, `uv cache clean`,
delete uv/uvx, `chmod -R a+rX /opt/uv`, `ENV NOTEBOOKLM_MCP_CLI_PATH=/workspace/extra/notebooklm`. Sits right after the mnemon block (same patch).
Needs I1. Host runs nlm 0.15.5 for login; container 0.8.7 only reads `profiles/<n>/cookies.json` over HTTP, so version skew is expected.
Verify the install step on the new base (python3 may be 3.11 or 3.13 depending on the digest's Debian release).

### I4. deepline CLI block - REAPPLY (Dockerfile only, same patch)
`ARG DEEPLINE_VERSION=0.3.0`, `npm install --global --ignore-scripts --no-audit --no-fund "deepline@${DEEPLINE_VERSION}" --registry=https://code.deepline.com/api/v2/npm/`,
`ENV DEEPLINE_HOST_URL=https://code.deepline.com`. FLAG: pin 0.3.0 looks stale (host CLI is 0.3.407; public npm shows 0.3.461). Keep 0.3.0 for the
rebuild (behaviour-preserving) and treat a bump as a separate decision. Uses plain `npm` as root, which is why the old `NPM_VERSION` removal upstream is harmless.

### I5. `PATH` includes `$PNPM_HOME/bin` - REAPPLY (one line, same patch)
`ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"`. With `PNPM_VERSION=10.34.5` (unchanged upstream) globals land directly in `/pnpm`, so today it is a no-op;
it protects any overlay/skill install that runs under pnpm 11+ (the "build dies on the vercel step" failure in memory). Keep it; it is free.

### I6. `gws-account` PATH shim - REAPPLY (Dockerfile, same patch, + skill dir)
`printf '#!/bin/sh\nexec /app/skills/google-workspace/gws-account "$@"\n' > /usr/local/bin/gws-account && chmod +x`, placed after the `ncl` wrapper. The target
script is bind-mounted at runtime, so `container/skills/google-workspace/gws-account` MUST keep mode 100755 (use `git checkout ed7eccd6 --`). Needs `@googleworkspace/cli` in
cli-tools (I7). Memory: image rebuild is what makes the shim real.

**Dockerfile mechanics (tested):** `git diff 64706602 ed7eccd6 -- container/Dockerfile > d.patch; git apply --reject d.patch` against upstream's Dockerfile applies
hunks 2 (mnemon+nlm+deepline), 3 (PATH), 4 (gws shim) cleanly with small offsets; only hunk 1 (python3) is rejected -> apply I1 by hand, delete `Dockerfile.rej`.

### I7. `container/cli-tools.json` - REAPPLY via json-merge (exact pins)
Start from upstream (agent-browser 0.27.1, claude-code **2.1.296**) and append:
```json
{ "name": "opencode-ai", "version": "1.18.25", "onlyBuilt": true },
{ "name": "@openai/codex", "version": "0.155.1" },
{ "name": "@googleworkspace/cli", "version": "0.22.5", "onlyBuilt": true }
```
- claude-code: local 2.1.280 is older than upstream 2.1.296 -> upstream wins (claude-opus-5-5 needs >= 2.1.280, satisfied).
- `@openai/codex`: upstream's `/add-codex` SKILL now pins **0.162.1** (newer than local 0.155.1). Do NOT hand-carry 0.155.1; let the providers analyst's add-codex flow
  write the pin (or use 0.162.1). Same ownership note for `opencode-ai` (1.18.25 equals upstream's add-opencode pin, so equal either way).
- `@googleworkspace/cli` 0.22.5 is local-only and is currently the latest on npm. REAPPLY.
- `container/cli-tools.test.ts` requires exact semver + unique names + baseline tools; satisfied.

### I8. `container/CLAUDE.md` - REAPPLY (applies clean, three sections)
(1) "Reply style" bullet block after the concision paragraph, (2) "## Outbound copy" (run `humanize` skill on outbound text; requires container skill `humanize`),
(3) "## Messages from other agents" (explains `session="sess-..."` attribute; only true if A4 below is carried). Upstream did not touch this file.
`git diff 64706602 ed7eccd6 -- container/CLAUDE.md | git apply`.

### I9. Image build/landing order (operational, not a code change)
- Build locally with bare `./container/build.sh` (no `pull`): the published/hardened image does not contain mnemon, nlm, deepline, python3, the gws shim, codex or opencode.
  `.env` has no `NANOCLAW_HARDENED_IMAGE`/`NANOCLAW_AGENT_IMAGE_REF` keys (verified by name), so bare build = full local build.
- `bun.lock` changes, so the image label `dev.nanoclaw.agent-runner-lock-sha256` changes and `/app/node_modules` must be rebaked. `/app/src` is bind-mounted live from the
  checkout, so image rebuild must precede (or accompany) landing new agent-runner source, otherwise containers crash on a missing module with no logs.
- Then rebuild per-group derived images: `pnpm exec tsx scripts/rebuild-agent-image.ts --all-customized` (two exist today: `...:ag-1777506396678-rqprll`, `...:ag-1779772267399-meshbe`).

---

## Agent-runner (non-provider)

Unchanged locally (take upstream, nothing to reapply): `src/cli/ncl.ts`, `src/timezone.ts`, `src/memory/**`, `src/modules/index.ts`, hooks, `bunfig.toml`, `tsconfig.json`, `scripts/`.
Upstream-only changes you will inherit and must not clobber: Agent SDK `^0.3.296`, cron-parser removed, `browser-trust.ts`, `slash-command.generated.ts` (run `pnpm slash-command:generate`),
`readInbound()` rewrite of `mailbox/sqlite/{connection,operations,index}.ts` (a6964d07/0b2f1ff4), `getDeliveryStatus`, send_message/nudge rewrite in `poll-loop.ts` (15c6124f), SDK failure notice (ab2f787e).

### A1. `package.json` + `bun.lock` - REAPPLY the opencode SDK dep only
Take upstream's `package.json`/`bun.lock` (SDK `^0.3.296`, no `cron-parser`). Nothing in `container/agent-runner/src` imports cron-parser (grepped), so do NOT re-add it.
Add (only if the opencode provider survives; providers analyst decides): exact pin `"@opencode-ai/sdk": "1.18.25"` (no caret; equals upstream add-opencode pin).
bun.lock MUST be regenerated, not hand-patched: `cd container/agent-runner && bun add --exact @opencode-ai/sdk@1.18.25` (then `bun install --frozen-lockfile`).
Expected lock delta is exactly two lines: the workspace dependency `"@opencode-ai/sdk": "1.18.25",` and the package entry
`"@opencode-ai/sdk": ["@opencode-ai/sdk@1.18.25", "", { "dependencies": { "cross-spawn": "7.0.6" } }, "sha512-GwgwhW+vE8FWSDw730SjzqNhsWXB0uJjbFOiqFkmM+USFuG13HuTlGe6SR2ixt+WXxoD6FV1hILWqsXyqej9hQ=="]`
(cross-spawn 7.0.6 is already in upstream's lock). If the lock delta is larger, stop and look. Local devDeps unchanged.

### A2. `src/config.ts` - split verdict
- `providerChain` / `providerChainCooldownMinutes` (+ the two `runnerConfigFromRaw` lines): REAPPLY only if the provider-fallback chain is kept (consumer: `providers/build-provider.ts`, providers analyst). Applies clean.
- `transcriptRotateBytes` / `transcriptRotateAgeDays`: DROP. No reader anywhere in `container/` or `src/` (grepped); dead fields.

### A3. Thread-pinned destinations (container half) - REAPPLY
Intent: `agent_destinations.thread_id` pins a channel destination to a topic, so a scheduled-task agent's output lands in its own topic of an orchestrator room. Host half (migration, projection,
`ncl destinations add --thread`) belongs to the src analyst; upstream has NO equivalent. Container half, all verified to apply clean to upstream files:
1. `src/destinations.ts`: `DestinationEntry.threadId?` + `threadId: destination.type === 'channel' ? (destination.threadId ?? undefined) : undefined` (2 small hunks).
2. `src/mailbox/model.generated.ts`: DO NOT patch. It is generated: edit `src/mailbox/model.ts` (host analyst adds `threadId: string | null` to the channel `DestinationRecord`, optional-on-wire parse
   `record.threadId === undefined ? null : nullableText(record,'threadId')`, add `'threadId'` to the allowed-keys list) then `pnpm mailbox-model:generate` and `pnpm mailbox-model:check`.
3. `src/mailbox/sqlite/operations.ts`: `DestinationRow.thread_id?: string | null` and `threadId: row.type === 'channel' ? (row.thread_id ?? null) : null` in `destination()`.
4. `src/mailbox/sqlite/connection.ts`: ONLY the test schema in `initTestSessionDb()` - add `thread_id TEXT` to `destinations`. (The rest of that file was rewritten upstream; do not port anything else.)
5. `src/mailbox/sqlite/sqlite.test.ts`: expected destination gains `threadId: null`.
6. `src/mcp-tools/core.ts` (MANUAL, do not `git apply`, the local diff also carries dead code, see A7). In `resolveRouting()` channel branch:
   ```ts
   thread_id:
     dest.threadId ??
     resolveDestinationThread(dest.channelType!, dest.platformId!, getCurrentReplyRoute())?.threadId ??
     null,
   ```
   and extend the JSDoc: "A destination pinned to a thread (host `agent_destinations.thread_id`) always routes there." This one site covers `send_message` and `send_file`.
7. `src/poll-loop.ts` `sendToDestination()` (applies clean): `thread_id: dest.threadId ?? destRouting?.threadId ?? null,` with the comment "A destination pinned to a thread ... wins over the inbound-derived thread."
   Upstream poll-loop has 3 other `thread_id:` write sites (`routing.threadId` at ~178/193/818, error/notice paths); leave them.
8. Tests: from `src/mcp-tools/core.test.ts` keep ONLY the `ops-topic` seed row (`INSERT INTO destinations (..., thread_id) VALUES ('ops-topic', ..., 'telegram:-100:4')`) and the final
   `describe('send_message MCP tool - destination pinned to a thread')`; drop the rest (A7).
Docs: `docs/api-details.md` "Thread-pinned destinations" paragraph (clean) and the `025 destination-thread` row in `docs/db-central.md` (renumber, see Risks).

### A4. Agent-to-agent session attribution (`session="sess-..."`) - REAPPLY
Intent (2026-08-20 provenance incident): an agent group runs several sessions (main, per-task, thread); peers need to know WHICH session is speaking or cross-session contradictions read as forged.
Upstream already has `source_session_id` in `MessageInRow`/mailbox types but its host never writes it (only tests do), so the value comes from the src analyst's host-side stamping.
Container pieces (all clean): `formatter.ts` `originAttr()` adds `sessionAttr` (only when `channel_type === 'agent' && msg.source_session_id`) to both `from=` return paths; `formatter.test.ts`
"agent-to-agent source session attribution" describe (3 tests); `connection.ts` test schema `source_session_id TEXT` on `messages_in`; docs section = `container/CLAUDE.md` "Messages from other agents" (I8).
Note upstream's formatter also changed `sender` for `content.self` and added slash-command parsing; those do not conflict.

### A5. `msg_id` citation token in `<message>` - REAPPLY, low priority / optional
`formatSingleChat` adds `msg_id="msg-v1-<base64url sha256 of JSON([channel_type, platform_id, thread_id, id])>"` and falls back to `id="<raw id>"` when `seq` is null (needs `import { createHash } from 'node:crypto'`).
Applies clean, upstream tests do not assert exact `<message id=` strings. No consumer in the repo (only docs), and it costs about 55 chars per inbound message of prompt, which sits awkwardly with the
token-spend work. Recommend carrying it only if Brad wants stable cross-session citations; otherwise DROP and also skip the matching paragraphs in `docs/agent-runner-details.md` (first hunk) and `docs/architecture.md` (seq paragraph).

### A6. `alwaysLoad: true` on the built-in `nanoclaw` MCP server (`src/index.ts`) - REAPPLY, coupled to providers
Intent: with Claude Code tool search on (`ENABLE_TOOL_SEARCH`), send_message / ask_user_question / scheduling schemas must not be deferred or the agent cannot reply (token-spend plan Phase 1).
Hunk applies clean, BUT the property is typed in `providers/types.ts` (`McpServerConfig.alwaysLoad?`) and consumed in `providers/claude.ts` (`ENABLE_TOOL_SEARCH`). Upstream has none of the three.
Ship all three together (providers analyst owns the other two) or `tsc` fails on the extra property.

### A7. Claimed-batch routing + per-turn dedup - OBSOLETE / DROP (dead code; do not port)
Files/hunks: `src/destination-routing.ts`, `src/turn-dedup.ts` (git sees it as binary: it has a NUL separator), `src/db/session-state.ts` batch-routing additions
(`buildBatchRoutingMap`, `setCurrentBatchRouting`, `clearCurrentBatchRouting`, `getCurrentBatchRouting`), `core.ts` `resolveDestinationCorrelation`/`recordTurnSend` calls, the batch-routing tests in
`core.test.ts` and `poll-loop.midturn.test.ts` (+142 lines), the "While a provider query is active ..." paragraph in `docs/agent-runner-details.md`.
Why dead on `KEEP`: nothing ever calls `setCurrentBatchRouting`/`buildBatchRoutingMap`/`clearCurrentBatchRouting` outside tests, and `wasSentThisTurn` is never consulted (poll-loop lost that wiring in a
merge); with no batch state the code falls back to "latest inbound thread", which is exactly what upstream's `resolveDestinationThread(...)` already does. Upstream 15c6124f (never lose or repeat a reply around send_message,
via `chatRowsInWindow`) is the replacement for the dedup intent. HAZARD if copied: `destination-routing.ts` calls `getInboundDb()`, which upstream (0b2f1ff4) made test-only and throws outside test mode, so `send_message`
would break in production. The tests `clears the claimed-batch routing state...` and friends already cannot pass on `KEEP` (processQuery no longer clears it).

### A8. Slack MCP tools: `canvas.ts`, `rooms.ts` (+ `*.instructions.md`, `*.test.ts`) and `create-agent-slack.instructions.md` - REAPPLY (Slack analyst owns the host half)
Wholly ours, copy as-is: `src/mcp-tools/{canvas,rooms}.ts`, `canvas.instructions.md`, `rooms.instructions.md`, `create-agent-slack.instructions.md`, `canvas.test.ts`, `rooms.test.ts`.
Add to the barrel `src/mcp-tools/index.ts` after `./self-mod.js` (clean hunk): `import './canvas.js';` `import './rooms.js';`. Dependencies verified present upstream: `extendTool`, `registerTools`, `findCliResponse`, `markCompleted`.
`rooms.ts` extends `create_agent` via `extendTool`; upstream `agents.ts` gained a `template` param (merge-compatible, but run `server.extend.test.ts`). Host system actions `canvas_edit`, `canvas_read`, `create_room`, `add_to_room` live in src.
Pair with container skill `canvas-work`.

### A9. `query-agy.*` / `query-opencode.*` MCP tools - providers analyst decides; NOT WIRED on KEEP
Files exist (`.ts`, `.instructions.md`, `.test.ts`) but `mcp-tools/index.ts` on `KEEP` never imports them (verified, and `git log -S` finds no commit that did), so the tools never register. `registration.test.ts` (new, +22) asserts both imports and therefore
FAILS on `KEEP`. Either wire both (`import './query-agy.js'; import './query-opencode.js';`) or drop the files and trim the list in `registration.test.ts` to `['core','interactive','agents','self-mod']` (+`canvas`,`rooms` if you like).

### A10. `provider-contracts/{codex,opencode,index}.ts` - providers analyst (not mine). `index.ts` just adds two imports next to `./claude.js`.

---

## Container skills

All wholly ours; upstream's `container/skills/` is untouched (only agent-browser, frontend-engineer, self-customize, welcome). Verdict REAPPLY = copy dir as-is:
`git checkout ed7eccd6 -- container/skills/<name>`.

| Skill dir | Verdict | Notes |
|---|---|---|
| `canvas-work` | REAPPLY | Slack canvases; only useful with A8 + Slack. |
| `conversion-cro`, `marketing-copywriting`, `marketing-strategy-analytics`, `seo-growth`, `nextjs-react-engineering` | REAPPLY | Pure SKILL.md, no deps. |
| `draft-invoice` | REAPPLY | Uses SolidTime, Drive template, Obsidian frontmatter, Gmail; needs the gws mount + obsidian mount (host config). |
| `folder-audit` | REAPPLY | `allowed-tools` frontmatter; a host launchd job `com.bradhess.folder-audit` also exists (not in git). |
| `google-workspace` (`SKILL.md` + `gws-account`) | REAPPLY | Keep `gws-account` 100755. Requires I6 + `@googleworkspace/cli` (I7) + RO mount `/workspace/extra/gws-config`. |
| `humanize` (`SKILL.md`, `NOTES.md`, `references/{examples,patterns}.md`) | REAPPLY | `container/CLAUDE.md` "Outbound copy" (I8) mandates it. |
| `linear-pm` | REAPPLY | Hourly scheduled-task poller for `agent:zed` issues; needs Linear access. |
| `linkedin-community` | REAPPLY (orphan) | Only `selectors.md` is in git; the real `SKILL.md` + scripts live in gitignored `groups/dm-with-brad/skills/linkedin-community/` (group data). Copy the file as-is; do not expect a loadable skill from this dir alone. |
| `mnemon` | REAPPLY | Container-edition guide (ID rules for `link`/`forget`); matches I2 shim + `src/mnemon-sync.ts`. Latest edit eca39d3e. |
| `notebooklm` | REAPPLY | Needs I3 and per-group mount `~/.notebooklm-mcp-cli` -> `/workspace/extra/notebooklm`. |
| `onecli-gateway` (`SKILL.md`, `instructions.md`) | ALREADY-UPSTREAM | Byte-identical to `.claude/skills/add-onecli/payload/container/skills/onecli-gateway/` on `KEEP`; the gateway install materializes it (commit 22415d21 "materialize selected gateway"). Do NOT copy; re-run the add-onecli/gateway materialization from upstream's payload (payload changed 4+ files upstream). |
| `welcome` (`addenda/slack.md`, `addenda/teams-tour.md`) | REAPPLY (Slack analyst) | Only the two addenda are ours; `welcome/SKILL.md` is upstream and already reads `addenda/<channel>.md`. |
| `wiki` (`SKILL.md`, `scripts/wiki-lint.mjs`, `scripts/wiki-maintenance.mjs`) | REAPPLY | Obsidian `50-Wiki/`+`50-Sources/` maintainer; needs obsidian mount (RO vault + RW sub-dirs per memory). |
| `slack-*`, `agy-research` | not mine | Slack / providers analysts. |

---

## Scripts & setup

### S1. `scripts/rebuild-agent-image.ts` - REAPPLY (copy as-is, 158 lines)
Manual reconciler for per-agent derived images when the base gains a dep (no automatic drift detection exists). Uses `buildAgentGroupImage`, `configFromDb`, `getSessionDriver().listSessions(INSTALL_SLUG)`,
`getAllContainerConfigs`, `updateContainerConfigScalars`; all still exported upstream (verified by grep). Needed immediately after the rebuild (I9). Run `pnpm exec tsc` / typecheck:tools after copying in case a signature drifted.
The `@opencode-ai/sdk present` probe is cosmetic (providers analyst may drop it).

### S2. `scripts/smoke-mounts.ts` - REAPPLY (copy as-is, 144 lines)
Resolves each group's `additional_mounts` through the real `validateAdditionalMounts` and (with `--probe`) runs the group's image with real `-v` args to attempt writes. Uses `mountArgs` from `src/drivers/docker-driver.ts`,
`src/modules/mount-security`; both exist upstream. Valuable given the many RO/RW mount hardenings in memory.

### S3. `scripts/q.ts` - REAPPLY (clean, 5-line hunk)
Open any `outbound.db` with `{ readonly: true, fileMustExist: true }`. Tool-side twin of the host fix "never read-write `outbound.db`" (docs/db.md bullet; host half in `src/mailbox`, src analyst). Upstream has no equivalent.

### S4. `scripts/update/service.ts` - split
- Legacy unsuffixed launchd plist detection in `detectService` - REAPPLY, CRITICAL for this install. The live service is `~/Library/LaunchAgents/com.nanoclaw.plist` (ProgramArguments `~/.local/bin/node dist/index.js`, WorkingDirectory = repo root);
  upstream only recognizes `com.nanoclaw-v2-<slug>`, so `/update-nanoclaw` would classify the host as "unmanaged" and refuse. Hunk does not apply (upstream switched to `probe()`); port by hand inside the `darwin` branch after the suffixed-plist `if`:
  ```ts
  const legacyName = 'com.nanoclaw';
  const legacyDefinition = path.join(env.home, 'Library', 'LaunchAgents', `${legacyName}.plist`);
  if (fs.existsSync(legacyDefinition)) {
    const wd = env.runner.tryRun('/usr/libexec/PlistBuddy', ['-c', 'Print :WorkingDirectory', legacyDefinition]);
    const prog = env.runner.tryRun('/usr/libexec/PlistBuddy', ['-c', 'Print :ProgramArguments:1', legacyDefinition]);
    if (wd.ok && prog.ok && wd.stdout.trim() === projectRoot && prog.stdout.trim() === path.join(projectRoot, 'dist', 'index.js')) {
      return { mode: 'launchd', name: legacyName, definition: legacyDefinition,
        active: probe(env, 'launchctl', ['print', `gui/${env.uid}/${legacyName}`], [113], 'Run the update from a login session of this user.') !== undefined };
    }
  }
  ```
  (Original used `env.runner.tryRun(...).ok` for `active`; `probe` matches upstream's style. `CommandRunner.tryRun` still exists upstream.)
  Port the matching test `recognizes a legacy unsuffixed launchd plist for this checkout` into `scripts/update/service.test.ts` (its `env.runner` stub needs the `probe`-compatible `run()` for the `launchctl print` call).
- `stopService` wait-for-process-exit and "already unloaded is success" - ALREADY-UPSTREAM (upstream's rewritten stopService polls launchctl + collected PIDs for up to 30s and swallows "No such process"). Drop local `waitForProcessExit`, its two tests, and the `maxBuffer` constant shuffle.

### S5. `scripts/update-skills.ts` (+ test) - OBSOLETE
Local `isChannelAdapterImport()` stopped `slack-a2a-guard` from being mistaken for a missing `add-slack-a2a-guard` skill. Upstream's `importOwners()` (reads each skill's `append to:<barrel>` directives) solves the same thing generally. Drop both local hunks.
Only residue: local also did `providers.delete('mock')`; needed ONLY if the providers barrel keeps `import './mock.js'` (it does on `KEEP`, upstream's barrel is just `./claude.js`). Providers analyst to decide; one-line add after `providers.delete('claude')`.

### S6. `scripts/recover-migration-clobbered-configs.py` - DROP
One-time recovery for the 2026-07-17 config-to-DB migration loss; hardcodes group ids and image tags (`ag-1777521678769-obgxhn`, `nanoclaw-agent:ag-...`). Not reusable. Leave it in the backup tag for forensics.

### S7. Tool-code type hygiene (the `typecheck:tools` effort of 2026-10-05) - REAPPLY only as a set, optional
`tsconfig.tools.json` (new, includes `setup/**` and `scripts/**`; excludes need trimming to scripts that survive, e.g. drop `scripts/opencode-auth-config.test.ts` if opencode is dropped) + root `package.json` script `"typecheck:tools": "tsc -p tsconfig.tools.json"` +
CI steps (T2). The code changes behind it are pure typing: `s.stop(msg, 1)` -> `s.error(msg)` (clack 1.2.0, same version everywhere), `validate:` callbacks accept `undefined`, `export interface WireArgs`, `@ts-ignore` on the lazy dial-pairing import,
JSDoc typedefs in `setup/lib/host-status.mjs`, `Directive` typing in `scripts/test-registry-skills.ts`, etc. Dry-run against upstream: clean for all except `setup/auto.ts` and `setup/channels/run-channel-skill.test.ts` (upstream edited both).
Recommended order: add the config, run `pnpm typecheck:tools`, fix what actually fails (mechanical: `git diff 64706602 ed7eccd6 -- setup scripts/photon-setup.ts | git apply --3way --include=<file>`). Files touched: setup/{auto.ts, auto.auth.test.ts, auto.image-source.test.ts, container.ts, pair-dial.ts, portal.ts},
setup/channels/{run-channel-skill.ts, run-channel-skill.test.ts, slack-auto.ts, slack-auto.test.ts, wizard-hooks.test.ts}, setup/gateways/{install,selection}.test.ts, setup/lib/{claude-handoff.ts, host-status.mjs, runner.ts, skill-driver.ts, tz-from-claude.ts}, scripts/{photon-setup.ts, test-registry-skills.ts}.
If the fork stops running `typecheck:tools` in CI, DROP all of it.
One exception that is a real bug fix, not typing: `setup/container.ts` `const reconciled = await reconcileDerivedImages();` (the function is `async`; upstream omits the `await`, so `reconciled.cleared.length` throws inside the try on the hardened-pull path). REAPPLY (clean one-liner) regardless; not on our path but correct.

### S8. `setup/register.ts` requiresTrigger shim - DROP (low risk)
v1-migration compat: with `requiresTrigger` always false (no flag ever sets it true), `--trigger X` produced pattern `(X|.*)` i.e. match everything. Upstream behaviour (`--trigger X` = pattern X; defaults from channel declarations) is saner and only affects ad-hoc
`setup --step register` runs. Apply only if a script of Brad's relies on `--trigger` meaning "respond to all".

### S9. `setup/index.ts` / `setup/whatsapp-auth.ts` / WhatsApp tests - OBSOLETE (nothing to reapply)
Local removed the WhatsApp channel (48edb066: Baileys adapter, `setup/whatsapp-auth.ts`, `setup/groups.ts`, STEPS entries, `setup/channels/whatsapp*.test.ts`, `container/skills/whatsapp-formatting`). On a fresh origin/main trunk ships no adapter; the only residue is trunk's
`setup/whatsapp-auth.ts` (statically imports `pino`, dynamic `qrcode`) and its `STEPS` entry. Optional subtraction: `git rm setup/whatsapp-auth.ts setup/whatsapp-auth-version*.ts setup/channels/whatsapp*.test.ts` and drop the two `STEPS` lines (`groups`, `whatsapp-auth`;
upstream's `groups` entry already points at a file that no longer exists). Keep the subtraction out of the critical path.

### S10. Not mine (listed so nothing falls through): `scripts/{opencode-*,reviewer-smoke*,fixtures/reviewer-*,tsconfig.opencode-auth.json}`, `scripts/{open-a2a-room.ts,slack-agent-flow-finish.ts,telegram-repoint-room.ts,wire-dedicated-room.sh,wire-rooms-batch.sh}`, `setup/channels/slack-auto*`, `setup/providers/**`.

---

## Top-level config / docs

### T1. `.gitignore` - REAPPLY (clean; merge, keep both sides)
Local appends: `.claude/worktrees/`, `.claude/scheduled_tasks.lock`, `nanoclaw-v2/`, `falcone-spawn.mjs`, `.upgrade-worktree/`, `.retired/`, `.agents.backup/`, `AGENTS.md.backup`, `scripts/spike/`, `scripts/ops/` (operator scripts with hardcoded local OneCLI ids).
Upstream added a `!/.claude/skills/*/payload/**/AGENTS.md` exception and `/templates/*` rules. Keep both blocks (the local additions are all new paths, so order does not matter).
Also `git rm --cached .claude/scheduled_tasks.lock` (tracked upstream, deleted locally).

### T2. `.github/workflows/ci.yml` - REAPPLY, optional (applies clean)
Upstream split CI into `checks`/`test`/`container-test`/`iron-front`/`skill-pins`/`ci`/`gate`. Local adds two steps to the `checks` job after "Typecheck host": `Typecheck tools (setup and scripts)` -> `pnpm run typecheck:tools`, and `Lint` -> `pnpm run lint`
(upstream's `checks` has format:check but never runs eslint; `lint` script exists as `eslint src/`). Skip both if S7 is skipped. Local also needs root `package.json` `typecheck:tools`.

### T3. `tsconfig.tools.json` - see S7. `tsconfig.json`: no local change (upstream added `incremental` + `tsBuildInfoFile`; take upstream). `vitest.config.ts`, `eslint.config.js`: no local change.

### T4. `pnpm-workspace.yaml` - split
Comment rewording: DROP. `patchedDependencies: '@chat-adapter/telegram@4.29.0': patches/@chat-adapter__telegram@4.29.0.patch` (backport of the >= 4.41 MarkdownV2 trim fix): likely OBSOLETE because upstream bumped `chat` to 4.41.1;
the telegram analyst must confirm which adapter version the channels branch installs and drop patch + `patches/` file if >= 4.41. The yaml hunk itself applies clean.

### T5. Root `package.json` / `pnpm-lock.yaml` (not mine, flagged): local-only deps `@chat-adapter/slack 4.29.0`, `@chat-adapter/telegram 4.29.0`, `@nanoco/nanoclaw-dashboard link:/Users/bradhess/Documents/GitHub/nanoclaw-dashboard`, `@onecli-sh/sdk 2.2.1`, `@types/qrcode 1.5.6`, `pino 9.6.0`, `qrcode 1.5.4`.
Upstream moved `chat` 4.29.0 -> 4.41.1, tsx, vitest/vite; take upstream and re-add only deps that surviving skills need. Never regenerate `pnpm-lock.yaml` by hand; `pnpm install --frozen-lockfile` after `pnpm install` once, keeping `minimumReleaseAge: 4320`.

### T6. Docs - REAPPLY per surviving feature (all hunks apply clean to upstream copies except `build-and-runtime.md`)
| File | Hunk | Keep? |
|---|---|---|
| `docs/build-and-runtime.md` | "Pinned ARGs" line + `nlm` bullet | REAPPLY by hand (conflicts): upstream line is `BUN_VERSION, PNPM_VERSION, INSTALL_CJK_FONTS` plus a "Pinned base" bullet; add `MNEMON_VERSION`, `NOTEBOOKLM_CLI_VERSION`, `DEEPLINE_VERSION`; do NOT re-add `NPM_VERSION` (removed upstream). |
| `docs/api-details.md` | Thread-scoped wirings + thread-pinned destinations | REAPPLY (src features). |
| `docs/db-central.md` | agent_groups `tier/reports_to/role/persona` (v26) + migration rows 23-26 | REAPPLY, but fix the table: upstream's 024-host-coordination and 025-container-config-speed (both already at BASE) are missing from the local rows and share `version:` 24/25 with local `024-wiring-thread-filter` / `025-destination-thread` (see Risks 4). |
| `docs/db.md` | "Host reads outbound.db truly read-only" bullet | REAPPLY (matches S3 + host fix). |
| `docs/architecture.md` | seq/msg_id paragraph; idle-window table (per-kind idle 10 min chat / 2 min task) | seq paragraph only if A5; idle table REAPPLY with host-sweep change (src analyst). |
| `docs/agent-runner-details.md` | msg_id paragraph (A5) / batch-routing paragraph (A7) | first only if A5; second DROP. |
| `README.md`, `docs/ccusage.md`, `docs/hud-implementation.md`, `bin/ccusage` | ccusage/HUD | not mine (excluded). |
| `docs/onecli-upgrades.md` | ALREADY-UPSTREAM | local copy is the materialized add-onecli payload (identical on `KEEP`); upstream's payload doc is 232 lines vs 114 and already carries the "never downgrade / 1.43.1 floor" rules. Regenerate via the add-onecli flow. |
| root `CLAUDE.md` | unchanged both sides | nothing. |

### T7. `.claude/skills/*` adjacent edits (boundary notes, not my area)
- `add-mnemon/{SKILL.md,REMOVE.md,mnemon-dockerfile.test.ts,mnemon-entrypoint.test.ts}`: upstream untouched -> `git checkout ed7eccd6 --` (they document I2 and invert the entrypoint test). Host copies at `src/mnemon-*.test.ts`, `src/mnemon-sync.ts` belong to the src analyst.
- `add-rtk/{SKILL.md,REMOVE.md}`: upstream untouched -> copy as-is (Linux rtk binary mounted at `/workspace/extra/rtk`, relative `--container rtk`).
- `add-onecli/**`: BOTH sides changed heavily (upstream +3.2k lines). Do not copy local; gateway analyst re-derives (`gateway-version.ts`, `versions.json` pin 1.41.0 < live 1.45.0 on purpose per memory; never below 1.43.1).
- `add-agy`, `add-dashboard/**` (HUD): providers / HUD owners.

---

## Drops

- `docs/superpowers/**` (8 files, DROP): `2026-07-17-provider-fallback-rollout-findings.md`, `2026-08-01-reviewer-1-reliability-findings.md`, `plans/2026-07-17-provider-fallback-chain.md`, `plans/2026-08-01-codex-adversarial-review.md`,
  `specs/2026-07-16-notebooklm-skill-design.md`, `specs/2026-07-17-provider-fallback-chain-design.md`, `specs/2026-07-30-codex-adversarial-review-design.md`, `specs/2026-09-08-performance-and-token-spend-scope.md`.
  Tag `KEEP` (e.g. `git tag pre-rebuild-20261103 ed7eccd6`) so they stay retrievable with `git show <tag>:docs/superpowers/...`.
- `container/agent-runner/src/{destination-routing.ts,turn-dedup.ts}`, session-state batch-routing block, core.ts correlation/dedup calls, matching tests and doc paragraph (A7).
- `config.ts` `transcriptRotateBytes`/`transcriptRotateAgeDays` (A2).
- `scripts/recover-migration-clobbered-configs.py` (S6); local `scripts/update-skills.ts` hunks (S5); `waitForProcessExit` etc. in `scripts/update/service.ts` (S4).
- `setup/register.ts` requiresTrigger shim (S8); WhatsApp subtraction is optional (S9); CI/`typecheck:tools` hygiene is optional (S7/T2).
- pnpm-workspace comment rewording; telegram `patchedDependencies` once the adapter is >= 4.41 (T4).
- `groups/` is gitignored data (25 group dirs incl. `dm-with-brad`, `falcone`, `cache-am`, per-group `skills/` and `.claude/skills/`): NOT migrated by this rebuild; it must simply stay in the working tree. Same for `data/`, `.env`, `logs/`, `store/`, `hermes/`, `scripts/ops/`, `.retired/`, `container/AGENTS.md` (generated), `dist/`.

---

## Risks

1. **Image/source skew crashes live containers.** `/app/src` is bind-mounted from the checkout while `/app/node_modules` is baked. New `bun.lock` (SDK 0.3.296, `@opencode-ai/sdk`) means a new lock label and rebaked modules; land source + rebuilt image together, then rebuild derived per-group images (S1). Containers failing with a missing module leave no log (`--rm`).
2. **Never use the hardened/published image path for this install.** `build.sh pull`, `NANOCLAW_AGENT_IMAGE_REF`, or `setup --step container` with a registry image would drop mnemon, nlm, deepline, python3, gws shim, codex, opencode, and `reconcileDerivedImages()` would clear per-group derived images (and loses their extra packages). `.env` currently has no such keys; keep it that way.
3. **Dead-code hazard.** Porting `destination-routing.ts` / the whole local `core.ts` diff breaks `send_message` in prod (`getInboundDb()` is test-only upstream). Use the manual core.ts snippet in A3.6.
4. **Cross-area couplings that must land together:** A3 (container) <-> host migration `025-destination-thread` + projection + `model.ts` regen; A4 <-> host stamping `source_session_id`; A6 <-> `providers/types.ts` + `claude.ts`; A8 <-> Slack host actions; A9 <-> providers. Migration numbering: upstream added NO migrations since BASE, but BASE already holds 024-host-coordination (version 24) and 025-container-config-speed (version 25), the same `version:` numbers as local `024-wiring-thread-filter` / `025-destination-thread` (local also has 026-agent-group-architecture). Applied-state is keyed on migration `name` (version is auto-assigned in `schema_version`), so there is no functional clash today, but the src analyst should give the three local migrations unique versions (27-29, leaving 26 for the next upstream migration) before upstream's next release uses 26.
5. **Launchd detection.** The live job is the unsuffixed `com.nanoclaw` pinned to `~/.local/bin/node` (Node 22). Without S4 the update tooling treats the host as unmanaged. Do not run `setup --step service`: it would write `com.nanoclaw-v2-<slug>` and discard the pinned plist.
6. **Version table (none of ours is newer than upstream):** Bun 1.4.0 -> 1.4.4 (upstream); node base floating 22.23.3 -> 22.23.4 digest (upstream); claude-code 2.1.280 -> 2.1.296; Agent SDK ^0.3.280 -> ^0.3.296; codex 0.155.1 vs upstream add-codex 0.162.1 (upstream newer); `chat` 4.29.0 vs 4.41.1 (upstream newer); local-only pins to carry unchanged: mnemon 0.1.14 (host 0.2.8, latest 0.2.13), notebooklm-mcp-cli 0.8.7, deepline 0.3.0 (stale vs 0.3.4xx), `@googleworkspace/cli` 0.22.5 (latest), `opencode-ai`/`@opencode-ai/sdk` 1.18.25 (equal to upstream add-opencode).
7. **New base digest unknown OS/python.** Live image is Debian 12 / python 3.11.2; verify `uv tool install notebooklm-mcp-cli==0.8.7` and the apt list (`python3`, upstream's `libnss3-tools`) build on `node:22.23.4-slim@sha256:de170b39...`. Run `./container/build.sh` once before touching any running container.
8. **Generated files.** `model.generated.ts` (from `src/mailbox/model.ts`) and `slash-command.generated.ts` (from `src/slash-command.ts`) must be regenerated, not merged; run `pnpm mailbox-model:check` and `pnpm slash-command:check`.
9. **Tests that will fail on KEEP-derived content:** `registration.test.ts` (A9), batch-routing tests (A7), anything under `.claude/skills/add-mnemon` if the Dockerfile block drifts. Re-run `cd container/agent-runner && bun test --isolate`, `pnpm exec vitest run container/`, `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` after the port (I did not run builds or tests, per the read-only rule).
10. **Landing stamp.** After the rebuild lands, the upgrade-state stamp (`scripts/upgrade-state.ts set`, classifier-blocked for Claude) must be given to Brad or the host crash-loops (memory 10/9). Re-check live HEAD right before the fast-forward.
11. **Orphan/partial artifacts:** `linkedin-community` is a lone `selectors.md`; `container/skills/onecli-gateway` is derived state; `container/AGENTS.md` and `scripts/ops/` are ignored local state.

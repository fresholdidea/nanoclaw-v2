# 30 - Host core (`src/` minus channels / providers / provider-contracts / gateway-providers / provisioning / slack-* / canvas-actions)

Scope: router, delivery, sweep, session-manager, container-runner, container-config, mailbox, db + migrations, cli, a2a, scheduling, self-mod, hud, dashboard pusher, ccusage, mnemon-sync, env, index, package files, skills `add-dashboard` / `add-mnemon` / `add-rtk`.

BASE = `64706602` (2026-10-01). origin/main at analysis time = `f7440e85`. Only `git diff 64706602 main` counts as customization. `main` itself is the live install, so tag it before the rebuild (`git tag pre-rebuild-20261103 main`) and never edit it.

## 0. Verified artifacts (read this first)

All of this was produced in scratch clones of the repo (live tree untouched; only read-only `sqlite3 -readonly` / `.backup` on `data/v2.db`).

| Artifact | What it is |
|---|---|
| `<SP>/candidate-vs-upstream.patch` | 130-file plain diff against origin/main `f7440e85` containing every REAPPLY item below with the adaptations described. `git apply` it on a clean checkout of `origin/main`. |
| `<SP>/probe/` | git clone, branch `rebuild`, the same change staged. `node_modules` is a symlink to the live repo's (do not stage it: `repo-hygiene.test.ts` fails if it is tracked). |
| `<SP>/pathspec.sh` -> `<SP>/final.patch` | The mechanical path set (`git diff 64706602 main -- <paths>`). `git apply --3way` of it onto origin/main produces exactly 8 conflicted files (section 3.0). |

`SP=/private/tmp/claude-501/-Users-bradhess-Documents-GitHub-nanoclaw-v2/ce1a8617-b5a8-46c0-a227-8feed37951d2/scratchpad`

Verification of the candidate: `tsc --noEmit` clean; `vitest run src` = 2370 pass / 9 fail. All 9 failures need container-tree files owned by section 40: `src/mnemon-dockerfile.test.ts` (5), `src/mnemon-queue.test.ts` (2), `src/project-doc-compose.test.ts` (2, need `canvas`/`rooms`/`create-agent-slack`/`query-agy`/`query-opencode` `.instructions.md`). Candidate also contains 2 one-line files that live outside `src/` host core because they are inseparable from host changes: `src/channels/channel-defaults.ts` (+1 line) and `container/agent-runner/src/mailbox/model.generated.ts` (regenerated copy).

The candidate deliberately does NOT contain: package-lock regeneration, `pnpm-workspace.yaml` edits, anything else under channels/providers/gateway/slack/canvas, `src/env-file.ts` (canvas-actions dependency), `src/modules/index.ts` slack lines.

## DB migrations

**Verdict: clean. Upstream added zero migrations since BASE (`git diff --stat 64706602 origin/main -- src/db/migrations` is empty; its 23 registered names are exactly the 23 non-local names in the live DB). Local adds exactly 5. Copy the 5 files verbatim, add their imports/array entries to `src/db/migrations/index.ts`, change nothing else.**

Identity is the migration `name` (unique index `idx_schema_version_name`, pending = names not in `schema_version`); `version:` in the file is only an ordering hint and `schema_version.version` is `MAX+1` at apply time (`applyMigration`, `src/db/migrations/index.ts`). So duplicate `version:` numbers are harmless (already duplicated in main: two 20s, 21s, 24s, 25s).

| File (copy from main) | `name` (permanent) | `version:` in file | Live `schema_version` id / applied | SQL | Used in live data |
|---|---|---|---|---|---|
| `020-provider-tooling.ts` | `provider-tooling` | 20 | 18 / 2026-07-16 | `container_configs` +`enable_agy_tooling INTEGER NOT NULL DEFAULT 0`, +`enable_opencode_tooling INTEGER NOT NULL DEFAULT 0` | `enable_agy_tooling=1` on 1 group |
| `021-provider-chain.ts` | `provider-chain` | 21 | 19 / 2026-07-17 | `container_configs` +`provider_chain TEXT` | 3 rows |
| `024-wiring-thread-filter.ts` | `wiring-thread-filter` | 24 | 24 / 2026-09-10 | `messaging_group_agents` +`thread_filter TEXT` | 10 wirings |
| `025-destination-thread.ts` | `destination-thread` | 25 | 25 / 2026-09-10 | `agent_destinations` +`thread_id TEXT` | 11 destinations |
| `026-agent-group-architecture.ts` | `agent-group-architecture` | 26 | 28 / 2026-10-02 | `agent_groups` +`tier`, `reports_to`, `role`, `persona` (all TEXT, nullable) | 22 of 23 groups |

Collisions with upstream: none by name. By number: upstream BASE already owns `020-container-config-timezone`(20), `021-approval-question`(21), `024-host-coordination`(24), `025-container-config-speed`(25), so local 020/021/024/025 share `version:` with them (file names differ, so no path clash). A future upstream `026-*` file would not clash with `026-agent-group-architecture.ts` either unless it reuses the same name. Optional hygiene (zero functional effect, safe because `version` is not identity): bump the five local `version:` values to 27-31. Do NOT rename a migration `name`, ever: a new name re-runs `ALTER TABLE ... ADD COLUMN` on the live DB and fails with "duplicate column name" at `initDb` (host crash-loop).

Wiring in `src/db/migrations/index.ts` (candidate uses the interleaved order, which is what main has and which passes `portability.test.ts`, `registry.test.ts`, `concurrency.test.ts`; appending all five after `migration025` also works since order is irrelevant for the live DB and for fresh DBs the five ALTERs are independent of one another):

```ts
import { migration020 as migration020ProviderTooling } from './020-provider-tooling.js';
import { migration021 as migration021ProviderChain } from './021-provider-chain.js';
import { migration024 as migration024WiringThreadFilter } from './024-wiring-thread-filter.js';
import { migration025 as migration025DestinationThread } from './025-destination-thread.js';
import { migration026 } from './026-agent-group-architecture.js';
// array (after migration019): ...migration019, migration020ProviderTooling, migration020, migration021ProviderChain, migration021,
//   migration022, migration023, migration024WiringThreadFilter, migration025DestinationThread, migration024, migration025, migration026
```
(20-providers.md suggests appending at the end instead and making `ContainerConfigRow`'s new fields optional; either is fine. Pick one and keep it consistent between sections.)

Code that must ship with the migrations (otherwise tsc/tests break): `src/types.ts` (ContainerConfigRow fields, AgentGroup/AgentTier/AgentPersona, MessagingGroupAgent.thread_filter, AgentDestination.thread_id), `src/backfill-container-configs.ts` (3 default fields), `src/db/container-configs.ts`, `src/db/agent-groups.ts`, `src/db/messaging-groups.ts`, `src/db/schema.ts` (reference doc only), `src/mailbox/{model,sqlite/schema,sqlite/session-db,sqlite/index}.ts` (destination thread). Details per feature in section 1.

Proof run (done): `sqlite3 -readonly data/v2.db ".backup <SP>/v2-copy.db"`, then in the candidate `initDb(copy,{role:'tool'}); runMigrations(db, undefined, {mode:'validate'})` -> 28 registered, zero pending. Repeat this against a fresh `.backup` right before landing (see Risks 1). Docs worth syncing: `docs/db-central.md` rows 23-26 + agent_groups columns (note: its local table omits upstream's `024-host-coordination` / `025-container-config-speed`; fix when copying).

## Customizations

Legend: REAPPLY = in `candidate-vs-upstream.patch`; "conflict" = needed manual resolution (listed in 3.0).

### 1.1 Thread-scoped wirings (`messaging_group_agents.thread_filter`, migration 024) - commit 29a2560ef
**Intent.** One Telegram supergroup (Daily Ops) fans out by topic: a wiring with `thread_filter` engages only in its topic(s) and, while it matches, unscoped wirings (the orchestrator catch-all) stand down.
**Files.** `db/migrations/024-wiring-thread-filter.ts`; `types.ts` (`MessagingGroupAgent.thread_filter`); `db/messaging-groups.ts` (+4: persist in `createMessagingGroupAgent`, +1 in `updateMessagingGroupAgent` Pick); `cli/resources/wirings.ts` (+49: `normalizeThreadFilter`, `requireThreadsForFilter`, field def, `preUpdate`, `create`; the `{ cause: err }` bit is b5cdf905a); `router.ts` (candidates map, `scopedClaim`, `fanout`, exported `threadFilterList`); **`channels/channel-defaults.ts` +1 line `thread_filter?: unknown;` in `EngageValues` (outside this section; tsc fails without it; also listed in 10-channels.md item 8)**; tests `router-thread-filter.test.ts`, `cli/resources/wirings.test.ts`.
**Upstream overlap.** None for the feature. `router.ts` upstream changed only the command-gate deny block (see 1.5); the thread-filter hunks apply cleanly.
**Verdict.** REAPPLY. Live: 10 wirings depend on it.
**How to apply.** In the candidate. By hand: copy migration, add the fields/types, wirings.ts hunks, and in `router.ts` replace the `for (const agent of agents)` prologue with the `candidates` / `inFilter` / `scopedClaim` / `fanout` block shown in `git diff 64706602 main -- src/router.ts` (first two hunks only).

### 1.2 Thread-pinned destinations (`agent_destinations.thread_id`, migration 025) - commit 36abb253f
**Intent.** A scheduled-task agent living in one topic of the orchestrator room posts proactive output into that topic.
**Files (host).** migration 025; `types.ts` (`AgentDestination.thread_id`); `modules/agent-to-agent/db/agent-destinations.ts` (`createDestination` inserts `thread_id`); `modules/agent-to-agent/write-destinations.ts` (`threadId: row.thread_id ?? null`); `mailbox/model.ts` (`DestinationRecord` channel variant `threadId`, optional-on-wire in `parseDestinationRecord`); `mailbox/sqlite/schema.ts` (`destinations.thread_id`); `mailbox/sqlite/session-db.ts` (`DestinationRow.thread_id`, lazy `migrateDestinationsTable` for old `inbound.db` files, `replaceDestinations` writes it); `mailbox/sqlite/index.ts` (inbound record map `thread_id`); `cli/resources/destinations.ts` (`thread_id` field, `--thread <topic|full-id>` on `add`, upsert `ON CONFLICT`, list column).
**Mandatory follow-up.** `pnpm run mailbox-model:generate` (copies `src/mailbox/model.ts` to `container/agent-runner/src/mailbox/model.generated.ts`; `src/mailbox/model.test.ts` and CI `mailbox-model:check` fail otherwise). Container half belongs to section 40 (`container/agent-runner/src/destinations.ts` `threadId`, `mailbox/sqlite/operations.ts` `destination()` + test schema in `connection.ts`, `mcp-tools/core.ts` honoring the pin); upstream rewrote `operations.ts`/`destinations.ts` (0b2f1ff4, 15c6124f), so expect conflicts there.
**Upstream overlap.** None host-side. **Verdict.** REAPPLY. Live: 11 destinations.

### 1.3 Agent-group architecture metadata (migration 026) - commit d8597f29f
**Intent.** Org-chart columns (`tier`, `reports_to`, `role`, `persona`) for `ncl groups` and the dashboard Fleet page.
**Files.** migration 026; `types.ts` (`AGENT_TIERS`, `AgentTier`, `AgentPersona`, `AgentGroup` fields); `db/agent-groups.ts` (+150: `createAgentGroup` INSERT, `parseAgentPersona`, `normalizeAgentPersona`, `isAgentTier`, `normalizeAgentArchitectureUpdates`, `updateAgentGroup`); `db/schema.ts` (reference); `cli/resources/groups.ts` (4 updatable fields + `preUpdate`); `cli/guard.ts` (group-scoped agent denied `tier` / `reports_to` on any non-list/get groups command; upstream now canonicalizes arg keys to underscores, so the `'reports-to'` alias in the local snippet is dead but harmless).
**Upstream overlap.** None. **Verdict.** REAPPLY. Live: 22/23 groups classified; pusher reads `parseAgentPersona`.

### 1.4 Provider tooling flags + provider fallback chain (host side of migrations 020/021) - 2aab2907a, f1cb05f1c, 49d25929c, cfa361ca7, 771123384, cee648cd4
**Intent.** `enable_agy_tooling` / `enable_opencode_tooling` gate `query-agy` / `query-opencode`; `provider_chain` drives fallback in the runner.
**Files.** migrations 020/021 (keep regardless of what section 20 decides: live DB has them applied); `container-config.ts` (+144 total in file; chain part: `DEFAULT_PROVIDER_CHAIN`, `resolveProviderChain`, `ContainerConfig.providerChain/enableAgyTooling/enableOpencodeTooling`, `configFromDb` lines); `db/container-configs.ts`; `backfill-container-configs.ts`; `cli/resources/groups.ts` (`--provider-chain`, `--no-fallback`, mutually exclusive); tests `container-config.provider-chain.test.ts`, `db/container-configs.provider-chain.test.ts`.
**Upstream overlap.** None. **Verdict.** REAPPLY (host half; runner half `container/agent-runner/src/providers/build-provider.ts` is section 20/40's call). If 20-providers.md shrinks the feature, keep migrations + columns inert.
**Regression found and fixed in the candidate.** `main` has `'provider_chain'` in `JSON_COLUMNS` and the `updateContainerConfigJson` column union and `presentConfig` does not show it: that is the bug commit cee648cd4 fixed (it was lost in the 2026-08 reconcile). Candidate: `JSON_COLUMNS` without it, union without it, `presentConfig` adds `provider_chain` (parsed or null). Do the same if hand-porting.

### 1.5 Outbound.db safety: host never writes or replays a live runner's `outbound.db` - c8a05bfa9 (+ 0707702fc nested-mailbox onExit fix)
**Intent.** Docker Desktop hides container locks from the host; a host write/replay of a live runner's journal corrupted `outbound.db` (crash loops, "database disk image is malformed"). 
**Already in BASE (no work):** the read-only open itself (`openOutboundDb` uses `{ readonly: true }` since 8e97fefa, 2026-08-19).
**ALREADY-UPSTREAM part:** the admin-deny notice no longer writes `outbound.db` - upstream 7be8d7f6 (router sends it through the delivery adapter). Drop local router/session-manager deny edits, take upstream's (local resolved the instance via `getMessagingGroupByPlatform` for `replyTo`; upstream passes `event.replyTo ? undefined : mg.instance`, equivalent in practice).
**Still REAPPLY (upstream has nothing equivalent; origin/main `reconcile-session.ts` still calls `killContainer(...)` then `resetStuckProcessingRows(...)` immediately, lines ~291/302):**
- `mailbox/index.ts`: `OutboundJournalPendingError`. `mailbox/types.ts`: `OutboundMailbox.recoverOutboundJournal()`. `mailbox/sqlite/session-db.ts`: `isOutboundRollbackPending`, doc comments. `mailbox/sqlite/index.ts`: `surfacePendingJournal(...)` wrapper around the object returned by `wrapSqliteOutbound` (maps `SQLITE_READONLY_ROLLBACK` to the error from every op) + `recoverOutboundJournal` (a writable `SELECT 1` replays the journal) (conflict, 3.0).
- `reconcile-session.ts`: `journalPendingSince`, `recoverPendingOutboundJournal`, `enforceCeilingWithJournalPending` (ceiling still applies with a wedged runner), `killAndReset` (reset claims only in the kill's `onExit`, only if `!isSessionRuntimeLive`), `maintainSessionMailbox` gate on `isSessionRuntimeLive`. Applies cleanly onto upstream.
- `container-runner.ts`: `isSessionRuntimeLive` (counts `pendingAdoptions` too); `killContainer` wraps `onExit` in `outsideMailboxSession` (0707702fc: otherwise the nesting guard rejects the post-kill reset). `session-manager.ts`: export `outsideMailboxSession` (`activeMailboxKeys.exit`).
- `delivery.ts`: `catch` returns quietly on `OutboundJournalPendingError`. `modules/scheduling/migrate-legacy.ts`: tolerates it (see 1.9).
- Out of this section but part of the commit (NOT in the candidate; copy by hand): `scripts/q.ts` opens any `outbound.db` read-only (`{ readonly: true, fileMustExist: true }`); `docs/db.md` bullet "Host reads `outbound.db` truly read-only".
- Tests carried: `mailbox/sqlite/session-db.test.ts` (hot-journal refusal), `host-sweep-grace.test.ts` (+185), `host-sweep.test.ts`. Upstream 2105169d touched the same two sweep tests (env overrides) - applied clean.
**Related upstream, no host overlap:** a6964d07 (busy_timeout before journal_mode on outbound open) and 0b2f1ff4 (retry inbound.db reads) are container-side only. Note upstream `writeOutboundDirect` (`session-manager.ts`) now has no caller; keep it, take upstream's doc comment.
**Verdict.** REAPPLY (partial; deny-notice part ALREADY-UPSTREAM). Config: merge imports in `reconcile-session.ts` into one `./config.js` import: `{ ABSOLUTE_CEILING_MS_RAW, CLAIM_STUCK_MS_RAW, IDLE_CHAT_SHUTDOWN_MS, IDLE_TASK_SHUTDOWN_MS }` (the patch leaves two separate import lines; legal but lint-noisy).

### 1.6 Idle-container shutdown (`kill-idle`) + knobs - 47dc59347, 3bb929168
**Intent.** The runner never self-exits; without this every finished container held ~320 MB for the 30-minute ceiling. `decideStuckAction` gains `kill-idle` (no claim, nothing due, no tool in flight, heartbeat older than window): chat 10 min, task threads 2 min.
**Files.** `config.ts` (`IDLE_CHAT_SHUTDOWN_MS`, `IDLE_TASK_SHUTDOWN_MS`, env `NANOCLAW_IDLE_CHAT_MS` / `NANOCLAW_IDLE_TASK_MS`; add both keys to the `readEnvFile([...])` allowlist or launchd runs ignore `.env`); `reconcile-session.ts` (`idleMs`, `hasDueWork` params, `dueCount` threaded through `maintainSessionMailbox`/`enforceRunningContainerSla`); tests `host-sweep.test.ts`.
**Upstream overlap.** None (`git grep -i "kill-idle\|idle.*shutdown"` on origin/main: only a historical comment). Adjacent to 2105169d (`NANOCLAW_ABSOLUTE_CEILING_MS` / `NANOCLAW_CLAIM_STUCK_MS` overrides); compatible, both kept. **Verdict.** REAPPLY.

### 1.7 Boot crash-loop alert - f30a06a14
`container-runner.ts`: `describeSessionEnd` counts consecutive non-zero `started-then-died` ends per session and logs `error` ("Session crash-looping at boot") from the 3rd; `finish()` uses it. Test in `container-runner.test.ts`. Upstream: none. **Verdict.** REAPPLY (clean).

### 1.8 Agent-to-agent fixes - c566b7889, 67b6eb1de
**Intent.** (a) Self-routed outbound rows are denied (broke the self-feeding provider-error loop). (b) Host stamps an attested `sender` label from the source session (`Name`, `Name [task <series>]`, `[thread]`, `[shared]`) overwriting agent-supplied sender. (c) Fresh sends target the target's most recently active channel session (`findPrimaryChannelSession`) instead of the hidden (null,null) session. (d) `findSessionByAgentGroup` orders by `COALESCE(last_active, created_at)`.
**Files.** `modules/agent-to-agent/guard.ts` (`a2aSend`: self -> DENY first; drop the `isSelf` allow), `agent-route.ts` (`a2aSenderLabel`, `stampSender`, primary-session layer, doc comments), `db/sessions.ts` (`findPrimaryChannelSession`, ordering), tests `agent-route.test.ts` (+190), `message-gate.test.ts`. Container counterparts (section 40): formatter `session="sess-…"` stamping, 2e0725d2b / 75fdd1a0c claimed-batch routing, c566b7889's poll-loop part.
**Upstream overlap.** `agent-route.ts` heavily rewritten upstream (ec895214 AnchoredDir, 3a68cc7c, de6ddb94 retry loop, 2b0f97e3 card quoting); `guard.ts` upstream only changed `agentsCreate.grantCoversRequest`. **Verdict.** REAPPLY, adapted (conflict, 3.0): put attribution inside upstream's `for (attempt…)` loop:
```ts
const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);
const sourceName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
const attributedContent = stampSender(forwardedContent, a2aSenderLabel(sourceName, session));
// write `content: attributedContent`; `countForwardedFiles(attributedContent)`
```
and import `{ TASKS_SYSTEM_THREAD_ID, findPrimaryChannelSession, getSession, isTaskThread }` from `db/sessions.js`. Do not resurrect `src/inbox-safety.ts` (deleted upstream); local `agent-route.ts` imported it, the upstream file does not. Verified by the carried `agent-route.test.ts` (merged with upstream's retry/gate tests).

### 1.9 Legacy task-series migration - 8777e417d (2026-07-24)
`modules/scheduling/migrate-legacy.ts` (+ test) moves live series from chat/system sessions into per-series task sessions at startup; `index.ts` calls `await migrateLegacyTaskSeries()` before channel adapters (step "2b"). Idempotent, heals interrupted moves, skips sessions with a pending outbound journal. Upstream: none. **Verdict.** REAPPLY (wholly-ours file + 3 lines in `index.ts`). The comment in the original referenced `cleanupOrphans()`, which no longer exists; candidate rewords it (survivor containers are adopted later; insert-then-cancel + next-start heal cover the window). Needs `startup-order.test.ts` mock: `vi.mock('./modules/scheduling/migrate-legacy.js', …)` (carried).

### 1.10 Dashboard pusher + HUD + task-series export + fork link - 2f48d08ca, 9a1bca690, d6a02fab9, ed7eccd60, d8597f29f
**Intent.** Push snapshots to the forked dashboard (Fleet org chart via architecture fields + `a2a_edges` + `lastActiveAt`, HUD from read-only vault/ledger/task sources, daily token totals, MCP secrets redacted).
**Files.** `dashboard-pusher.ts`; `hud/**` (18 files); `cli/resources/tasks.ts` `collectTaskSeries(deadline)` export (HUD imports it; upstream has all helpers it needs: `getActiveSessions`, `withInbound`, `selectLiveTasks`, `enrichListRow`, `toOutput`); skill payload `.claude/skills/add-dashboard/resources/{dashboard-pusher.ts,hud/**}` + `SKILL.md`; `docs/hud-implementation.md`; tests `dashboard-pusher.test.ts`, `dashboard-server.test.ts` (drives the linked fork), `hud/sources/sources.test.ts`, `hud/wiring.test.ts` (**requires `src/dashboard-pusher.ts` and every `src/hud/**` file to be byte-identical to the skill payload copies; always `cp`, never edit one side**). `index.ts`: dashboard start + stop (mnemon: 1.12). `package.json`: `"@nanoco/nanoclaw-dashboard": "link:/Users/bradhess/Documents/GitHub/nanoclaw-dashboard"` (fork branch `fork/nanoclaw-v2`, `dist/` must be built; carries the abe8ba59 auth hardening in source, not in this repo). `.env` keys needed at runtime: `DASHBOARD_SECRET`, `DASHBOARD_PORT`, `HUD_PRIMARY_GROUP`, `HUD_STEWARD_GROUP`, `HUD_BILLING_GROUP`, `HUD_INBOX_OPS_GROUP`, `HUD_VAULT_DIR`, `HUD_AD_METRICS_DB`, `HUD_EXCLUSIONS` (read through `readEnvFile`; nothing to add to config.ts).
**Upstream overlap.** 015a7fe96 (2026-10-19, "read transcripts without loading whole files") rewrote the same skill payload: `readLines`, `startLogTail` windowed backfill, incremental `scanJsonlTokens` with `tokenScanCache`, `lastUsageLine` tail read, plus `startDashboard()` entry point and `localHourKey` (local main's copy lacks `startDashboard()` and `localHourKey` that BASE's skill payload has: the base-to-main diff deletes them, nothing in the log explains it, treat as drift). 
**Verdict.** REAPPLY as a hybrid (done in candidate, tsc + `dashboard-pusher.test.ts` + hud tests green): start from main's `src/dashboard-pusher.ts`; apply upstream's patch (`git diff 64706602 origin/main -- .claude/skills/add-dashboard/resources/dashboard-pusher.ts | git apply --3way`: merges clean except `scanJsonlTokens`); in the two conflicted hunks take **upstream's** incremental scan and add `timestamp: hit.timestamp ?? null` to `TokenEntry` and to the pushed entry (HUD daily totals need it); delete the now-unused `SourceCache` / `parseTokenJsonl` imports and `tokenFileCache`; `resetDashboardCaches()` -> `outboundStatsCache.clear(); tokenScanCache.clear();`; re-add upstream's `startDashboard()` entry (+ `import { readEnvFile } from './env.js'`). The hybrid keeps main's UTC hour keys for the activity chart (what the fork's Fleet UI was built against); upstream's local-hour `localHourKey` is NOT restored - ask Brad if he wants it (the fork UI would need to agree). `index.ts` step 8a becomes `try { const { startDashboard } = await import('./dashboard-pusher.js'); await startDashboard(); } catch (err) { log.error('Failed to start dashboard', { err }); }` (the skill's `dashboard-wiring.test.ts` wants unguarded direct statements in `main()`; main never installed that test, keep it that way for the try/catch). Then `cp` the pusher to the skill payload. The skill-payload `dashboard-pusher.test.ts` is main's version; upstream's new `describe('transcripts')` cases for it conflict next to the "tolerates a corrupt outbound.db" test (keep both as sibling `describe`s) - optional, that file is outside vitest's include list.
Also `package.json`: do NOT copy main's other dependency edits (chat adapter 4.29.0 pins, `@onecli-sh/sdk`, `pino`, `qrcode`, `@types/qrcode`: owned by skills/other sections, `pino`/`qrcode` have no importer left). After editing `package.json`, regenerate the lock (`pnpm install`), then `pnpm install --frozen-lockfile` must pass; the lock stanza reads `specifier: link:/Users/bradhess/Documents/GitHub/nanoclaw-dashboard` / `version: link:../nanoclaw-dashboard` (relative to a checkout at `~/Documents/GitHub/nanoclaw-v2`; from a worktree at another depth the relative form breaks - 2f48d08ca notes this).

### 1.11 Secret-redaction family - 53395ecb0, 1cfe0648c, ec4986aa5, 53a08a1fe, 55c071b8f, abe8ba59c
| Piece | Upstream covers? | Verdict |
|---|---|---|
| `ncl groups config get/update/add-mcp-server` redact MCP env/header values for container callers (`redactMcpServerSecrets`, `REDACTED_VALUE`, `isSecretQueryKey`, `mcpServersFor(ctx, …)` in `groups.ts`) | No (`git grep redactMcp` on origin/main: 0) | REAPPLY |
| `warnSecretShapedEnv` (warn once per group/server/key; imports `isSecretShaped`, `looksLikeCredential` from `drivers/types.ts`, which upstream still exports) in `container-config.ts` | No | REAPPLY |
| Dashboard snapshot uses `configFromDb` + `redactMcpServerSecrets` (ec4986aa/53a08a1fe), tests in `dashboard-pusher.test.ts` | No | REAPPLY (part of 1.10) |
| `ncl` approval card redaction: `cli/approval-card.ts` `renderCardArgs`, `self-mod/request.ts` exports `redactSecret`, `isSecretEntry`, `displayMcpUrl` | **No.** Upstream 2b0f97e3/ca162f47 quote untrusted text (`quoteForCard`, JSON-encode each arg, `escapeInvisibles` moved to `src/card-text.ts`, `cardQuestionTooLong`) but print raw `--env` / `--headers` secret values | REAPPLY, adapted (below) |
| Docker driver never logs env/argv on non-zero exit (test only, `drivers/docker-driver.test.ts` +20) | n/a (test) | REAPPLY (clean) |
| Dashboard token / auth hardening (abe8ba59) | Lives in the fork `../nanoclaw-dashboard` | Covered by the `link:` dependency + `dashboard-server.test.ts` |
| 68458298 (onecli scripts: no secrets on argv) | Different scope (gateway skill) | n/a here |

Approval-card adaptation (candidate has it; tests rewritten and green): `dispatch.ts` keeps upstream's block and only swaps the `argSummary` computation for `renderCardArgs(req.args)`; `renderCardArgs` now emits each value JSON-encoded (`--name "extra" --args ["-y","x","--token","<redacted: 20 bytes, sha256 …>"] --env {"K":"<redacted…>"}`), plain flag names bare, other names `JSON.stringify`d, and any name containing `=` (inline `--env={…}`) replaced whole by `redactSecret(key)`. `cardJson` returns the JSON text of the redacted structure (not double-encoded). Tests `cli/approval-card.test.ts` and `cli/dispatch-approval-card.test.ts` need their expected strings updated to the quoted form (done in candidate: `--name "extra"` etc.). `request.ts`: keep upstream's `import { escapeInvisibles, quoteForCard } from '../../card-text.js'`, add `isSecretQueryKey` to the container-config import, `export function redactSecret`, add `isSecretEntry` and `displayMcpUrl`, and use them in `requestAddMcpServerHold`; do **not** re-add local `escapeInvisibles`.

### 1.12 mnemon sync - 7e22784de, 55a51bfbc, 0523eb62f, eca39d3e9
`src/mnemon-sync.ts` (+ `mnemon-sync.test.ts`): VACUUM-INTO snapshot refresh and replay of the container write-queue through the host `mnemon` CLI, argv allowlist, FIFO/symlink-safe queue handling. `index.ts` step 8b start / shutdown stop. Skill docs `add-mnemon/{SKILL.md,REMOVE.md}` and `add-rtk/{SKILL.md,REMOVE.md}` (upstream did not touch either dir; patch applies clean). Container-dependent tests `src/mnemon-dockerfile.test.ts`, `mnemon-queue.test.ts`, `mnemon-entrypoint.test.ts` and `.claude/skills/add-mnemon/mnemon-*.test.ts` need `container/Dockerfile`, `container/mnemon-queue.mjs`, `mnemon-shim.sh`, entrypoint (section 40). Upstream: none. **Verdict.** REAPPLY.

### 1.13 ccusage - `src/ccusage.ts`, `ccusage.test.ts`, `bin/ccusage` (755), `docs/ccusage.md`
Wholly ours; no imports of changed modules. REAPPLY by copy. Doc defect: `docs/ccusage.md` tells users `pnpm ccusage -- daily` but main has no such script; candidate adds `"ccusage": "tsx src/ccusage.ts"` to `package.json` (or edit the doc). Needs a host `ccusage` binary on PATH (or `CCUSAGE_BIN`).

### 1.14 Host log rotation - 3bb929168
`src/log-rotate.ts` (+test): copy-truncate rotation of launchd-captured `logs/nanoclaw*.log` at start (20 MB, keep 5). `index.ts`: first lines of `main()`; `config.ts` exports `PROJECT_ROOT`. `startup-order.test.ts` mocks both. Upstream: none. REAPPLY (optional, low risk).

### 1.15 Install-wide default effort - 3bb929168
`config.ts` `DEFAULT_EFFORT` (`NANOCLAW_DEFAULT_EFFORT`, add to the `readEnvFile` list), `container-config.ts` `configFromDb(row, group, defaults = INSTALL_DEFAULTS)` with `model: row.model || defaults.model || undefined`, `effort: row.effort || defaults.effort || undefined`. Upstream already has `DEFAULT_MODEL` (keep its position in `config.ts`; patch moves it - harmless). Tests in `container-config.test.ts`; upstream's `container-config-model-defaults.test.ts` passes unchanged. REAPPLY.

### 1.16 `ncl groups config add-mount --rw` - 65795cfa8
`mountAccessFlag`, `--ro/--rw` mutually exclusive, `--rw` writes explicit `readonly: false` (the mount validator ignores an omitted key); long help text. Upstream: none. REAPPLY (in `groups.ts`; the `/add-rtk` skill rewrite in the same commit is in the skill dirs above).

### 1.17 Module-doc gating in `project-doc-compose.ts` - 3bb929168
`SLACK_ONLY_MODULES`, `TOOLING_GATED_MODULES`, `moduleApplies`; composer reads wiring + tooling flags; keeps Telegram groups' AGENTS/CLAUDE composition small (~39 KB -> ~19 KB, Codex 32 KB cap). Upstream did not touch the file. REAPPLY **conditional**: it is a no-op unless docs named `canvas`, `rooms`, `create-agent-slack`, `query-agy`, `query-opencode` exist (sections 10/20/40 decide); its 2 tests fail until those `.instructions.md` files exist.

### 1.18 Small test/doc carries
`startup-order.test.ts` (config/log-rotate/migrate-legacy mocks), `db/db-v2.test.ts`, `cli/resources/*.test.ts`, `docs/hud-implementation.md`, `docs/ccusage.md` are in the candidate. NOT in the candidate (copy by hand from `git diff 64706602 main -- docs/…` if wanted): `docs/db.md` (outbound read-only bullet), `docs/db-central.md`, `docs/architecture.md`, `docs/agent-runner-details.md` edits, and `scripts/q.ts`.

## Upstream overlap checklist (the commits the brief asked about)

| Upstream commit | Touches | Overlap with local host-core | Verdict |
|---|---|---|---|
| a6964d07 busy_timeout before journal_mode (outbound open) | container `mailbox/sqlite/connection.ts` | none host-side | container section; local only edits `initTestSessionDb` schema there |
| 0b2f1ff4 retry inbound.db reads mid-write | container `mailbox/sqlite/{connection,index,operations}.ts`, `poll-loop.ts` | none host-side; conflicts with local destination `thread_id` mapping in `operations.ts` | container section |
| 15c6124f never lose/repeat a reply around send_message | container `poll-loop.ts`, `destinations.ts` | none host-side; local `destinations.ts` +3 (threadId) and a2a poll-loop edits conflict | container section |
| 7be8d7f6 command-gate denial without `outbound.db` | `router.ts`, `command-gate.ts`, `session-manager.ts` | supersedes the deny-notice part of c8a05bfa | ALREADY-UPSTREAM (drop local deny edits; keep rest of c8a05bfa, 1.5) |
| ec895214 open dirs by descriptor | `session-manager.ts`, `group-skills.ts`, `agent-route.ts`, `run-log.ts`, `container-runner.ts`, deletes `inbox-safety.ts` | `agent-route.ts` (a2a edits), `session-manager.ts` (adjacent), `group-skills.ts` (comment only) | group-skills local edit OBSOLETE; a2a edits REAPPLY onto the new file (1.8) |
| 2105169d sweep env overrides | `config.ts`, `reconcile-session.ts` | adjacent edits in same file (idle windows, imports) | compatible; keep both, merge the `./config.js` imports |
| 68458298 onecli no-secrets-on-argv | `.claude/skills/add-onecli/**`, scripts | none | n/a (gateway section) |
| 2b0f97e3 / ca162f47 approval-card quoting | `dispatch.ts`, `self-mod/request.ts`, `card-text.ts`, `agent-route.ts`, channels | `dispatch.ts` + `request.ts` conflict with secret redaction (55c071b8) | quoting ALREADY-UPSTREAM; redaction still REAPPLY, adapted (1.11) |
| d014fb5f / de6ddb94 cascade deletes | `cli/resources/groups.ts` delete, `messaging-groups.ts`, `db/coordination.ts`, `db/sessions.ts`, `mailbox/sqlite/index.ts` | local never touched the delete paths; `groups.ts` import-line conflict only | ALREADY-UPSTREAM benefit, nothing to port |
| 3a68cc7c templates-in-chat | `cli/registry.ts`, `cli/resources/templates.ts`, `create-agent.ts`, `agent-to-agent/guard.ts` (`agentsCreate`) | local edits `a2aSend` in the same file, different hunk | none (clean) |
| 66f0823a upgrade marker carry | `upgrade-state.ts`, setup | none | none; remember the stamp at landing (Risks 2) |
| 015a7fe96 add-dashboard transcripts (not in the brief, found) | skill payload pusher | heavy | hybrid, 1.10 |

## Drops

| Item | Verdict | Why |
|---|---|---|
| `src/cli/socket-server.ts` `import './commands/index.js'` (moved from `index.ts` in 2aab2907a) | DROP | v1-migration artifact; upstream's `index.ts` import is the right place. Candidate restores `import './cli/commands/index.js'` in `index.ts` (omitting it silently unregisters `ncl help`/`status`). |
| `src/delivery-ambiguity.ts` + test | DROP | Dead: `delivery.ts` stopped importing it after the 2026-08 reconcile (only 6d47bf4b7 wired it, a `chore(wip)` commit). Duplicate-reply causes seen were zombie containers, not ambiguous sends. |
| `src/env.ts` `readEnvKeysWithPrefix` | DROP | No caller anywhere. |
| `config.ts` `'ONECLI_GATEWAY_CONTAINER'` in the `readEnvFile` list | DROP | `gateway-providers/onecli.ts` reads it itself. |
| `src/group-skills.ts` comment edit + `group-skills.test.ts` +13 (ef6eef072) | OBSOLETE | Upstream ec895214 rewrote it with `AnchoredDir`; `lstat` + symlink skip is built in. Take upstream. |
| Local command-gate deny rewrite in `router.ts` / `session-manager.ts` doc | ALREADY-UPSTREAM | 7be8d7f6. |
| Zombie-container dedupe: 4e491bf6e, b2197d9c9, 14f70ba67, ad480307a | OBSOLETE | `container-runtime.ts` / `cleanupOrphans()` no longer exist; driver adoption (`adoptRunningSessions`, `stopOrphanedSessions`, `retryPendingAdoptions`, session claims) and `stopReason` replace them. |
| `src/env-file.ts` | Not mine | Only importer is `modules/canvas-actions/handlers.ts` (section 10). |
| `package.json` extras (`@chat-adapter/*` 4.29.0 pins, `@onecli-sh/sdk`, `pino`, `qrcode`, `@types/qrcode`, `typecheck:tools`) and `pnpm-workspace.yaml` `patchedDependencies` (telegram patch) | Not mine / DROP | Upstream moved `chat` to 4.41.1; the patch comment says drop when adapters pass 4.41. `pino`/`qrcode` have no importer. `typecheck:tools` (93ed78e96, CI-only with `tsconfig.tools.json`) is optional. |
| Dead leftovers in the 106-file diff | none other | `chore(wip)` commits in this area only produced `delivery-ambiguity`, `bin/ccusage`/`docs/ccusage.md` (kept by decision) and the mnemon-sync +8 lines (kept). |

## How to apply

### 3.0 Fast path (verified)
```bash
# fresh worktree/clone on origin/main (NOT the live checkout); live /app/src is bind-mounted into containers
git checkout -b rebuild origin/main
git apply --3way "$SP/candidate-vs-upstream.patch"     # or: git apply "$SP/candidate-vs-upstream.patch" (plain diff vs f7440e85)
# then: package.json already has the dashboard link + ccusage script; regenerate lock
pnpm install && pnpm install --frozen-lockfile
pnpm run mailbox-model:generate && pnpm run mailbox-model:check
pnpm exec tsc --noEmit && pnpm exec vitest run src
```
If origin/main has moved past `f7440e85`, regenerate instead: `bash "$SP/pathspec.sh" | git apply --3way` and resolve these 8 (same resolutions as the candidate):
1. `cli/dispatch.ts`: keep upstream's block; replace only the `argSummary` lines with `const argSummary = renderCardArgs(req.args);` (+ `import { renderCardArgs } from './approval-card.js'`).
2. `cli/resources/groups.ts`: keep both imports (`projectDestinationsToSessions`, `CallerContext`).
3. `mailbox/sqlite/index.ts`: end of `wrapSqliteOutbound` becomes `return surfacePendingJournal({ ...ops incl. upstream's hasMessagesToOtherAgents });` followed by the local `rethrowPendingJournal` + `surfacePendingJournal` helpers.
4. `modules/agent-to-agent/agent-route.ts`: attribution inside the retry loop (1.8).
5. `modules/agent-to-agent/agent-route.test.ts`: union of imports (`cardQuestionTooLong`, `buildGateQuestion`, `GuardDenyError`, `createMessagingGroup`, `getDb`, `sessionsDb`).
6. `modules/self-mod/request.ts`: see 1.11.
7. `router.ts`: take upstream's deny block; remove the added `getMessagingGroupByPlatform` import; keep thread-filter hunks.
8. `session-manager.ts`: keep upstream's `writeOutboundDirect` comment (keep the `outsideMailboxSession` export).
Excluded from `pathspec.sh` on purpose: `src/env.ts`, `src/env-file*`, `src/group-skills*`, `src/cli/socket-server.ts`, `src/delivery-ambiguity*`, `src/modules/index.ts`, `src/opencode-cli-tools.test.ts`, `src/dashboard-pusher.ts` and the skill-payload pusher (hybrid, 1.10), package files.

### 3.1 Wholly-ours files (`git checkout main -- <path>` is also fine for these; none exist upstream)
`src/db/migrations/{020-provider-tooling,021-provider-chain,024-wiring-thread-filter,025-destination-thread,026-agent-group-architecture}.ts`, `src/ccusage{,.test}.ts`, `bin/ccusage`, `docs/ccusage.md`, `docs/hud-implementation.md`, `src/cli/approval-card.ts` (**take the candidate's adapted version, not main's**), `src/hud/**`, `src/log-rotate{,.test}.ts`, `src/mnemon-sync{,.test}.ts`, `src/modules/scheduling/migrate-legacy{,.test}.ts`, `src/router-thread-filter.test.ts`, `src/container-config.provider-chain.test.ts`, `src/db/container-configs.provider-chain.test.ts`, `src/cli/resources/groups-config-redaction.test.ts`, `src/dashboard-server.test.ts`, `.claude/skills/add-dashboard/resources/hud/**`.

## Risks

1. **Migration identity (highest).** Names above are load-bearing; any rename/duplication crash-loops the host at `initDb`. Take a fresh `.backup` of `data/v2.db` and re-run the `validate` probe (28 registered, 0 pending) against the rebuilt tree before the first start. If upstream ships a new migration later, it will simply be pending by name; local ones are unaffected.
2. **Landing.** `/app/src` is bind-mounted into live containers: build in a separate worktree, ff + `pnpm build` + restart. Skipping the upgrade stamp (`scripts/upgrade-state.ts set …`, classifier-blocked for Claude, Brad runs it) crash-loops the host on the tripwire. Re-check live HEAD right before ff. Host must stay on Node 22 (`~/.local/bin/node`).
3. **Dashboard fork dependency.** Absolute `link:` path; the fork's `dist/` must exist and be on branch `fork/nanoclaw-v2` (`git -C ../nanoclaw-dashboard branch --show-current`). `dashboard-server.test.ts` and `/dashboard` break otherwise. Keep `src/dashboard-pusher.ts` == skill payload copy (HUD wiring test).
4. **Cross-section couplings:** (a) `channels/channel-defaults.ts` `EngageValues.thread_filter` (also in 10-channels.md #8) - without it `tsc` fails in `wirings.ts`; (b) regenerate `model.generated.ts` or `model.test.ts`/CI fail; (c) container `destinations.ts` / `operations.ts` / `mcp-tools/core.ts` for pinned threads and a2a `sender`/`session` rendering, both conflicting with upstream rewrites (0b2f1ff4, 15c6124f); (d) provider chain runner half and `query-agy`/`query-opencode` docs for 1.4 / 1.17; (e) 9 candidate test failures disappear once section 40 lands the mnemon container files and the module docs.
5. **Redaction regressions are silent.** After any future merge re-run `src/cli/approval-card.test.ts`, `dispatch-approval-card.test.ts`, `cli/resources/groups-config-redaction.test.ts`, `dashboard-pusher.test.ts` ("redacts MCP secrets"); upstream's JSON-encoded card format is now the contract, redaction is layered on top of it.
6. **Features that have lost fixes before** (the 2026-08 reconcile dropped cee648cd4 and the delivery-ambiguity wiring): keep `provider_chain` out of `JSON_COLUMNS`; add a test for each REAPPLY item (they are in the candidate) rather than trusting the diff.
7. **`.env` allowlist.** The host does not auto-load `.env`; new keys (`NANOCLAW_IDLE_CHAT_MS`, `NANOCLAW_IDLE_TASK_MS`, `NANOCLAW_DEFAULT_EFFORT`) must be in `config.ts`'s `readEnvFile([...])` list (they are in the candidate). HUD/dashboard keys are read at use via `readEnvFile`.
8. **Version-number hygiene** (optional): three local migrations reuse upstream's `version:` 24/25 and two reuse 20/21; harmless today, confusing later. If bumped, change only `version:`, never `name`.
9. **pnpm lock.** The candidate edits `package.json` but not `pnpm-lock.yaml`; `pnpm install` must run with network and `minimumReleaseAge: 4320` active; confirm the lock keeps `link:../nanoclaw-dashboard` as the resolved version and `--frozen-lockfile` passes in the checkout path that will go live.

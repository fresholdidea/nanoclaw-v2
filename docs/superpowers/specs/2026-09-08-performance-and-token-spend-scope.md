# NanoClaw v2: performance, autonomy, and token-spend scope

Date: 2026-09-08. Status: Phase 0 applied 2026-09-08 (§7), Phase 1 applied and committed 2026-09-10 (§8, commit 3bb92916), Phase 2 applied 2026-09-10 (§9), Phase 3 code live 2026-09-10 (§10, rooms still need Topics enabled); threading decision: Telegram forum topics (option A). Evidence gathered read-only from the live install.

## 1. Health verdict

The install is healthy enough to build on, with four things worth fixing before anything else.

| Check | State |
|---|---|
| Service | `com.nanoclaw` up on Node 22.22.3, one Zed container live |
| Tests | 2521 pass, 1 fail (`codex-agents-md.test.ts` cap test, see §2.5), 2 skipped |
| Image | `nanoclaw-agent-v2-edb15411:latest` built 13 days ago, Claude Code 2.1.238, agent SDK 0.3.238, codex-cli 0.147.0 |
| Upstream | 102 commits behind `origin/main`, 174 ahead. Upstream added install-wide default model, fast-mode, per-group `--speed`, and a large provider-contract + host-coordination refactor |
| Logs | `nanoclaw.log` 14.8 MB and `nanoclaw.error.log` 6.9 MB, single files since Apr 30, no rotation |
| Container ceiling kills | 460 "killed past absolute ceiling" events since Apr 30. Zed DM session 66, two Zed task sessions 102, Ads task session 46, Falcone 20 |

**Correction (2026-09-10):** the ceiling kills were not mid-task kills. The runner has no self-shutdown, so a container that finished its turn idled until the 30-minute ceiling reaped it and logged a warning. A local commit from 2026-07-30 (`47dc5934`) had added a proper idle shutdown (10 min chat, 2 min task, `NANOCLAW_IDLE_CHAT_MS` / `NANOCLAW_IDLE_TASK_MS`), but the sweep half of it was lost in the 2026-08-17 merge reconcile while the config keys survived. Phase 1 restores it (§8). No tokens were being lost; the cost was ~320 MB of RAM per idle container and a noisy error log.

## 2. Findings

### 2.1 Model and effort are unpinned for 22 of 24 groups

Only Zed sets `model=claude-opus-5, effort=medium`. reviewer-1 sets `codex / gpt-5.6-terra / xhigh`. Every other group has NULL model and NULL effort, so it takes whatever the Claude Code binary in the image defaults to. Claude Code's default effort is `xhigh`, which is the most expensive setting and the one that produces the most preamble, tool calls, and length. This is the single biggest lever for both spend and verbosity, and it needs no code: `ncl groups config update --id <g> --model claude-opus-5 --effort medium`.

The plumbing already exists end to end: `container_configs.effort` → `container.json` → `ProviderOptions.effort` → SDK `effort`. The Codex provider validates effort against `none|minimal|low|medium|high|xhigh` and rejects `max`, which GPT-5.6 supports.

### 2.2 Replies are long because the instruction doc says almost nothing about length

Zed's last 171 chat replies average 1,424 chars, 45% exceed 1,500, and the longest is 4,337. AM rooms are similar (cache-am avg 1,034, p22-am avg 2,311, Falcone avg 1,197). The only length guidance in the composed doc is one sentence in `container/CLAUDE.md` ("Be concise"), buried in a 39 KB file. No per-channel format rules exist for Telegram.

### 2.3 Every group carries a 39 KB (~6,000 word) instruction document, most of it irrelevant

`project-doc-compose.ts` inlines every module and skill fragment into every group. Section sizes for a Telegram AM group (cadco-am):

| Section | Bytes | Relevant to a Telegram AM? |
|---|---|---|
| Module: canvas | 5,785 | No (Slack canvases) |
| Module: cli | 4,481 | Partly |
| Skill: slack-construct | 4,305 | No |
| query_opencode | 3,134 | Rarely |
| Runtime contract | 2,796 | Yes |
| Module: agents | 2,263 | Partly |
| query_agy | 1,924 | Rarely |
| Skill: slack-construct-agents | 1,834 | No |
| Module: create-agent-slack | 1,793 | No |
| Module: rooms | 1,762 | Partly |
| Module: interactive | 1,676 | Partly |
| Module: scheduling | 1,362 | Yes |

Roughly 14 KB per group is Slack-only content landing in Telegram rooms. Modules are always included (only `cli` and `scheduling` are conditionally dropped); skills are selectable via the `skills` column but the Slack skills are on by default. Prompt caching softens the per-turn cost, but every container spawn (and every ceiling kill) re-writes the cache, and the doc also pushes any Codex fallback over Codex's 32 KB `AGENTS.md` cap (§2.5).

### 2.4 MCP tool surface is oversized and not deferred

| Group | Servers | Approx. tools (plus 19 NanoClaw tools) |
|---|---|---|
| ads, paid-media | googleAdsServer, metaAds, linkedinAds | ~100 |
| falcone | WordPress, Hootsuite, Canva | ~70 |
| wiki | parallel-search, parallel-task, serper, reddit, firecrawl | ~30 |
| meshberg-am, p22-am, cache-am, home, dm-with-brad | 1 each | 10–20 |

Claude Code 2.1.x has tool search (`ENABLE_TOOL_SEARCH`), which defers MCP schemas out of the prompt and loads them on demand. It is supposed to auto-activate above 10% of context, but there are multiple open bug reports of auto mode not firing. NanoClaw does not set it. Setting `ENABLE_TOOL_SEARCH=true` in the Claude provider env (and marking the NanoClaw core MCP server `alwaysLoad`) is a one-line change with a large first-turn token saving for the ad groups and Falcone.

### 2.5 Codex fallback silently loses instructions

Default `providerChain` is `claude → codex → opencode` for every Claude group. When a group falls back to Codex, the same 39 KB doc is composed into `AGENTS.md` under a 32 KB cap and sections are evicted with an "Omitted for size" note. reviewer-1 sits at 28.8 KB today and is fine. The failing host test is this exact case. Slimming the doc (§2.3) fixes both.

### 2.6 No AM group has a single scheduled task

All 8 recurring series live on Zed (`morning-briefing`, `sunday-weekly-rollup`, `meshberg-content-monitor`, `falcone-trade-monitor` [paused], `cron-health-audit`, `weekly-client-status`, `brad-open-items-reminder`, `linkedin-feed-monitor`). cache-am, cadco-am, cubby-am, instabooks-am, meadow-am, meshberg-am, p22-am, falcone have none. "Proactive AMs" is purely a task-creation exercise; the scheduler, per-series sessions, and `ncl tasks create --group` all exist and work.

### 2.7 Per-client threading is per-room only

The Telegram adapter declares `supportsThreads: false` and has no `message_thread_id` handling, on trunk or on the `channels` branch. Each client has its own room with one shared session, so "threading per client" today means one long-lived context per client that only resets on compaction (165k tokens) or transcript rotation (12 MB / age cap). Slack already supports per-thread sessions (Zed DM is wired `per-thread`, `threads=1`).

### 2.8 ChatGPT models

The Codex provider is installed and working (reviewer-1 last ran 2026-09-04). GPT-5.6 ships in three tiers: Sol ($5/$30 per MTok), Terra ($2.50/$15), Luna ($1/$6), all with 1M context and effort `none` through `max`. reviewer-1 is on Terra; the host Codex config is on Luna. Codex CLI 0.147 in the image is above the 0.144 minimum.

## 3. Recommended changes

Ordered by value per unit of work. Phases 0 and 1 together are most of the token saving.

### Phase 0: configuration only, no code, no rebuild

1. **Pin model and effort per group class.** Interactive AM rooms and Zed: `claude-opus-5`, effort `medium`. Cross-client executors (ads, paid-media, crm-revops, analytics): `claude-opus-5`, effort `medium`. Utility groups (writer-h1/h2/h4, trimmer, wiki, repo-librarian, meshberg-engagement/gtm): switch provider to `codex` on `gpt-5.6-luna`, effort `medium`; or `opencode` where already tuned. reviewer-1 stays `gpt-5.6-terra`, drop effort to `high`. Reserve `claude-fable-5-1` for nothing by default; it is the wrong cost tier for chat replies.
2. **Turn off Slack skills for Telegram-only groups** via the `skills` column (`slack-construct`, `slack-construct-agents`). Saves ~6 KB per group immediately.
3. **Remove paid-media's duplicate of ads' three MCP servers** if the two-tier design (ads monitors, paid-media executes) still holds; otherwise scope each to the tools its role needs with `allowedTools` patterns in the Claude provider (read-only `get_*`/`list_*` for monitors).
4. **Create the AM cron pack** (§3, Phase 2 has the spec; creation itself is config).

### Phase 1: small code changes, one image rebuild

1. **House style in `container/CLAUDE.md`.** A short "Reply style" block: lead with the answer, default to one message under ~800 chars on Telegram unless asked for a document, no headers or bold-spam in chat, no preamble or sign-off, no restating the question, numbers in a table or one line, long deliverables go to a file with a two-line summary in chat. Add a per-channel formatting note (Telegram plain, Slack mrkdwn) alongside the existing formatter skills. This plus effort `medium` addresses the "AI slop" complaint directly.
2. **Effort and model defaults as host env knobs.** Mirror upstream `f7fad13b` (`NANOCLAW_DEFAULT_MODEL`) and add `NANOCLAW_DEFAULT_EFFORT`, resolved at spawn in `container-config.ts` so a group's own value wins. Same shape as upstream so the later merge is clean.
3. **Per-group module selection.** Extend `project-doc-compose.ts` with a `modules` selection (same pattern as `skills`) so `canvas`, `create-agent-slack`, `query-opencode`, `query-agy`, `rooms`, `interactive` can be excluded per group. Define two profiles: `am-telegram` (contract, core, cli, scheduling, agents, self-mod) and `orchestrator` (everything). Target under 15 KB for AM groups. This also makes Codex fallback safe and fixes the failing test.
4. **Tool search.** Set `ENABLE_TOOL_SEARCH=true` in `ClaudeProvider.env`; pass `alwaysLoad: true` for the NanoClaw core MCP server. Verify with one ads container that `MCPSearch` appears and the ad tools still resolve.
5. **Codex effort `max`.** Add to `SUPPORTED_EFFORTS` in `codex.ts`.
6. **Heartbeat during long tool calls.** Investigate why task sessions hit the 30-minute ceiling (460 kills). Likely fix: touch `/workspace/.heartbeat` from the `PreToolUse`/`PostToolUse` hooks in `claude.ts`, not only between poll iterations.
7. **Log rotation** for `logs/nanoclaw.log` and `nanoclaw.error.log` (size-based, keep 5).

### Phase 2: proactive AMs (task specs)

One standard pack per client AM, created with `ncl tasks create --group <am>`, all with the rule "if nothing notable, append a log line and send nothing":

| Task | Cadence | Effort | Output |
|---|---|---|---|
| Inbox and thread triage | weekdays 08:15 | low | ≤5 bullets to the client room, only if something needs Brad |
| Ad performance anomaly check (ad clients: cache, cadco, meadow, p22) | weekdays 08:30 | low | one line per anomaly, thresholds in the task prompt |
| Weekly client status | Fri 15:30 | medium | fixed 6-line template, also appended to the client's status file |
| Monthly review (cache first, reuse `cache-monthly-review` skill) | 2nd business day | medium | file deliverable, 3-line chat summary |
| Open-items nudge to Brad | Mon 09:00 | low | only items older than 5 business days |

Move `meshberg-content-monitor` and `falcone-trade-monitor` from Zed to meshberg-am and falcone so Zed stops carrying client crons. Route bulk monitoring to the cheaper provider where the check is mechanical (Luna via Codex, or opencode), per the still-open 2026-08-12 subscription-utilization thread.

### Phase 3: per-client threading (one decision needed)

Two options, both keep the existing room-per-client design:

- **A. Telegram forum topics (recommended if AMs stay on Telegram).** Convert each AM room to a forum supergroup; add `message_thread_id` handling to the Telegram adapter (Chat SDK passes it through), set `supportsThreads: true` and a `threads` default for groups, then wire AM rooms `session_mode=per-thread`. Each topic (campaign, proposal, monthly review) gets its own session, so context stays small and a stale topic never pollutes a new one. Moderate adapter work, ~2 days including tests, and the AM memory files carry the cross-thread state.
- **B. Move AM rooms to Slack private channels.** Zero adapter work (per-thread sessions already exist), but it is a migration of 7 rooms and Zed's 2026-08-18 analysis flagged Slack Connect exposure. Only pick this if Brad wants to leave Telegram for AM work anyway.

### Phase 4: upstream update (separate project)

The 102 upstream commits include the provider-contract refactor and durable host-coordination state. That is a `/update-nanoclaw` project on its own, not a cherry-pick; the July migration set the precedent. Do Phases 0–2 first so the local changes are small and shaped like upstream, then schedule the update.

## 4. Expected effect

Relative, not measured: no usage logging exists in the install today, and adding `usage` capture to the agent-runner result event is a cheap first step in Phase 1 so the next review has numbers.

| Lever | Spend effect | Verbosity effect |
|---|---|---|
| Effort xhigh → medium | Largest: fewer thinking tokens, fewer tool calls, less preamble | Large |
| House style block | Small | Large |
| Tool search on ad/Falcone groups | Large on first turn per spawn | None |
| Instruction doc 39 KB → ~15 KB | Medium per spawn, and fixes Codex fallback | Small |
| Heartbeat fix | Medium: stops killed-and-retried task runs | None |
| AM cron pack with "silent unless notable" | Adds spend, but on low effort and cheaper tiers | n/a |

## 5. Decisions for Brad

1. Threading: Telegram forum topics (A) or Slack channels (B)?
2. Utility groups to Codex Luna, or keep them on opencode?
3. Upstream update now (Phase 4 first) or after Phases 0–2?
4. Any group that should stay at `high`/`xhigh` effort (reviewer-1 is the only candidate I see)?

## 6. Assumptions made

- Cost is measured per completed task, so effort `medium` on Opus 5 is preferred over dropping to Sonnet 5 for AM replies; the model stays, the effort drops.
- Client AM rooms remain one room per client on Telegram unless decision 1 says otherwise.
- The two-tier ads/paid-media split from 2026-06-05 still holds.
- Nothing here is applied; every item above is a proposal awaiting approval.

## 7. Phase 0 execution log (2026-09-08)

- DB backup: `data/v2.db.bak-20260908-phase0`.
- 21 Claude groups pinned to `claude-opus-5` / effort `medium`; reviewer-1 effort `xhigh` → `high`. Zed unchanged. `opencode` group untouched.
- Same 21 groups: `skills` set to the explicit list of every container skill except `slack-*`. Side effect: new upstream skills no longer auto-appear for these groups; add them to the list when wanted. cadco-am composed doc: 39,117 → 32,977 bytes (still ~1 KB over the Codex 32 KB cap; Phase 1 module selection closes that).
- Skipped: removing paid-media's duplicate MCP servers. The ads/paid-media split needs both to hold the servers; tool scoping is Phase 1 (`allowedTools`).
- Cron pack created for cache, cadco, cubby, instabooks, meadow, meshberg, falcone (21 series): `<client>-daily-triage` (weekdays 08:15), `<client>-weekly-status` (Fri 15:00), `<client>-open-items` (Mon 09:00). All carry the "send nothing if nothing notable" rule and the plain-text style. p22-am skipped: no Telegram room wired. Ad-anomaly and monthly-review tasks deferred to Phase 2 (need per-client account IDs and thresholds).
- Changes take effect at each group's next container spawn; no restart performed.

## 8. Phase 1 execution log (2026-09-10)

Code changes, uncommitted, host rebuilt (`pnpm run build`) and restarted; agent-runner source is bind-mounted so no image rebuild was needed.

- **Reply style** block added to `container/CLAUDE.md` (lead with the answer, one message under ~800 chars, no headers/bold-spam, no filler, send nothing when nothing is notable, loopback URLs in inline code).
- **Install-wide defaults**: `NANOCLAW_DEFAULT_MODEL` / `NANOCLAW_DEFAULT_EFFORT` read from `.env` at spawn (`src/config.ts`, applied in `configFromDb`); a group's own value wins. Set to `claude-opus-5` / `medium` in `.env`.
- **Per-group module selection** in `project-doc-compose.ts`: `canvas`, `rooms`, `create-agent-slack` only for groups wired to a Slack channel; `query-agy` / `query-opencode` only when the matching tooling flag is on. Pure gate `moduleApplies()` with tests. This also puts Codex fallback back under its 32 KB cap and fixes the previously failing `codex-agents-md` test.
- **Tool search**: `ENABLE_TOOL_SEARCH=true` in the Claude provider env (override with `ENABLE_TOOL_SEARCH=false` on the host); the `nanoclaw` MCP server is marked `alwaysLoad` so send/ask/schedule tools stay in the first prompt.
- **Codex effort `max`** accepted.
- **Idle shutdown restored** in `src/host-sweep.ts` (`kill-idle`: no claims, nothing due, no tool in flight, quiet past the idle window; logged at info). Heartbeat is also touched from the Claude PreToolUse/PostToolUse hooks.
- **Per-turn usage line** in the Claude provider log (`Turn usage: in= out= cache_read= cache_write= turns= cost_usd=`), so spend can be read from container logs.
- **Host log rotation** at startup (`src/log-rotate.ts`): copy-then-truncate over 20 MB, keep 5. Works with launchd's append-mode fds.
- **Telegram URL drops fixed**: `transformOutboundText` code-wraps bare loopback/private-host URLs (the OneCLI connect links) before the adapter autolinks them (`src/channels/telegram-unlinkable-urls.ts`).
- **Auto-sync hook removed** from this repo's `.claude/settings.json` so session-boundary commits can no longer trip the upgrade tripwire.
- Deferred to Phase 2/3: AM ad-anomaly and monthly-review crons; Telegram forum-topic threading.

## 9. Phase 2 execution log (2026-09-10)

Configuration and workspace files only; no code.

- **Monitors moved off Zed.** `meshberg-rss-monitor.mjs` + current state copied to `groups/meshberg-am/scripts/` (the AM's stale Aug-7 state kept as `.bak-20260807`); new series `meshberg-content-monitor-e1f7` on meshberg-am (Mon/Wed/Fri 08:30) writes briefs into the client tree itself and checkpoints in the Meshberg room. `falcone-rss-monitor.mjs` + state copied to `groups/falcone/scripts/`; new series `falcone-trade-monitor-3699` on falcone, created **paused** to mirror Zed's copy. Zed's `meshberg-content-monitor-25be` paused (its `falcone-trade-monitor-2e5c` was already paused). Neither Zed copy deleted.
- **Ad anomaly checks** on the `ads` group (holds the Google/Meta/LinkedIn MCPs and the client tree read-only): `cache-ad-anomaly-8302`, `cadco-ad-anomaly-e1a2`, `meadow-ad-anomaly-375b`, weekdays 08:30. Account IDs are read from the client folder; thresholds: spend ±40% vs 7-day avg, CTR −35%, CPC +50%, active campaign with zero delivery, disapprovals. Silent unless flagged; read-only; capped at 12 tool calls. Delivered to the client's AM via new agent destinations `ads → cache-am / cadco-am / meadow-am`, per the monitor → gatekeeper role split.
- **Cache monthly review** `cache-monthly-review-0c06` on `ads`, 2nd of the month 09:00: writes `_inbox/monthly-review-YYYY-MM.md` in the Cache client folder (ads has RW on `_inbox`), then a 5-line summary to cache-am.
- Not done: p22-am tasks (no Telegram room wired); the host-side `cache-monthly-review` Claude Code skill is not available inside containers, so the monthly task carries its own spec.

## 10. Phase 3 execution log (2026-09-10): Telegram forum topics

**What was found.** The Chat SDK Telegram adapter (4.29) already carries forum topics: inbound thread ids are `telegram:<chat>` for General / plain groups and `telegram:<chat>:<topic>` for a topic message, and `postMessage` sets `message_thread_id` from the same id. NanoClaw discarded this only because `src/channels/telegram.ts` declared `supportsThreads: false`. The router already forces per-thread sessions for any group wiring whose thread policy resolves on.

**Code (uncommitted, host rebuilt and restarted 12:50):**
- `supportsThreads: true`; `TELEGRAM_DEFAULTS.group.threads: true` (DMs unchanged).
- `normalizeTelegramThreadId()` collapses the topic-less id to `null` in the inbound interceptor, so General-topic and plain-group traffic keeps the room's existing shared session and replies to it go to the chat, not a topic. Non-forum rooms therefore behave exactly as before.
- Tests: `src/channels/telegram-topics.test.ts`.
- The seven AM wirings set explicitly to `session_mode=per-thread, threads=1` (the router would force it anyway).
- `scripts/telegram-repoint-room.ts` for the chat-id migration below (dry-run by default).

**Operator runbook, one room at a time (start with one pilot room):**
1. All seven AM rooms are plain groups (`telegram:-5…`), not supergroups. Enabling Topics converts the group to a supergroup and Telegram assigns a NEW chat id (`-100…`). Nothing in NanoClaw or the SDK handles that migration automatically.
2. In Telegram: room → Edit → enable **Topics**. Telegram converts the group.
3. Post any message in the room. The router sees an unknown chat; find the new id with `pnpm exec tsx src/cli/client.ts messaging-groups list` (a new auto-created `telegram:-100…` row) or from the host log.
4. `pnpm exec tsx scripts/telegram-repoint-room.ts telegram:<old> telegram:-100<new>` (dry run), then add `--apply`. Wirings, sessions, and destinations follow the row id, so nothing else changes.
5. Post in the room again: the reply should land in the same topic. Each topic now gets its own session and container; General keeps the room's history.
6. Repeat per room. The `ads` Agentz group is already a supergroup and stays `shared` (mention mode).

**Effect on spend:** a topic session carries only that topic's context, so long-lived client rooms stop dragging one 165k-token history into every reply; idle topic containers stop after 10 minutes.

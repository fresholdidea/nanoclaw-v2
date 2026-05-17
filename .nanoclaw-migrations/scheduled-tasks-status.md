# Scheduled Tasks — v1 → v2 Port Status

Ported 2026-04-29. All 16 v1 active tasks inserted into `dm-with-brad`'s session inbound.db (`sess-1777506396687-cdofok`).

## Will fire successfully today

| Cron (local) | Task | Why it works |
|---|---|---|
| `0 8 * * *` | Morning Briefing | GWS calendar + email, web search for weather |
| `0 9 * * *` | Invoice follow-up drafter | GWS Gmail/Drive |
| `0 8 * * 0` | Sunday weekly rollup | Obsidian + group memory |
| `0 18 * * 1,5` | Meshberg meeting note watcher | Obsidian |
| `0 7 * * *` | Pre-written daily digest | Depends on n8n digest feeder; will fail until n8n wiring is done |

## Newly unblocked (2026-04-29)

- `0 * * * *` Linear PM poll — `linear-pm` skill ported to v2 container/skills/. Linear API key in vault.
- `0 7 * * *` Pre-written daily digest — n8n endpoint reachable. Caveat: depends on a separate digest-generation feeder; if no `data.digest` present, task may still no-op.

## Newly unblocked (2026-04-30) — Ads MCPs

The 3 ads MCPs (Meta, Google, LinkedIn) are wired into a separate `ads` agent group (id `ag-1777521678769-obgxhn`, session `sess-1777521678771-dptb3k`, image `nanoclaw-agent:ag-1777521678769-obgxhn`). The agent runs scheduled-task-only — no chat wiring. Reports land in `/workspace/extra/clients/projects/<slug>/output/`.

Tasks moved from dm-with-brad → ads (5 series cancelled in source, fresh rows in target):

- `0 8 * * 1` BCG RISE weekly performance
- `0 9 * * 1` Cache Financials weekly reporting
- `0 10 * * 1,3,5` Meta Ad Fatigue Detector (BCG RISE)
- `0 16 * * 5` Demand Gen Guy weekly status
- `0 */4 * * *` adaptive ads strategy reshape

Note: `linkedin-feed-monitor` (Mon 9am) was NOT moved — it's feed-monitoring, not ads-MCP-dependent. Stays in dm-with-brad.

Still blocked: tasks that depend on Mission Control script + adaptive-loop scripts (`*/15` Mission Control, `0 */4` reshape needs adaptive-loop scripts ported separately).

## Newly unblocked (2026-04-30) — Wiki agent

Wiki agent group online (id `ag-1777522934169-xd3tgr`, session `sess-1777522934170-vgpzib`, default image `nanoclaw-agent:latest` — no MCPs, no extra packages).

Mounts: obsidian RW, super-productivity RO (clients).

Skill: `container/skills/wiki/SKILL.md` ported from v1 (paths updated `/workspace/extra/projects/` → `/workspace/extra/clients/`).

Tasks moved from dm-with-brad → wiki:
- `0 10 * * 0` wiki-lint

## Will fail at run time until dependencies are ported

| Task | Blocker |
|---|---|
| `*/15 * * * *` Mission Control refresh | Script at `/workspace/group/mission-control/` (not present in dm-with-brad) |
| `*/30 * * * *` meeting transcript watcher | File watcher / pre-task script depends on v1 paths |
| `*/30 * * * *` pre-call prep | Calendar OK, prompt expects pre-injected event data |
| `0 */4 * * *` adaptive ads strategy reshape | Adaptive advertising loop scripts not ported |
| `0 8 * * 1` BCG RISE weekly perf | Meta Ads MCP not ported |
| `0 9 * * 1` LinkedIn feed monitor | LinkedIn integration not ported |
| `0 10 * * 1,3,5` Meta Ad Fatigue Detector | Meta Ads MCP |
| `0 16 * * 5` DGG weekly status | Adaptive ads scripts |
| `0 9 * * 1` ads | Cache Financials weekly | Originally targeted `ads` agent (not yet created in v2); ad MCPs missing |
| `0 10 * * 0` wiki | wiki lint | Originally targeted `wiki` agent (not yet created in v2) |

The ads and wiki tasks were ported to `dm-with-brad` with a `[ported from v1 group: <folder>]` prefix on the prompt, so they're not lost. When you create those agents, **move** these tasks (cancel them in dm-with-brad and re-create in the new agent's session).

## Operational notes

- Tasks live as `messages_in` rows with `kind='task'` in the **session's** inbound.db (not central v2.db).
- `recurrence` holds the cron expression; v2's host-sweep `handleRecurrence` schedules each next firing.
- Cancel a series: `UPDATE messages_in SET status='completed', recurrence=NULL WHERE series_id='<id>'` in the session's inbound.db. Or use the `/manage-tasks` flow if it exists.
- Pause a series: `UPDATE messages_in SET status='paused' WHERE series_id='<id>' AND status='pending'`.
- Inspect upcoming: `SELECT id, recurrence, process_after, substr(content,1,80) FROM messages_in WHERE kind='task' AND status='pending' ORDER BY process_after`.

## Re-port commands

If you need to re-port (e.g., after creating a wiki/ads agent), reuse the script at `.nanoclaw-migrations/port-tasks.ts` (currently deleted; the inline version in this commit's history can be revived).

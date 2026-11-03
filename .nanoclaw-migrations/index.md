# NanoClaw Migration Guide

Generated: 2026-11-03
Base: 64706602 (merge-base, 2026-10-01)
HEAD at generation: ed7eccd6
Upstream: f7440e85 (origin/main, 2026-11-03)
Rollback: tag `pre-migrate-ed7eccd6-20261103-171601` (branch `backup/pre-migrate-ed7eccd6-20261103-171601`)

Brad's goal: a clean install that serves a solo freelancer, carrying only customizations that are in use.

## Section files

| File | Area |
|------|------|
| `10-channels.md` (+ `10-channels.assets/`) | Telegram + Slack |
| `20-providers.md` | Codex, OneCLI, AGY/OpenCode drops |
| `30-host-core.md` | host src, DB migrations, dashboard/HUD, mnemon-sync, ccusage, A2A |
| `40-container-scripts.md` | Dockerfile, agent-runner, container skills, scripts, setup |

## Decisions (Brad, 2026-11-03)

- Rebuild on clean upstream; no merge.
- KEEP: all Telegram customizations, ALL Slack code (reinstalled via stock skills: no local deviations found), dashboard pusher + HUD, mnemon-sync, ccusage, A2A fixes, outbound.db corruption + nested-mailbox fixes, secret-redaction fixes not upstream, container skills.
- Codex: reinstall from upstream `/add-codex` payload (local copy was 12/16 byte-identical).
- DROP: OpenCode provider + scripts + `@opencode-ai/sdk`; AGY provider; `docs/superpowers/**`.

## Decisions made during analysis (Claude, flagged to Brad)

- Provider fallback chain: DROP. Dispatch was lost in the 2026-08-25 merge and it never worked end to end. Keep the `provider-chain` migration + column (live DB has it); code ignores it.
- `query_agy`: DROP for now (its mount wiring was also lost; it was dead). The Gemini big-read tool gets designed fresh after cutover, on Google AI Pro OAuth rather than the API key.
- Telegram: install from `origin/channels` (fork/channels is 637 behind) and overlay `10-channels.assets/telegram.ts`. Drop `withPlainTextFallback` (4.41.1 ships its own fallback; verify after install), drop the 4.29.0 patch and `telegram-markdown-sanitize.ts`, skip the lint-only patch.
- Drop dead code: delivery-ambiguity, destination-routing, turn-dedup, msg_id citation token.
- Dashboard chart buckets stay UTC to match the fork UI.

## Migration plan (order)

1. Skills: `/add-onecli` payload refresh (pin already 1.45.0 upstream) → `/add-codex` (0.162.1, skip auth) → `/add-telegram` from origin/channels + asset overlay → `/add-slack`, `/slack-a2a-rooms`, `/slack-agent-flow` → `/add-dashboard` (merged hybrid payload from 30) → `/add-mnemon`.
2. Host core: apply `30-host-core.candidate.patch` (`git apply --3way`); resolve the 8 conflicts per `30-host-core.md`. DB: copy the 5 local migrations verbatim, append to `migrations/index.ts`, names unchanged.
3. Container: Dockerfile hunks, cli-tools.json additions, agent-runner thread-pin/A2A/alwaysLoad, container skills copied from ed7eccd6, `pnpm mailbox-model:generate`.
4. Scripts: rebuild-agent-image, smoke-mounts, q.ts read-only hunk, reviewer-smoke, **legacy `com.nanoclaw` plist detection in scripts/update/service.ts (critical)**.
5. Validate: `pnpm install --frozen-lockfile` (regenerate lock if deps changed), `pnpm run build`, `pnpm test`, container typecheck + `bun test`, `./container/build.sh`.

## Risks

- Never rename the 5 local migrations (renaming re-runs ALTER ADD COLUMN, so the host crash-loops at initDb). Snapshot `data/v2.db` before the first start.
- /app/src is bind-mounted: land source + image together, only while the fleet is idle.
- Don't run `setup --step service` (it would replace the pinned Node-22 `com.nanoclaw` plist).
- Landing needs Brad's `scripts/upgrade-state.ts set` stamp.
- Dashboard depends on `link:/Users/bradhess/Documents/GitHub/nanoclaw-dashboard` + its built `dist/`.

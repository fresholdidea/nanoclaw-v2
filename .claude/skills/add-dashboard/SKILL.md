---
name: add-dashboard
description: Add a monitoring dashboard to NanoClaw. Installs @nanoco/nanoclaw-dashboard and a pusher that sends periodic JSON snapshots.
---

# /add-dashboard — NanoClaw Dashboard

Adds a local monitoring dashboard showing agent groups, sessions, channels, users, token usage, context windows, message activity, and real-time logs.

## Architecture

```
NanoClaw (pusher)              Dashboard (npm package)
┌──────────┐    POST JSON      ┌──────────────┐
│ collects │ ────────────────→ │ /api/ingest  │
│ DB data  │   every 60s       │ in-memory    │
│ tails    │ ────────────────→ │ /api/logs/   │
│ log file │   every 2s        │   push       │
└──────────┘                   │ serves UI    │
                               └──────────────┘
```

### Snapshot additions: agent architecture

The `/api/ingest` payload is additive — every field the dashboard already ingests keeps its shape. Since the `agent-group-architecture` migration (026) the pusher also sends:

- Per `agent_groups[]` entry: `tier` (`orchestrator | account | specialist | worker | personal | null`), `reports_to` (agent group id or null), `role` (string or null), `persona` (parsed `{emoji?, color?, initials?}` object or null), and `lastActiveAt` (ISO string of the newest `messages_out.timestamp` across that group's session `outbound.db` files, or null).
- Top-level `a2a_edges: [{ from, to, count7d, lastAt }]` — agent-to-agent traffic in the trailing 7 days, derived from `messages_out` rows with `channel_type = 'agent'` (`from` = the session's agent group, `to` = `platform_id`). Sorted by `from`, then `to`.

Both come from one read-only pass over `data/v2-sessions/<ag>/<session>/outbound.db`, cached per file by mtime/size, so a locked or corrupt file degrades to "no data for that session" rather than failing the push. Set the columns with `ncl groups update --id <id> --tier … --reports-to … --role … --persona '<json>'` (`""` clears).

## Steps

### 1. Install the npm package

```bash
pnpm install @nanoco/nanoclaw-dashboard
```

### 2. Copy the pusher module and its tests

Copy the pusher resource files into `src/` and the complete `resources/hud/` directory into `src/hud/`. The tests ship with the skill and run against the composed project — they're how you confirm the skill works and is wired in correctly.

```
.claude/skills/add-dashboard/resources/dashboard-pusher.ts       → src/dashboard-pusher.ts
.claude/skills/add-dashboard/resources/dashboard-pusher.test.ts  → src/dashboard-pusher.test.ts
.claude/skills/add-dashboard/resources/dashboard-wiring.test.ts  → src/dashboard-wiring.test.ts
```

The HUD collector imports the read-only `collectTaskSeries(deadline?)` export from
`src/cli/resources/tasks.ts`. Preserve that export when updating this install. If
it is absent, add it beside `listTasks`: enumerate active sessions whose
`thread_id` passes `isTaskThread`, check the optional `performance.now()` deadline
before each session, and read `selectLiveTasks` through `withInbound`. Project
rows with the existing `toOutput` and `enrichListRow`; fail if a task mailbox is
unavailable so a partial inventory cannot appear healthy. No command dispatch or
writes are involved. See `docs/hud-implementation.md` for the configuration and
validation contract.

- `dashboard-pusher.test.ts` — behavior: starts the pusher, posts a real snapshot to a fake dashboard.
- `dashboard-wiring.test.ts` — the code edit in step 3: asserts (via the TS AST) that `index.ts` dynamically imports `./dashboard-pusher.js` and `await`s `startDashboard()` as colocated statements of `main()`, after DB init and before the boot-complete log. Delete or misplace the edit and this goes red.

### 3. Wire into src/index.ts

This is the skill's one integration point, and it's deliberately minimal and self-contained: all the startup logic lives in `dashboard-pusher.ts`, and the import is **colocated** with the call so the whole edit is a single block in one place — there's no separate top-of-file import to add (or to remember to remove).

Add this block inside `main()`, just before the `log.info('NanoClaw running')` line:

```typescript
  // Dashboard (optional; no-ops without DASHBOARD_SECRET)
  const { startDashboard } = await import('./dashboard-pusher.js');
  await startDashboard();
```

`startDashboard()` reads `DASHBOARD_SECRET`/`DASHBOARD_PORT` itself and no-ops if the secret is unset, so nothing else in core needs to change.

### 4. Add environment variables to .env

```
DASHBOARD_SECRET=<generate-a-random-secret>
DASHBOARD_PORT=3100
# HUD sources are opt-in; unset means no data for that source.
HUD_PRIMARY_GROUP=dm-with-brad
HUD_STEWARD_GROUP=steward
HUD_BILLING_GROUP=billing
HUD_INBOX_OPS_GROUP=inbox-ops
HUD_VAULT_DIR=/absolute/path/to/vault
HUD_AD_METRICS_DB=/absolute/path/to/all.db
# Default true; only set false when the operator requests an unfiltered HUD.
HUD_EXCLUSIONS=true
```

Generate the secret: `node -e "console.log('nc-' + require('crypto').randomBytes(16).toString('hex'))"`

### 5. Build, test, and restart

Run from your NanoClaw project root:

```bash
pnpm run build
pnpm exec vitest run src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts   # behavior + wiring
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Run `build` **before** the tests: it's what guards the `@nanoco/nanoclaw-dashboard` dependency. `dashboard-pusher.ts` reaches the package through `await import('@nanoco/nanoclaw-dashboard')`, so if step 4 was skipped, `pnpm run build` fails with `TS2307: Cannot find module`. The behavior test deliberately *mocks* that package — its `startDashboard` binds a real dashboard port, a side effect we don't want in a test — so the test alone would pass with the dependency missing. Build is therefore the leg that verifies the dependency is installed; keep it ahead of the tests in the validate step.

### 6. Verify (runtime smoke check)

Once the service is restarted, confirm the dashboard is live:

```bash
curl -s http://localhost:3100/api/status
curl -s -H "Authorization: Bearer <secret>" http://localhost:3100/api/overview
```

Open `http://localhost:3100/dashboard` in a browser.

## Dashboard Pages

| Page | Shows |
|------|-------|
| Overview | Stats, token usage + cache hit rate, context windows, activity chart |
| Agent Groups | Sessions, wirings, destinations, members, admins |
| Sessions | Status, container state, context window usage bars |
| Channels | Live/offline status, messaging groups, sender policies |
| Messages | Per-session inbound/outbound messages |
| Users | Privilege hierarchy: owner > admin > member |
| Logs | Real-time log streaming with level filter |

## Troubleshooting

- **"No data yet"**: Wait 60s for first push, or check logs for push errors
- **401 errors**: Verify `DASHBOARD_SECRET` matches in `.env`
- **Port conflict**: Change `DASHBOARD_PORT` in `.env`
- **No logs**: Check `logs/nanoclaw.log` exists

## Removal

Reverse the apply steps. Safe to re-run even if some pieces are already gone. Remove the skill-installed `src/hud/` directory and the `collectTaskSeries` export added above, and remove `HUD_*` configuration keys as well.

```bash
rm -f src/dashboard-pusher.ts src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts
pnpm uninstall @nanoco/nanoclaw-dashboard 2>/dev/null || true
```

Then, by hand, remove the single dashboard block the skill added to `main()` in `src/index.ts` (the `// Dashboard (optional…)` comment, the `await import('./dashboard-pusher.js')` line, and the `await startDashboard();` call), and remove `DASHBOARD_SECRET` and `DASHBOARD_PORT` from `.env`.

```bash
pnpm run build
```

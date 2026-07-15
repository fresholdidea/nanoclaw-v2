# §04 — Customization: host core source (src/)

The highest-churn / highest-conflict area. Per **D1**, the config-storage layer **adopts upstream's DB model** — so the fork's file-based `container-config.ts` rewrite is **NOT** carried forward. This section is split into (A) the container-config DB-adoption task list, and (B) the remaining host-core deltas that ARE reapplied.

---

## A. container-config: ADOPT DB model (D1)

Keep upstream's `src/container-config.ts` + `src/db/container-configs.ts` **as-is**. Do these ports on top. Effort: S = <1h, M = ~half day.

1. **Spawn path** (`container-runner.ts`) — use upstream `materializeContainerJson(agentGroupId)` (writes `container.json`, container still reads the file). Drop the fork's `readContainerConfig(folder)` + `ensureRuntimeFields()`. **[S — upstream already does this]**
2. **`buildAgentGroupImage`** — persist imageTag to DB: `updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag })`, not to the file. **[S]**
3. **New migration** — `ALTER TABLE container_configs ADD COLUMN enable_agy_tooling INTEGER NOT NULL DEFAULT 0;` and `... enable_opencode_tooling ...`. Add both to `ContainerConfigRow` in the DB types, map in `configFromDb()`, add to `SCALAR_COLUMNS` in `updateContainerConfigScalars`. The `resolveProviderContribution` read logic (§01/§02) is storage-agnostic — no change. **[S]**
4. **Port `collectMcpEnvPassthrough`** into upstream `container-runner.ts` (operates on the config *object* — storage-agnostic). Call site in the container-args builder. **[S]** Verbatim:
```typescript
function collectMcpEnvPassthrough(containerConfig: ContainerConfig): Record<string, string> {
  const placeholderRe = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;
  const wanted = new Set<string>();
  for (const server of Object.values(containerConfig.mcpServers ?? {})) {
    if (!('command' in server) || !server.env) continue;
    for (const value of Object.values(server.env)) {
      if (typeof value !== 'string') continue;
      for (const m of value.matchAll(placeholderRe)) wanted.add(m[1] || m[2]);
    }
  }
  if (wanted.size === 0) return {};
  const values = readEnvFile([...wanted]);
  const missing = [...wanted].filter((k) => !values[k]);
  if (missing.length > 0) log.warn('MCP env passthrough: missing keys in .env', { missing, groupName: containerConfig.groupName });
  return values;
}
// call: for (const [k, v] of Object.entries(collectMcpEnvPassthrough(containerConfig))) args.push('-e', `${k}=${v}`);
```
5. **`McpServerConfig` union** — upstream stores `mcp_servers` as opaque JSON so serialization is fine, but every TS site that inspects entries needs the `'url' in cfg` guard. **AUDIT before starting:** `grep -rn "mcpServers" src/ container/agent-runner/src/` — expect hits in `container-runner.ts`, `cli/resources/groups.ts`, `claude-md-compose.ts`. **[M — type-level, no behavior]**
6. **`scripts/rebuild-agent-image.ts`** — read from DB: `getContainerConfig(group.id)` (JSON-parse columns); `--all-customized` → `getAllContainerConfigs()` filtered for non-null `image_tag`. **[S]**
7. **`src/dashboard-pusher.ts`** — one call site: `configFromDb(getContainerConfig(g.id)!, group)` instead of `readContainerConfig(g.folder)`. **[S]**
8. **Do NOT** reintroduce the fork's `readContainerConfig`/`writeContainerConfig`/`updateContainerConfig`/`initContainerConfig`. Leave upstream `backfill-container-configs.ts` in place (seeds DB from legacy files on first boot).

> **Why (recap):** upstream still materializes `container.json` at spawn → container side identical. Fork was already half-on-DB (`self-mod/apply.ts`, `ncl groups config` write DB) causing a latent split-brain where `buildAgentGroupImage` read the file. Adopting DB fixes that and ends the recurring merge tax.

---

## B. Remaining host-core deltas to reapply

### `src/container-runner.ts` — apply these clusters over upstream
- **OneCLI soft-fail** (wrap `ensureAgent` + `applyContainerConfig` in try/catch; spawn proceeds credential-less with a warning):
```typescript
try {
  if (agentIdentifier) await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  const applied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  log[applied ? 'info' : 'warn'](applied ? 'OneCLI gateway applied' : 'OneCLI gateway not applied — no credentials', { containerName });
} catch (err) { log.warn('OneCLI gateway error — container will have no credentials', { containerName, err }); }
```
- **Multi-provider contributions array** — `resolveProviderContribution` returns `contributions: ProviderContainerContribution[]`; layer `enableAgyTooling`/`enableOpencodeTooling` (§01/§02); merge via Map dedupe. Remove the old `resolveProviderName(sessionProvider, containerConfigProvider)` helper (provider comes only from `containerConfig.provider`).
- **`collectMcpEnvPassthrough`** call (see A.4).
- **Stale heartbeat cleared before spawn** — `fs.unlinkSync` + `ENOENT` guard.
- **`killContainer`** — remove the `onExit?` callback param; call sites do `killContainer(...)` then `await wakeContainer(s)` inline.
- **`wakeContainer`** returns `Promise<void>` (was `Promise<boolean>`).
- stderr last-2000-chars logged on non-zero exit; build timeout 900000 → 300000 ms.

### `src/container-restart.ts` — small
```typescript
killContainer(session.id, reason);
if (wakeMessage) { const s = getSession(session.id); if (s) void wakeContainer(s); }
```

### `src/container-runtime.ts` — two-pass `cleanupOrphans()`
Pass 1: `label=nanoclaw-install=<slug>` (steady-state). Pass 2 (migration): `name=^nanoclaw-v2-` rows with empty `nanoclaw-install` label (`--format '{{.Names}}\t{{.Label "nanoclaw-install"}}'`) — catches pre-label-fix zombies. Removable once all installs have been label-stamping long enough.

### `src/index.ts` — startup sequence (HIGH conflict risk)
1. Remove `backfillContainerConfigs`?? — **NO, keep upstream's** (D1). Only remove the fork's `enforceStartupBackoff`/circuit-breaker calls if upstream still ships them; upstream may already have dropped circuit-breaker — check.
2. Move ncl CLI side-effect imports (`./cli/commands/index.js`, `./cli/delivery-action.js`) out of `index.ts` into `socket-server.ts`.
3. **Dashboard wiring** (additive — apply last):
```typescript
const dashboardEnv = readEnvFile(['DASHBOARD_SECRET', 'DASHBOARD_PORT']);
const dashboardSecret = process.env.DASHBOARD_SECRET || dashboardEnv.DASHBOARD_SECRET;
const dashboardPort = parseInt(process.env.DASHBOARD_PORT || dashboardEnv.DASHBOARD_PORT || '3100', 10);
if (dashboardSecret) {
  const { startDashboard } = await import('@nanoco/nanoclaw-dashboard');
  const { startDashboardPusher } = await import('./dashboard-pusher.js');
  startDashboard({ port: dashboardPort, secret: dashboardSecret });
  startDashboardPusher({ port: dashboardPort, secret: dashboardSecret, intervalMs: 60000 });
} else { log.info('Dashboard disabled (no DASHBOARD_SECRET)'); }
```
4. `startCliServer()` wrapped in try/catch. 5. Shutdown: add `await stopWebhookServer()` before `teardownChannelAdapters()`. 6. Drop `isGroup` from the inbound routing call.

### `src/router.ts` — small
`wakeContainer` now `void`; remove the `if (!woke) stopTypingRefresh(...)` branch + the `stopTypingRefresh` import.

### `src/modules/self-mod/apply.ts` — small
Both handlers: `killContainer(session.id, 'rebuild applied');` then `{ const s = getSession(session.id); if (s) await wakeContainer(s); }`. (Packages already written to DB — correct under D1.)

### `src/cli/*` — small/cosmetic
- `socket-server.ts`: add `import './commands/index.js';` (moved from index.ts — populates registry before first connection).
- `dispatch.ts`: prefix unused handler params with `_`.
- `commands/help.ts`: drop unused `getResource` import.
- `delivery-action.ts`: drop unused `Database`/`Session` type imports.
- `resources/groups.ts`: same `killContainer`→sequential `wakeContainer` pattern for `ncl groups restart`.

### `src/dashboard-pusher.ts` — NEW (581 lines), copy verbatim
Telemetry collector for `@nanoco/nanoclaw-dashboard`: POSTs a full snapshot (groups, sessions, messaging groups, users, roles, adapters) to `http://127.0.0.1:<PORT>/api/ingest` every 60s; tails `logs/nanoclaw.log` → `/api/logs/push` every 5s (backfills 200 lines, strips ANSI). Reads `DASHBOARD_SECRET`/`DASHBOARD_PORT` from `.env`. Under D1, its config read uses `getContainerConfig(g.id)` (A.7).

### Deleted files
| File | Reason |
|---|---|
| `src/backfill-container-configs.ts` | **Do NOT delete under D1** — upstream keeps it for file→DB backfill. (Fork had deleted it; reverse that.) |
| `src/circuit-breaker.ts` + `.test.ts` | Startup backoff removed; rely on launchd/systemd throttling. Delete only if upstream still ships it. |
| `src/container-runner.test.ts` | Tested removed `resolveProviderName`. |
| `src/container-restart.test.ts` | Tested removed `onExit` callback. |

> **Note the D1 reversal:** the fork deleted `backfill-container-configs.ts` and rewrote `container-config.ts` file-based. Adopting DB means **restoring** upstream's versions of both and NOT re-deleting the backfill.

# §02 — Customization: OpenCode provider + cross-provider tooling

> **⚠️ Storage note (D1):** `enableOpencodeTooling` becomes a **DB column** (`enable_opencode_tooling`) under the DB-adoption decision — see §04. The `container-runner.ts` read logic is storage-agnostic.

**Intent:** Full OpenCode support as a first-class provider (`provider: "opencode"`) plus a `query_opencode` MCP tool that lets any Claude-backed group delegate one-shot drafting to an OpenRouter-routed model without switching its primary provider. Both share the same env wiring and `mcp-to-opencode.ts` translation layer.

## Base install: `/add-opencode` from `origin/providers`
Copies (stock): `src/providers/opencode.ts`, `container/agent-runner/src/providers/opencode.ts`, `mcp-to-opencode.ts`, `opencode.factory.test.ts`, `mcp-to-opencode.test.ts`; appends barrel imports. The skill does **not** ship `query-opencode.*` — those are fork additions below.

## User modifications on top of stock

### 1. `src/providers/opencode.ts` — `readEnvFile` for `ANTHROPIC_BASE_URL`
Host doesn't auto-load `.env` under launchd, so `ANTHROPIC_BASE_URL` (OneCLI proxy base) was silently missing. Add `.env` fallback for all four keys:
```typescript
import { readEnvFile } from '../env.js';
const OPENCODE_ENV_KEYS = ['OPENCODE_PROVIDER','OPENCODE_MODEL','OPENCODE_SMALL_MODEL','ANTHROPIC_BASE_URL'] as const;
const fileEnv = readEnvFile([...OPENCODE_ENV_KEYS]);
for (const key of OPENCODE_ENV_KEYS) {
  const value = ctx.hostEnv[key] ?? fileEnv[key];
  if (value) env[key] = value;
}
```
`process.env` still wins; `.env` is fallback.

### 2. `container/agent-runner/src/providers/types.ts` — `McpServerConfig` union + drop `effort`
```typescript
export type McpServerConfig =
  | { command: string; args: string[]; env: Record<string, string>; type?: 'stdio' }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
```
Remove `effort` from `ProviderOptions`. Dispatch everywhere with `if ('url' in cfg) { /* remote */ } else { /* stdio */ }`.

### 3. `container/agent-runner/src/providers/index.ts` — dynamic async loader
See §01 hook #2 (the `loadProvider` try/catch `Promise.all` barrel). Safe for missing optional deps in older per-agent images.

### 4. `container/agent-runner/src/providers/mcp-to-opencode.ts` — `'url' in cfg` dispatch
Maps `McpServerConfig` → OpenCode `mcp` field, both branches:
```typescript
if ('url' in cfg) {
  out[name] = { type: 'remote', url: cfg.url, ...(cfg.headers ? { headers: cfg.headers } : {}), enabled: true };
} else {
  out[name] = { type: 'local', command: [cfg.command, ...cfg.args], enabled: true };
}
```

## `query_opencode` tool + `enableOpencodeTooling` (fully fork-authored)

| File | Role |
|------|------|
| `container/agent-runner/src/mcp-tools/query-opencode.ts` | tool impl + `registerTools([queryOpencode])` |
| `container/agent-runner/src/mcp-tools/query-opencode.instructions.md` | agent-facing guidance |
| `container/agent-runner/src/mcp-tools/query-opencode.test.ts` | bun:test |
| `container/agent-runner/src/mcp-tools/index.ts` | add `import './query-opencode.js';` |
| DB column `enable_opencode_tooling` (§04) | host wiring |
| `src/container-runner.ts` | `enableOpencodeTooling` branch |

Handler guards at call time:
```typescript
if (!provider || !effectiveModel) {
  return err('opencode env vars not set (OPENCODE_PROVIDER / OPENCODE_MODEL). This group is not enabled for query_opencode — set enableOpencodeTooling: true in container.json.');
}
```
Host contribution layering (`src/container-runner.ts`, after the `enableAgyTooling` block):
```typescript
if (containerConfig.enableOpencodeTooling && provider !== 'opencode') {
  const opencodeFn = getProviderContainerConfig('opencode');
  if (opencodeFn) contributions.push(opencodeFn(ctx));
  else console.error(`[container-runner] enableOpencodeTooling=true on group ${agentGroup.id} but opencode provider is not registered. Run /add-opencode.`);
}
```
**Ephemeral subprocess model:** `opencode run <prompt> --model <model>`, unique cwd `/tmp/opencode-subquery/<id>/`, config via `OPENCODE_CONFIG_CONTENT` env (JSON, not file), `killProcessTree` SIGKILLs the whole group on timeout. `buildMinimalConfig` in `query-opencode.ts` mirrors `buildOpenCodeConfig` in `opencode.ts` — keep in sync.

## Reproduction order
1. `/add-opencode`. 2. Apply `readEnvFile` delta (step 1). 3. Union in `types.ts` + remove `effort`. 4. Dynamic loader barrel. 5. Confirm `mcp-to-opencode.ts` uses `'url' in cfg`. 6. Copy `query-opencode.ts` + `.instructions.md`, add barrel import. 7. Add `enable_opencode_tooling` DB column (§04) + host branch. 8. Enable per-group via DB (`ncl groups config update ... enableOpencodeTooling true`). Without the `readEnvFile` delta, `ANTHROPIC_BASE_URL` is silently absent under launchd.

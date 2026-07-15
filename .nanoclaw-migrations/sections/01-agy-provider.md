# §01 — Customization: agy provider (4th agent provider)

> **⚠️ Storage note (D1 — adopt DB model):** Wherever this section says to add `enableAgyTooling` as a field on the `ContainerConfig` interface in `src/container-config.ts`, under the DB-adoption decision that field is instead a **DB column** (`enable_agy_tooling`) added via migration and mapped in `configFromDb()`. See §04 "container-config: ADOPT DB". The `container-runner.ts` logic that *reads* `containerConfig.enableAgyTooling` is storage-agnostic and unchanged.

**Intent:** Adds Google Antigravity (`agy`) as a fourth agent provider alongside `claude`, `opencode`, and `mock`. Agents in groups with `"provider": "agy"` run every turn by spawning an ephemeral `agy -p` CLI subprocess rather than calling the Anthropic SDK, burning Google AI Pro subscription quota instead of Anthropic credits. A companion `query_agy` MCP tool lets any Claude-backed group delegate bulk/draft work to agy on a per-call basis without flipping the group's primary provider, controlled by the `enableAgyTooling` flag.

## New files (copy wholesale — do not hand-edit)

**Host:**
- `src/providers/agy.ts` — host-side provider container config: resolves the Linux binary path, validates `~/.gemini` exists, registers mounts + env via `registerProviderContainerConfig('agy', agyContribution)`.

**Container agent-runner:**
- `container/agent-runner/src/providers/agy.ts` — `AgyProvider`: CLI-per-turn subprocess, conversation-id discovery via `last_conversations.json`, stale-session detection, `stdin: 'ignore'`, `isSessionInvalid()`.
- `container/agent-runner/src/providers/mcp-to-agy.ts` — translates `McpServerConfig` (stdio + http/sse union) to agy's `mcp_config.json` schema (`command/args/env` → local; `url/headers` → `httpUrl`).
- `container/agent-runner/src/providers/agy.factory.test.ts`, `mcp-to-agy.test.ts` — bun:test.
- `container/agent-runner/src/mcp-tools/query-agy.ts` — `query_agy` MCP tool: ephemeral single-shot agy subprocess per call, unique cwd under `AGY_SUBQUERY_ROOT`, 15 min default / 30 min ceiling, `stdio: ['ignore','pipe','pipe']`.
- `container/agent-runner/src/mcp-tools/query-agy.test.ts`, `query-agy.instructions.md`.

## Integration hooks into shared files

### 1. `src/providers/index.ts` — host provider barrel
Append after other provider imports:
```typescript
import './agy.js';
```

### 2. `container/agent-runner/src/providers/index.ts` — container provider barrel (fault-tolerant dynamic loader)
Full replacement content:
```typescript
async function loadProvider(name: string): Promise<void> {
  try {
    await import(`./${name}.js`);
  } catch (err) {
    console.error(`[providers] Skipped ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await Promise.all([
  loadProvider('claude'),
  loadProvider('mock'),
  loadProvider('opencode'),
  loadProvider('agy'),
]);
```

### 3. `enableAgyTooling` config flag — **now a DB column (D1)**
Add via the §04 migration (`enable_agy_tooling INTEGER NOT NULL DEFAULT 0`), map in `configFromDb()`. The `resolveProviderContribution` read logic in `container-runner.ts` is unchanged:
```typescript
if (containerConfig.enableAgyTooling && provider !== 'agy') {
  const agyFn = getProviderContainerConfig('agy');
  if (agyFn) contributions.push(agyFn(ctx));
  else console.error(`[container-runner] enableAgyTooling=true on group ${agentGroup.id} but agy provider is not registered. Run /add-agy.`);
}
```
And the contribution merge (dedupe mounts by containerPath, last-wins env):
```typescript
const mergedMountsMap = new Map<string, VolumeMount>();
const mergedEnv: Record<string, string> = {};
for (const c of contributions) {
  for (const m of c.mounts ?? []) mergedMountsMap.set(m.containerPath, m);
  Object.assign(mergedEnv, c.env ?? {});
}
const mergedContribution: ProviderContainerContribution = { mounts: [...mergedMountsMap.values()], env: mergedEnv };
```

### 4. `container/agent-runner/src/providers/types.ts` — `McpServerConfig` union (see §02/§04)
`mcp-to-agy.ts` requires the union to branch on `'url' in cfg`.

## Skills / scripts / docs (copy verbatim)
- `.claude/skills/add-agy/SKILL.md` — install skill (binary download + sha512 verify, per-group overlay propagation, auth-login gate, group flip).
- `container/skills/agy-research/SKILL.md` — container recipe for `query_agy`.
- `scripts/agy/auth-login.sh` — runs `agy auth login` in a throwaway nanoclaw-agent container (needs `ca-certificates`; `node:22-slim` lacks them), mounting `~/.gemini` r/w.
- `scripts/spike/agy/` — spike scaffolding (informational).
- `docs/superpowers/plans/2026-05-25-agy-provider.md`, `2026-05-26-add-agy-skill.md`
- `docs/superpowers/specs/2026-05-25-agy-provider-design.md`, `2026-05-26-add-agy-skill-design.md`, `2026-05-26-query-agy-tool.md`

## Reproduction notes (load-bearing runtime behavior)
- **Binary name is `antigravity`, not `agy`.** Host looks for `~/.local/bin/antigravity-linux-{arm64,amd64}`, bind-mounts as `/usr/local/bin/agy`. Override via `AGY_LINUX_BIN`.
- **stdin MUST be `ignore`, not a pipe.** `agy -p` blocks on `read(0)` forever if stdin is an open pipe, even in `--print`. Provider + tool both spawn `stdio: ['ignore','pipe','pipe']`.
- **Stale-session detection.** `agy` exits 0 on missing `--conversation <id>`, printing `Warning: conversation "<id>" not found.`. Provider scans stdout for `/Warning: conversation ".*" not found\./`, SIGTERMs, throws; `isSessionInvalid()` clears stored `continuation`.
- **Conversation-id discovery.** agy writes `cwd → uuid` to `~/.gemini/antigravity-cli/cache/last_conversations.json`; provider polls every 500 ms (≤30 s) on the first turn, then passes `--conversation <id>`.
- **MCP config rewritten every turn** to `~/.gemini/antigravity-cli/mcp_config.json` (`mkdirSync recursive`).
- **CLI data dir** is `~/.gemini/antigravity-cli/` (not `antigravity/`, the desktop dir). Env vars `AGY_CLI_DATA_DIR`, `AGY_MCP_CONFIG_PATH`, `AGY_LAST_CONVS_PATH` point into `-cli`.
- **OAuth token** is not portable from the macOS keychain — one-time `agy auth login` inside a container with `~/.gemini` mounted r/w (`scripts/agy/auth-login.sh`); token lands at `~/.gemini/antigravity-cli/antigravity-oauth-token`, shared to all sessions via the mount.
- **Per-group overlay propagation** after copying provider files:
```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/{agy.ts,mcp-to-agy.ts,index.ts} "$overlay"
done
```

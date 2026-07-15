# §05 — Customization: container agent-runner + infra

Agent-runner runs on **Bun**. Reapply after Stage 2 (McpServerConfig union).

## Agent-runner source

### `container/agent-runner/src/config.ts`
`import type { McpServerConfig } from './providers/types.js';`; change `mcpServers` field to `Record<string, McpServerConfig>`; remove `effort?` from `RunnerConfig` + `loadConfig()`.

### `container/agent-runner/src/index.ts` — `expandMcpEnvPlaceholders` (load-bearing)
```typescript
import type { McpServerConfig } from './providers/types.js';
function expandMcpEnvPlaceholders(server: McpServerConfig): McpServerConfig {
  if (!('command' in server) || !server.env) return server;
  const placeholderRe = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;
  const expanded: Record<string, string> = {};
  for (const [key, raw] of Object.entries(server.env)) {
    expanded[key] = raw.replace(placeholderRe, (_, braced, bare) => process.env[braced || bare] ?? '');
  }
  return { ...server, env: expanded };
}
```
In the MCP loop: `mcpServers[name] = expandMcpEnvPlaceholders(serverConfig);` and label `'command' in serverConfig ? serverConfig.command : \`${serverConfig.type} ${serverConfig.url}\``.

### `container/agent-runner/src/formatter.ts` — `sanitizeMessageBody`
```typescript
export function sanitizeMessageBody(body: string): string {
  return body
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<message\s+to="[^"]*"\s*>/g, '')
    .replace(/<\/internal>/g, '')
    .trim();
}
```

### `container/agent-runner/src/turn-dedup.ts` — NEW (load-bearing), copy verbatim
Per-turn dedup between mid-turn `send_message` and end-of-turn `<message to="…">`. Module state (single-process, one-turn-at-a-time). Exports `recordTurnSend(destKey, body)`, `wasSentThisTurn(destKey, body)`, `clearTurnDedup()`; key = `` `${destKey} ${normalize(body)}` ``, `normalize` collapses whitespace. **`clearTurnDedup()` MUST run at the start of every user→agent push** (initial batch + each follow-up) or the first message of a new turn false-positives as a duplicate.

### `container/agent-runner/src/poll-loop.ts`
- Import `{ clearTurnDedup, recordTurnSend, wasSentThisTurn }` + `sanitizeMessageBody`.
- `outerCorruptionStreak` counter: wrap `getPendingMessages(isFirstPoll)` in try/catch using `isCorruptionError()`, retry up to `CORRUPTION_STREAK_EXIT` then `process.exit(75)` (virtiofs torn-read resilience — also on the FIRST poll, per `8a3e7c5`).
- `let currentRouting = routing` in `processQuery`; advance it + `setCurrentInReplyTo` + `clearTurnDedup()` on each follow-up push; pass `currentRouting` (not `routing`) to `handleEvent`/`dispatchResultText`.
- `dispatchResultText`: `sanitizeMessageBody(match[2])`, dedup check before `sendToDestination`, `recordTurnSend` after.

### `container/agent-runner/src/providers/claude.ts` — `resolveClaudeBinary()` (load-bearing, D6)
```typescript
function resolveClaudeBinary(): string {
  const arch = process.arch; // 'arm64' | 'x64'
  const candidates = [
    `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`,
    `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`,
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
  return candidates[0];
}
const CLAUDE_BIN = resolveClaudeBinary();
```
Set `pathToClaudeCodeExecutable: CLAUDE_BIN` (not `/pnpm/claude`). Remove `effort`. Keep upstream's `mcpAllowPattern()` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000'`.

### `container/agent-runner/src/mcp-tools/index.ts`
Add: `import './query-agy.js';` and `import './query-opencode.js';`

### `container/agent-runner/src/mcp-tools/core.ts` + `core.instructions.md`
`import { recordTurnSend } from '../turn-dedup.js';`; after successful `writeMessageOut` in `sendMessage`: `recordTurnSend(\`${routing.channel_type}:${routing.platform_id}\`, text);`. Add the "Never repeat yourself" paragraph to the instructions.

## Dockerfile (`container/Dockerfile`)
ARGs: `ARG OPENCODE_VERSION=1.4.17`, `ARG MNEMON_VERSION=0.1.14` (alongside `CLAUDE_CODE_VERSION=2.1.154`, `AGENT_BROWSER_VERSION=latest`, `VERCEL_VERSION=52.2.1`, `BUN_VERSION=1.3.12`). Add `python3` to apt-get (deepline).

**mnemon bake** (after Playwright ENV, before Bun):
```dockerfile
ARG MNEMON_VERSION=0.1.14
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && chmod +x /usr/local/bin/mnemon
ENV MNEMON_DATA_DIR=/workspace/extra/mnemon
```
**deepline shim** (avoids upstream installer's hanging `npx skills add`):
```dockerfile
RUN curl -fsSL "https://code.deepline.com/api/v2/cli/python" -o /usr/local/bin/deepline-real && \
    chmod +x /usr/local/bin/deepline-real && \
    printf '#!/usr/bin/env sh\nexport DEEPLINE_API_BASE_URL="https://code.deepline.com"\nexport DEEPLINE_CONFIG_SCOPE="code-deepline-com"\nexport DEEPLINE_REAL_BINARY="/usr/local/bin/deepline-real"\nexport DEEPLINE_INSTALL_METHOD="shiv"\nexec "$DEEPLINE_REAL_BINARY" "$@"\n' > /usr/local/bin/deepline && \
    chmod +x /usr/local/bin/deepline
```
**PATH fix (load-bearing)** — `$PNPM_HOME/bin` before `$PNPM_HOME` (pnpm 11.x globals live in `/bin`):
```dockerfile
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
```
**opencode install** (after claude-code layer):
```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm pnpm install -g "opencode-ai@${OPENCODE_VERSION}"
```

## `container/entrypoint.sh` — mnemon hook (idempotent), before stdin capture
```bash
mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1 || true
```
> **D2 note:** when adopting upstream's provider-agnostic memory, verify it doesn't double-register the Claude-Code session hook against this line. Reconcile in the D2 follow-up.

## Deps
- `container/agent-runner/package.json`: `"@opencode-ai/sdk": "1.4.17"` (exact pin). Run `cd container/agent-runner && bun install` to update `bun.lock`.
- Root `package.json`: `@chat-adapter/slack@4.26.0`, `@chat-adapter/telegram@4.26.0`, `@nanoco/nanoclaw-dashboard@^0.3.0`, `@whiskeysockets/baileys@7.0.0-rc.9`, `pino@9.6.0`, `qrcode@1.5.4`, dev `@types/qrcode@1.5.6`.
- `pnpm-workspace.yaml`:
```yaml
patchedDependencies:
  '@nanoco/nanoclaw-dashboard@0.3.0': patches/@nanoco__nanoclaw-dashboard@0.3.0.patch
```

## Gotchas
1. **mnemon mount required at runtime** — each group's DB `additional_mounts` must map `~/.mnemon` → `/workspace/extra/mnemon` (RW). ENV alone doesn't persist. `ads` + `paid-media` are excluded (MEMORY `mnemon_shared_store`).
2. **musl/glibc resolver is load-bearing** — removing it breaks glibc containers where bun installs both platform packages. Retest after any SDK bump.
3. **opencode in two places** — CLI global (`opencode-ai@1.4.17`) + Bun SDK (`@opencode-ai/sdk@1.4.17`); keep in sync.
4. **Dashboard patch** re-generate on version bump (`pnpm patch @nanoco/nanoclaw-dashboard@<v>`; removes body `display:flex`, `.main` `flex:1`, padding 32→24).
5. **Per-agent images go stale** on agent-runner dep changes — `scripts/rebuild-agent-image.ts --all-customized` (MEMORY `per_agent_image_drift`).

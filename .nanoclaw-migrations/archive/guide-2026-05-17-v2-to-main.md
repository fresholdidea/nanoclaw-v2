# Migration guide: v2 → origin/main

**Date:** 2026-05-17
**Pre-migration HEAD:** `3d6b346` (on legacy `unit-2-firecrawl-mcp` branch, based on `origin/v2`)
**Post-migration HEAD:** `5a2b006` (`unit-2-firecrawl-mcp` rebased to sit on `origin/main` tip `2ab6926`)
**Rollback anchor:** `pre-migrate-3d6b346-20260516-181853` (tag + branch)

## What changed

Brought the install onto `origin/main` (was 594 commits behind via the abandoned `v2` branch). All actively-used customizations replayed on top of `main`. The `v2` branch is now a legacy reference only.

## Decisions

| Topic | Choice | Rationale |
|---|---|---|
| `src/container-config.ts` | Kept fork's file-based API | Upstream went DB-backed; fork's tooling (`scripts/rebuild-agent-image.ts`, `container.json` edits) assumes file. Upstream's `014-container-configs.ts` migration left in place but unused. |
| WhatsApp Baileys | Kept v6.17.16 + fork's LID/proto patches | v7 (upstream channels branch) is a full LID rewrite. Defer until next migration. |
| `claude.ts` MCP allowlist | Adopted upstream (dynamic `mcpAllowPattern()`) | Upstream's dynamic generation handles future MCP additions without code changes. |
| `claude.ts` compact window | Adopted upstream (`process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW \|\| '165000'`) | Env-var fallback beats hardcoded. |
| `claude.ts` binary resolver | Kept fork's `resolveClaudeBinary()` | Upstream's `/pnpm/claude` path is broken on glibc-on-musl. The explicit `/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}/claude` resolver is load-bearing. |
| `ncl` CLI | Kept upstream's | Brad never integrated it but kept compatible; available if needed. `src/cli/`, `src/container-restart.ts`, and `src/db/container-configs.ts` are present but unused by Brad's runtime path. |
| `signal-auth` setup step | Removed | Legacy. |

## Customizations preserved (file-by-file)

### Channels (skill-installed from `origin/channels`)
- `src/channels/telegram.ts`, `telegram-pairing.ts`, `telegram-markdown-sanitize.ts` (+ tests) — stock copies
- `src/channels/whatsapp.ts` — **v6 fork, not stock**. Custom LID handling via `signalRepository.lidMapping`, `proto` via `createRequire` workaround
- `src/channels/slack.ts` — stock
- `src/attachment-safety.ts` — copy from `origin/channels` (NOT auto-installed by `/add-whatsapp`)
- `src/channels/index.ts` — appends `telegram`, `whatsapp`, `slack` self-registers

### Provider (skill-installed from `origin/providers`)
- `src/providers/opencode.ts` — Brad's mod adds `readEnvFile` for OPENCODE_* and ANTHROPIC_BASE_URL from `.env`
- `container/agent-runner/src/providers/opencode.ts`, `opencode.factory.test.ts`
- `container/agent-runner/src/providers/mcp-to-opencode.ts` — union dispatch on `'url' in cfg`
- `container/agent-runner/src/providers/types.ts` — `McpServerConfig` is union of stdio + http/sse
- `container/agent-runner/src/providers/index.ts` — dynamic async loader (safe for missing optional deps)

### Container source
- `container/agent-runner/src/providers/claude.ts` — `resolveClaudeBinary()` added; upstream's allowlist + compact-window patterns kept
- `container/agent-runner/src/index.ts` — `expandMcpEnvPlaceholders()` for stdio MCPs that read `${VAR}` from process.env
- `container/agent-runner/src/config.ts` — `McpServerConfig` union import, no `effort` field

### Container deps + Dockerfile
- `container/Dockerfile` —
  - `CLAUDE_CODE_VERSION=2.1.116` (matched to `@anthropic-ai/claude-agent-sdk@^0.2.116`)
  - `ARG OPENCODE_VERSION=1.4.17` + global install layer
  - **PATH fix (load-bearing):** `PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"` — pnpm 11.x's global bin symlinks don't resolve without `/bin/` first
- `container/agent-runner/package.json` — `@anthropic-ai/claude-agent-sdk@^0.2.116`, `@opencode-ai/sdk@1.4.17`

### Host source
- `src/container-config.ts` — file-based `readContainerConfig` / `writeContainerConfig` / `updateContainerConfig` / `initContainerConfig`. No DB queries.
- `src/container-runner.ts` — file-based consumer (`readContainerConfig(folder)` + `ensureRuntimeFields()` instead of upstream's `materializeContainerJson(groupId)`); `wakeContainer` returns `Promise<void>`; `killContainer` lost `onExit` callback (race-free respawn now relies on `on_wake` message column instead); `collectMcpEnvPassthrough()` for stdio MCP env var injection; OneCLI soft-fail. **Includes the heartbeat-clear-before-spawn fix.**
- `src/dashboard-pusher.ts` — 800-line telemetry collector posting snapshots + log tail to `@nanoco/nanoclaw-dashboard`
- `src/index.ts` — dashboard wiring block reading `DASHBOARD_SECRET`/`DASHBOARD_PORT` from `.env`; removed legacy `backfillContainerConfigs`/`enforceStartupBackoff`/`startCliServer`/`isGroup` calls

### Setup
- `setup/register.ts` — engage_mode/engage_pattern computation: `parsed.trigger ? (parsed.requiresTrigger ? parsed.trigger : \`(${parsed.trigger}|.*)\`) : '.'`
- `setup/groups.ts` — WhatsApp group metadata sync (replaces shell scripts)
- `setup/whatsapp-auth.ts` — fork's QR / pairing-code adapter (compatible with v6)
- `setup/index.ts` — removed `signal-auth` registration

### Scripts + patches
- `scripts/rebuild-agent-image.ts` — admin utility to rebuild per-agent-group images on dep drift
- `patches/@nanoco__nanoclaw-dashboard@0.3.0.patch` — CSS layout fix
- `pnpm-workspace.yaml` — `patchedDependencies` block for the patch

### Container skills (custom, copied verbatim)
- `container/skills/draft-invoice/` — invoice flow (Drive template + Obsidian Company frontmatter + SolidTime hours + Gmail dispatch)
- `container/skills/linear-pm/` — Linear issue polling, hardcoded with Brad's Demandgenguy workspace IDs
- `container/skills/slack-api/` — outbound Slack via per-workspace user tokens (Meadow/Cache/Miller7)
- `container/skills/wiki/` — Obsidian 50-Wiki + 50-Sources maintenance (linked to wiki agent group)
- `container/skills/google-workspace/` — incl. custom `gws-account` bash helper

### Host skills
The 3 host skills `add-google-workspace`, `reddit-research`, `serper-search` are now on `origin/main` directly — no special replay required.

## Test files removed (untestable under new API)
- `src/container-runner.test.ts` — tested removed `resolveProviderName`
- `src/container-restart.test.ts` — tested removed `killContainer` `onExit` callback

## Rollback

```bash
# Full rollback (worst case): drop everything migration touched
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
cd /Users/bradhess/Documents/GitHub/nanoclaw-v2
git reset --hard pre-migrate-3d6b346-20260516-181853
pnpm install
pnpm run build
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Verification (done)

| Check | Result |
|---|---|
| Host TypeScript build | ✅ clean |
| Host tests | ✅ 354 pass |
| Container TypeScript typecheck | ✅ clean |
| Container tests (bun) | ✅ 93 pass |
| Live Telegram round-trip from worktree dev | ✅ 2 messages, both delivered (23s + 15s) |
| Live service restart on swapped code | ✅ pid 10127, no errors |
| WhatsApp connection on restart | ✅ 46 groups synced |

## Known followups

- **Container image rebuild** required for any container-side changes to take effect inside agent containers (claude.ts, opencode bridge, etc.). The currently-running containers still use the pre-migration image. Rebuild with `./container/build.sh` when convenient — non-urgent since the host changes work with the existing image.
- **Slack credentials** missing from `.env`. Skill installed, channel registers, but warns "channel credentials missing, skipping" on boot. Configure when ready.
- **Per-agent image drift** — agent groups with custom packages (per `container.json`) may have stale per-agent images that need rebuilding via `scripts/rebuild-agent-image.ts --all-customized`.

# Antigravity CLI (`agy`) as a NanoClaw Agent Provider

**Status:** Design  
**Date:** 2026-05-25  
**Author:** Brad (via brainstorm with Claude Code)

## Goal

Add `agy` (Google's Antigravity CLI) as a fourth agent provider alongside `claude`, `opencode`, and `codex`. Any agent group can opt in via `agent_provider: 'agy'` in its `container.json`, mirroring the existing codex/opencode/ollama integrations.

### Why

**Subscription stacking and model-agnosticism.** Brad has a Google AI Pro subscription. Routing one or more agent groups to agy consumes those tokens instead of Anthropic API credits. The same motivation produced `/add-codex` (ChatGPT subscription) and `/add-opencode` (OpenRouter/OpenAI). This completes the matrix and reduces lock-in to any single provider.

### Non-goals

- Agy's plan-mode discipline (`implementation_plan.md`, `task.md`, approval gates) — not surfaced through chat.
- Agy's chrome-devtools / a11y-debugging / memory-leak-debugging plugins — available as standalone MCP servers if wanted, no need to route through agy.
- Headless visual auditing to `/workspace/outbox/` — any agent with Chromium can do this; not agy-specific.
- Agy as a host-side dev tool — Brad can `agy` on the host directly without any NanoClaw integration.

## Context

### Agy capabilities (verified)

`~/.local/bin/agy --help` confirms:
- `-p / --print` — single-shot non-interactive
- `--conversation <id>` — resume a previous conversation by ID (continuation token)
- `--continue` — most recent conversation
- `--dangerously-skip-permissions` — auto-approve tool calls
- `--add-dir` — additional workspace directories
- `--print-timeout` — wait ceiling (default 5m)

State and config locations on the host:
- OAuth: `~/.gemini/oauth_creds.json`, `~/.gemini/state.json`, `~/.gemini/google_accounts.json`
- MCP servers: `~/.gemini/antigravity/mcp_config.json`
- Conversation transcripts: `~/.gemini/antigravity/brain/<conv-id>/`
- An `agentapi` binary at `~/.gemini/antigravity/bin/agentapi` (function TBD, possibly JSON-RPC)

### Hard blockers (must resolve before building)

1. **Linux binary availability.** Host `agy` is `Mach-O 64-bit executable arm64`. The container is `node:22-slim` (Debian Linux). Without a `linux/arm64` build (for Docker on Apple Silicon) or `linux/amd64` (for x86 hosts), the project cannot proceed.
2. **Headless streaming behavior.** A smoke test of `agy -p "hello"` returned a single final block. If `--print` doesn't emit incremental events during tool execution, the host's idle-kill timer in `container-runner.ts` will terminate long agy turns. Mitigations to investigate, in order: a streaming output flag, the `agentapi` JSON-RPC mode, or worst-case a sidecar that touches `/workspace/.heartbeat` while agy thinks.

## Architecture

### Two-gate spike (Phase 1)

Mandatory before Phase 2. Time budget: half-day total.

**Gate 1 — Linux binary.** Confirm Google ships `agy` for `linux/arm64` (and/or `linux/amd64`). Sources to check: official download page, `agy update --help`, GitHub releases, the agy install script. If no Linux build → defer indefinitely. Update this spec with the decision and revisit when Google ships it.

**Gate 2 — Headless streaming.** Drive the Linux binary from a throwaway script:

```bash
agy -p "Read foo.txt, modify it, then run pytest" \
    --dangerously-skip-permissions \
    --print-timeout 10m
```

Observe:
- Does stdout emit incrementally during tool calls, or buffer until the end?
- Is there a structured output mode (`--output-format json`, SSE, etc.)?
- Does `agentapi` accept JSON-RPC over stdio?
- What does the conversation ID look like on first run? Where is it emitted?

Outcomes:
- **Streams cleanly** → proceed to Phase 2 with stdout parsing.
- **`agentapi` JSON-RPC works** → use that instead. More work but cleaner: bidirectional `push()` without abort-restart.
- **Neither** → fall back to Codex's abort-and-restart pattern. Either accept long-turn timeout risk, or add a heartbeat sidecar.

### Provider interface mapping (Phase 2)

The `AgentProvider` interface in `container/agent-runner/src/providers/types.ts` requires:

| Interface contract | Agy mapping |
|---|---|
| `supportsNativeSlashCommands` | `false` — agy's slash commands (`/goal`, `/grill-me`, etc.) are interactive-mode features. In `-p` mode, treat slash commands as plain text like the other providers. |
| `query(input)` | Spawn `agy -p <prompt> [--conversation <continuation>]` with `--dangerously-skip-permissions`. Wire stdout/stderr to the event parser. |
| `events` | Yield `init` (with conversation ID), `activity` (on each parsed event from stdout or agentapi), `progress` (textual updates), `result` (final assistant message), `error` (parse failures or process exit non-zero). |
| `push(message)` | If `agentapi` JSON-RPC is available: send a follow-up message on the same connection. Otherwise: abort current process, respawn with `--conversation <id>` and the combined turn. |
| `end()` | Close agy's stdin. |
| `abort()` | `kill -TERM` the agy process; SIGKILL after grace period. |
| `isSessionInvalid(err)` | Match agy's "unknown conversation" / "conversation not found" error strings. Wording determined during spike. |
| `maybeRotateContinuation` | Initial: no-op. Revisit if `brain/<id>/` folders grow large enough to cause cold-resume timeouts. |

### Container surface

**Host-side provider config** — `src/providers/agy.ts`:

```ts
import os from 'os';
import path from 'path';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('agy', (ctx) => {
  const geminiHostDir = path.join(os.homedir(), '.gemini');
  const agyLinuxBinary = process.env.AGY_LINUX_BIN
    ?? path.join(os.homedir(), '.local/bin/agy-linux');
  return {
    mounts: [
      { hostPath: geminiHostDir, containerPath: '/home/node/.gemini', readonly: false },
      { hostPath: agyLinuxBinary, containerPath: '/usr/local/bin/agy', readonly: true },
    ],
    env: {},
  };
});
```

Self-registered in `src/providers/index.ts`.

**Container-side provider** — `container/agent-runner/src/providers/agy.ts`. Modeled on `opencode.ts`. Owns the spawn, the event parser, the conversation-ID extraction, and the `mcp_config.json` write.

**MCP translator** — `container/agent-runner/src/providers/mcp-to-agy.ts`. Maps the in-memory `Record<string, McpServerConfig>` (the union type from `types.ts:68-79`) into agy's `mcp_config.json` schema and writes to `/home/node/.gemini/antigravity/mcp_config.json` before each query. Same pattern as `mcp-to-opencode.ts`.

**Factory wiring** — `container/agent-runner/src/providers/factory.ts` + `index.ts`. One case, one export.

### Installation skill (Phase 3)

`/add-agy` skill on the `providers` branch (matching `/add-opencode`, `/add-codex`):
1. `git fetch origin providers` and copy `container/agent-runner/src/providers/{agy.ts,mcp-to-agy.ts}` and `src/providers/agy.ts`.
2. Append `import './agy.js';` to `src/providers/index.ts` and the corresponding export to `container/agent-runner/src/providers/index.ts`.
3. Verify the Linux agy binary is present at the expected path; if not, instruct Brad to download it.
4. Optionally flip a chosen agent group's `agent_provider` to `'agy'` in `container.json`.
5. `./container/build.sh` and restart the affected group.

Skill is idempotent and reads schema from the existing channel/provider-skill template.

### OneCLI interaction

Agy's API calls to Google's backend are not gated by OneCLI (no host pattern). MCP-server credentials (Slack, Gmail, etc.) still flow through OneCLI as today — that's per-MCP, not per-agent-provider, so nothing changes there. No new OneCLI rules required.

## Success Criteria

Done means all of:

1. A test agent group with `agent_provider: 'agy'` accepts a chat message, runs a multi-tool turn (read a file + call one MCP tool), and returns a response in the channel.
2. Continuation works across two messages in the same session — the second message lands in the same agy conversation, not a new one.
3. A tool run that takes longer than 2 minutes doesn't trigger the host's idle-kill.
4. OneCLI-managed MCP credentials still flow correctly through to MCP servers when invoked from agy.
5. Token cost shows up under Google AI Pro quota, not the Anthropic console.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Google doesn't ship a Linux build of agy | Project-killing | Gate 1 spike catches this before any code. Defer + document. |
| `agy -p` doesn't stream events during tool calls | High | Gate 2 spike. Fallbacks ordered: stream flag → agentapi JSON-RPC → heartbeat sidecar → accept the timeout limitation. |
| `~/.gemini/oauth_creds.json` mount races with host agy use | Medium | OAuth refresh is filesystem-atomic; both processes reading the same file is fine. If concurrent token refresh becomes a problem, narrow the mount to read-only after initial login. |
| Conversation ID format changes between agy releases | Low | Tolerant parser; surface as `isSessionInvalid` → drop continuation and start fresh. |
| Agy plugin/MCP config schema drifts | Low | `mcp-to-agy.ts` is small enough to update reactively. Pin a tested agy version in the install skill. |

## Decision Record

- **Pattern:** mirror existing `/add-codex` and `/add-opencode` rather than invent new shape.
- **Auth:** host-shared bind mount of `~/.gemini/` — established pattern, smallest surface, single place to refresh.
- **Binary distribution:** bind-mount the Linux binary instead of baking it into the image — avoids image bloat for users who never enable agy.
- **Skill location:** `providers` branch (not trunk) — matches existing convention; trunk stays minimal.
- **Long-turn streaming:** to be decided by Gate 2 spike. Until then, this spec assumes a fallback exists.

## Open Questions (resolved during spike)

1. Linux binary URL / install method.
2. Stdout streaming behavior in `-p` mode.
3. `agentapi` interface — is it the right path, or vestigial?
4. Conversation-ID format on first invocation.
5. `isSessionInvalid` error string.

# `query_agy` MCP tool — Contract & Decision Record

**Status:** Shipped (commit `c51428c` on `local/main`)
**Date:** 2026-05-26
**Author:** Brad (via brainstorm with Claude Code)

## Goal

Let any agent (typically Claude-backed) delegate a one-shot prompt to an ephemeral `agy -p` subprocess and get back the trimmed stdout. Enables cross-provider sub-querying: keep chat-native groups on Claude (fast, low narration leak) while still consuming Google AI Pro tokens for sub-tasks (bulk drafting, broad research, second opinions).

Pairs with the [`/agy-research`](../../../container/skills/agy-research/SKILL.md) recipe skill, which uses this tool as its underlying primitive.

## Contract

`mcp__nanoclaw__query_agy({ prompt: string, timeoutMs?: number }) → { content: [{type: 'text', text: string}], isError?: boolean }`

- **Single-shot per call.** No `--conversation` re-use. Each call spawns a fresh subprocess; no shared state with the orchestrator or with prior `query_agy` calls.
- **Tempdir-isolated.** Each call runs in `${AGY_SUBQUERY_ROOT}/<timestamp>-<random>/` (default root `/workspace/agent/.agy-subquery/`). This keeps the cwd→conversation cache key in `~/.gemini/antigravity-cli/cache/last_conversations.json` from colliding with the main agy provider's cwd when both are active in the same container.
- **Wall-clock SIGKILL.** Default timeout 15 min; hard ceiling 30 min. Override via `timeoutMs` (clamped to `[1000, 1_800_000]`).
- **Returns trimmed stdout.** Includes agy's tool-call narration alongside the final answer. The orchestrator model is expected to skim past the narration. This matches the agy provider's own behavior.
- **Error surface:** `isError: true` for missing binary, non-zero exit, empty stdout, spawn failure, timeout.

### Enablement

Two paths:
1. **`provider: "agy"`** in the group's `container.json` — agy mounts/env always present.
2. **`enableAgyTooling: true`** (new flag, this PR) — agy mounts/env layered on regardless of primary provider. Use this for Claude/OpenCode-backed groups that want sub-querying without flipping their main provider.

Mount validation (`src/modules/mount-security/index.ts`) forbids absolute container paths in `additionalMounts`, so the JSON-only enablement path was not viable. The `enableAgyTooling` flag was chosen as the minimum-surface alternative (one boolean, one branch in `resolveProviderContribution`) over a full feature-mount-registry abstraction.

## Architectural decisions

- **No `--conversation` re-use.** Sharing the main provider's `activeConversationId` would tangle the orchestrator's chat with the sub-query — painful to back out of. The cost of single-shot (each call is a fresh "I have no context" session) is acceptable because the recipe pattern (e.g., `/agy-research`) front-loads all context into the prompt.
- **No MCP config write.** The agy provider writes `mcp_config.json` per turn so sub-tools are available to the running session. `query_agy` deliberately skips this — concurrent calls would race the single global config file, and the use cases (drafting, research) don't typically need MCP tools inside the sub-query. If a future use case needs MCP-equipped sub-queries, it'd require per-call `mcp_config.json` paths via env var.
- **`stdio: ['ignore', 'pipe', 'pipe']` is load-bearing.** agy `-p` reads stdin and hangs if it's an open pipe — caught during the original agy provider spike (see `scripts/spike/agy/findings.md`).
- **Lazy env reads.** `AGY_BIN` / `AGY_SUBQUERY_ROOT` are read inside the handler, not at module load. Allows env to change between calls in long-running processes (matches how env vars naturally flow into the container).
- **Settled-guard on timeout.** When the kill-timer fires and resolves `err(timeout)`, a guard prevents the eventual `close` event from double-resolving. Necessary because SIGKILL'd shells can leave orphaned `sleep`/subprocess children with the stdio pipes still open — `close` never fires in those cases.

## Known issues / follow-ups

1. **Narration leak in `result.text`.** Same root cause as the agy provider — agy emits running narration on stdout with no "final answer starts here" marker. Documented in the tool description and the `/agy-research` skill explicitly handles it ("skim past leading preamble"). Lowest-cost fix: post-process pass on the result text that detects the boundary between narration and answer. Not worth doing until a third use case shares the same pain.
2. **`/workspace/agent/.agy-subquery/` accumulates over time.** No janitor in V1. If it grows past nuisance, add a `find ... -mtime +1 -delete` step somewhere (skill, sweep, or a one-line on container spawn).
3. **`last_conversations.json` accumulates entries** — one per tempdir per call. agy itself doesn't garbage-collect this file. Worth a janitor only if it gets unwieldy.
4. **Cross-provider mount layering abstraction.** Today the `enableAgyTooling` branch in `resolveProviderContribution` is hard-coded to call `getProviderContainerConfig('agy')`. If a second tool needs the same "borrow another provider's mounts" pattern, extract a generic `enableProviderTooling: ProviderName[]` field or a feature-mount registry. Today is too early — YAGNI.

## Files

| Path | Role |
|---|---|
| `container/agent-runner/src/mcp-tools/query-agy.ts` | The tool implementation (~140 lines). |
| `container/agent-runner/src/mcp-tools/query-agy.test.ts` | Unit tests (6 cases). |
| `container/agent-runner/src/mcp-tools/query-agy.instructions.md` | Agent-facing usage fragment. Auto-stitched into per-group CLAUDE.md. |
| `container/agent-runner/src/mcp-tools/index.ts` | Barrel — `import './query-agy.js';` |
| `container/skills/agy-research/SKILL.md` | Recipe skill that uses `query_agy`. |
| `src/providers/agy.ts` | Refactored: `agyContribution` exported as a named function. |
| `src/container-config.ts` | Added `enableAgyTooling?: boolean` field. |
| `src/container-runner.ts` | `resolveProviderContribution` returns `ProviderContainerContribution[]`; callers merge with last-wins de-dupe by `containerPath`. |

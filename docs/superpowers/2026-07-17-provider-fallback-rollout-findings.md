# Provider Fallback Chain — Rollout Findings & Blockers

**Date:** 2026-07-17 (validation session)
**Status:** Code merged to `local/main` and host-side live; **cross-provider fallback NOT runtime-functional** — paused pending a scoping decision.
**Related:** [spec](superpowers/specs/2026-07-17-provider-fallback-chain-design.md) · [plan](superpowers/plans/2026-07-17-provider-fallback-chain.md)

## TL;DR

The fallback-chain **code** (composite `FallbackProvider`, config, `ncl` flags) is built, tested (container 233/233, host 1220/1220), reviewed, merged, and its host side is now **live** (host restarted → `providerChain` materialization + codex host contribution active). But **live validation showed the chain cannot actually fall back to Codex or OpenCode** without additional host-side work that the merged feature does not include. Nothing was deployed to any real group's chain.

## The architectural gap (the important finding)

`FallbackProvider` switches providers **inside** the container (agent-runner level). But **Codex and OpenCode require host-side, spawn-time setup that only runs for a group's *primary* provider**:

- **Codex** — its `providesAgentSurfaces` contribution (`src/providers/codex.ts`) sets up: a **writable `/home/node/.codex` mount** (`data/v2-sessions/<group>/.codex-shared`), composed `AGENTS.md`, `.agents/skills`, and the OneCLI auth stub. Without the writable mount, the container-side codex provider fails with `EACCES: permission denied, open '/home/node/.codex/config.toml'` (it can't write `config.toml`).
- **OpenCode** — needs `OPENCODE_*` env + an XDG mount passed at spawn (see CLAUDE.md “Channels and Providers”).

A **claude-primary** group's container is spawned with only **claude's** contribution. When `FallbackProvider` switches to codex/opencode in-process, those providers have **no mounts/env** and fail. The provider *code* switches correctly and **degrades safely** (the whole-branch review's degrade-not-crash fix means it skips the broken link and surfaces the primary's error — no crash), but the fallback link never actually runs.

**To make cross-provider fallback functional**, the host must spawn each container with the **union of every `providerChain` member's host contribution** (mounts + env), not just the primary's. That is a real design + implementation addition (touches `src/container-runner.ts` `resolveProviderContribution` / `spawnContainer`, and the provider contribution registry).

## Secondary blockers found

1. **Host was stale (fixed).** The running host predated `94c31cd` (codex install) and the fallback merge. It was restarted this session, activating both the codex contribution and the fallback host code. This was the cause of the *first* codex `EACCES` (the `.codex-shared` mount wasn't being applied at all).
2. **Codex provider bugs — never live-validated.** After the restart, codex spawn fails in `materializeTemplateSkills` (`ENOENT`, `src/providers/codex.ts:60` → `group-skills.ts`). The `/add-codex` install (commit `94c31cd`) passed only unit tests (mocked FS); this session is the first *live* codex turn attempt, and it does not complete one. Codex needs end-to-end debugging + validation before it can be a fallback link.
3. **OpenCode install incomplete.** `@opencode-ai/sdk` had been stripped from `container/agent-runner/package.json` (commit `e0258e8`, “move opencode provider off v2 trunk”) during migration churn, so the provider fails to register (`Cannot find module '@opencode-ai/sdk'`). The `opencode` group has been dormant since ~May 26. Also missing: the `opencode-ai` **CLI** in `container/Dockerfile` (`ARG OPENCODE_VERSION=1.4.17` + `pnpm install -g "opencode-ai@${OPENCODE_VERSION}"`).

## State changed this session (production install)

- **Host restarted** (`launchctl kickstart com.nanoclaw`) — now runs the current `dist/` with the merged fallback host code + codex contribution. Production healthy: `dm-with-brad` running on Claude (quota reset), routing normal.
- **`@opencode-ai/sdk@1.4.17` added** to `container/agent-runner/package.json` + `bun.lock` — **uncommitted**. Partial step toward finishing OpenCode; only takes effect on an image rebuild (not done). Safe to keep or revert.
- **Base image rebuilt** (`nanoclaw-agent-v2-edb15411:latest`) — harmless refresh (codex-cli 0.138.0 present); does not include the opencode SDK/CLI yet (needs another rebuild after the Dockerfile change).
- No `providerChain` set on any real group. No fallback deployed.

## Two paths forward

### Path A — Same-provider credential fallback (simpler; solves the actual outage)
The incident that motivated this was the **shared Claude OAuth subscription** hitting its plan quota and 429-ing every claude group. The lowest-friction fix is a **credential fallback within the `claude` provider**: OAuth subscription → Anthropic **API key** (already in OneCLI under Connections → LLMs). Same provider ⇒ **same mounts/env** ⇒ **no architectural gap**. This directly solves the observed outage and reuses the existing `FallbackProvider` shape (links become credentials, not providers). Requires: a way to select the alternate credential per attempt (OneCLI-side or a claude-provider credential-fallback seam).

### Path B — Full cross-provider fallback (original design; large)
Deliver Claude → Codex → OpenCode as specified:
1. **Host-side:** spawn containers with the **union** of all `providerChain` members' contributions (mounts + env). Design + implement in `container-runner.ts`.
2. **Codex:** fix `materializeTemplateSkills` ENOENT and any further issues; validate a real end-to-end codex turn.
3. **OpenCode:** add the Dockerfile CLI (`ARG OPENCODE_VERSION=1.4.17` + global install), rebuild the image (bakes the SDK into node_modules + installs the CLI), validate a real opencode turn.
4. Deploy `[claude, codex, opencode]` to `dm-with-brad`, force a fallback, verify recovery.

Multi-session effort with its own build/validate cycles.

## Recommendation

Pursue **Path A** for real availability protection against the quota outage (it's small and directly on-target), and treat **Path B** as a separate, larger workstream if cross-provider fallback is still wanted for cost/quota diversification. The merged cross-provider code is a correct foundation for B and loses nothing by waiting.

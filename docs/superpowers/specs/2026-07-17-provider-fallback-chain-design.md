# Provider Fallback Chain — Design

**Date:** 2026-07-17
**Status:** Approved (design)
**Author:** Brad + Claude

## Problem

Every claude-provider agent group in this install authenticates against a **single shared Claude subscription OAuth token** (held in OneCLI's credential store, injected into every agent's `api.anthropic.com` calls). When that subscription hits its plan usage limit, Anthropic returns `429` on every call for every group at once. The agent-runner surfaces this as `Rate limit (retryable: false, quota)` and the turn simply fails — the agent goes mute until the usage window resets.

Observed 2026-07-17: the `dm-with-brad`/Zed group hammered `api.anthropic.com/v1/messages` at ~1 req/s, every one returning `429` (`injections_applied=1`, so the credential injected fine — the limit is Anthropic-side). A nested Claude process under the same group surfaced the same failure as `"Not logged in · Please run /login"`, which looped back into the session as agent-to-agent noise.

We want a **provider fallback chain**: when the primary provider returns a non-retryable availability error, the runner transparently continues the turn on the next provider in the chain. Target chain: **Claude → Codex → OpenCode Go**. Codex and OpenCode Go credentials already exist in OneCLI (`/add-codex` token added; `/add-opencode` previously run).

## Goals

- Keep an agent group responsive when its primary provider hits a quota/auth/billing wall.
- Zero changes to the poll loop, delivery, MCP, or host routing layers — the fallback must live entirely behind the existing `AgentProvider` interface.
- Preserve per-provider conversation continuity across container restarts.
- Make fallback events loudly visible so a genuine misconfiguration is noticed, not silently masked.

## Non-Goals

- Cross-provider session *transfer* (handing Claude's live thread to Codex). Per-provider sessions are independent by design; we bridge switches with a recap, not a transfer.
- Load-balancing or cost-optimization routing. This is an availability fallback, not a scheduler.
- Changing how OneCLI stores or injects credentials.
- Retrying transient/overloaded errors — the underlying SDKs already auto-retry those before the runner ever sees them.

## Design Decisions (resolved during brainstorming)

1. **Config scope:** global default chain + per-group override (opt-out via `null`).
2. **Recovery mode:** sticky fallback with a cooldown re-probe of the primary (default 30 min).
3. **Fallback triggers:** non-retryable errors classified `quota`, `auth`, or `billing`. Other errors surface to the user.
4. **Handoff continuity:** inject a short recap (last ~2-3 exchanges from the shared `conversations/` transcript) into the new provider's context on each switch.
5. **Codex readiness:** validate the (currently untracked) Codex provider standalone before wiring it as link #2.

## Architecture

### Composite `FallbackProvider`

A new module `container/agent-runner/src/providers/fallback.ts` implements the existing `AgentProvider` interface (`providers/types.ts`) and wraps an **ordered list of child providers**. Because it satisfies the same interface, the poll loop (`poll-loop.ts`), runner dispatch (`index.ts`), delivery, and MCP layers require **no changes** — they continue to operate on one `AgentProvider`.

Construction: given the ordered provider names and the shared `ProviderOptions`, the wrapper lazily builds each child via `createProvider(name, options)` (`providers/factory.ts`). Children are constructed on first use so an unused tail link (e.g. OpenCode) costs nothing until reached.

### State via the opaque continuation token

The `AgentProvider` contract states the continuation token is opaque and "the provider decides what this means" (`types.ts`, `QueryInput.continuation`). The `FallbackProvider` uses this to hold **all** of its cross-turn state, so nothing new needs persisting and the poll loop's existing `setContinuation(providerName, token)` call (`poll-loop.ts:498`) is sufficient. The token is:

```
base64(JSON.stringify({
  v: 1,
  active: "codex",                       // provider name currently in effect
  children: {                            // each child's own last continuation
    claude: "<claude-session-id>",
    codex: "<codex-thread-id>",
    opencode: "<opencode-id>"
  },
  cooldownUntil: "2026-07-17T20:30:00.000Z" // ISO-8601 UTC; null when active === primary
}))
```

- Persisted as a single session-DB row keyed `"fallback"` — survives container restarts.
- On `query()`, the wrapper decodes it to restore the active link, each child's session, and the cooldown.
- When a child emits `init` with its continuation, the wrapper updates `children[active]`, re-encodes, and emits the composite token upward as the `init` continuation. The poll loop persists it unchanged.
- Resuming a recovered primary later reuses `children.claude`, so Claude picks up its **original pre-outage thread**.

Timestamps follow the repo rule: written as `new Date().toISOString()` (UTC `Z`), compared with `datetime()` on both sides where SQL is involved (not applicable here — comparison is in JS).

### `query()` control flow

```
decode composite token → { active, children, cooldownUntil }

// choose starting link
if (cooldownUntil && now >= cooldownUntil) startIndex = 0        // re-probe primary
else startIndex = indexOf(active)                                // sticky

for i in startIndex .. lastIndex:
    child = ensureChild(chain[i])
    childInput = { ...input, continuation: children[chain[i]],
                   systemContext: withRecapIfSwitched(input, i) }
    run child.query(childInput):
        re-emit init/activity/progress/result downstream
        on init:   children[chain[i]] = token; active = chain[i]; emit composite upward
        on terminal error classified {quota|auth|billing}, OR
           result with isError classified {quota|auth|billing}:
               log "[fallback] <from>→<to> classification=<c>"
               emit progress event
               (first fallback of outage) → optional owner DM
               advance to i+1; set cooldownUntil = now + COOLDOWN_MS
               continue loop
        on success (result, no matching error):
               if i === 0: active = primary; cooldownUntil = null   // fully recovered
               else:       active = chain[i]                        // stay sticky
               return
// all links exhausted:
emit the last child's terminal error downstream (identical to today's single-provider failure)
```

### Trigger classification

Two paths must be covered because providers signal availability failures differently:

- **`error` event** — carries `classification` directly (`claude.ts:557` emits `classification: 'quota'`; `codex.ts` has its own `classifyError`). Match against `{quota, auth, billing}` with `retryable === false`.
- **`result` with `isError: true`** — e.g. Claude's 403 `billing_error` arrives as a result, not an error event (`poll-loop.ts:516` handles this path today). A small shared classifier inspects the result text to detect `auth`/`billing`/`quota`; a match triggers fallback instead of delivering the notice to the user.

The classifier lives in `fallback.ts` (or a tiny `providers/error-classification.ts` if shared with providers) and is unit-tested against representative messages.

### Handoff recap

On a switch (active link changes from the previous turn, or mid-turn advance), the wrapper reads the last ~2-3 exchanges from the shared `conversations/` transcript in `cwd` (all providers archive there via `onExchangeComplete`/`exchange-archive.ts`) and prepends a `<system>` note to `systemContext.instructions` for the new child:

```
<system>You're continuing an ongoing conversation that was being handled by another
assistant. Recent context:
  Brad: <prev user msg>
  Assistant: <prev reply>
  Brad: <current msg>
Continue naturally. Full history is in conversations/ and shared memory if you need it.</system>
```

No recap is injected when the same link handles consecutive turns.

## Configuration

### Host default

A single default chain constant lives host-side (with the provider config, `src/providers/`): `['claude', 'codex', 'opencode']`.

### Materialization into `container.json`

When the host materializes a group's `container.json` (the file the runner reads — authoritative over the DB at spawn), it resolves `providerChain`:

| Group state | Resolved `providerChain` |
|-------------|--------------------------|
| No explicit setting, primary = `claude` | host default `['claude','codex','opencode']` |
| No explicit setting, primary ≠ `claude` | `[<primary>]` (no fallback) |
| Explicit `providerChain: [...]` | that array verbatim |
| Explicit `providerChain: null` | `[<primary>]` (opt out) |

Stored in `container_configs` (central DB) and written to `container.json`. Managed via `ncl groups config update` (extend with a `--provider-chain` / `--no-fallback` flag) alongside the existing provider config path.

### Runner dispatch

`index.ts` reads `config.providerChain`:

- length ≤ 1 → `createProvider(config.provider, opts)` (unchanged behavior).
- length > 1 → `new FallbackProvider(chain, opts)`.

`config.provider` remains the primary/first entry for back-compat; `providerChain[0]` must equal it (validated at materialization).

### Tunables

- `COOLDOWN_MS` — default 30 min. Configurable via container config (`providerChainCooldownMinutes`).
- Owner-DM-on-fallback — boolean flag, default on. Reuses the existing approver/owner resolution used elsewhere for owner notifications.

## Error Handling & Edge Cases

- **All links fail:** the last child's terminal error is emitted downstream unchanged — no regression versus today.
- **Partial output then error:** if a child already emitted a successful `result`, the turn is complete; no fallback (we only advance on an error without a matching successful result).
- **Retryable errors:** never trigger fallback; passed through so the SDK/loop handle them as today.
- **Corrupt/old continuation token:** if decode fails or `v` is unknown, treat as a fresh start at the primary (log a warning). A single malformed token must never wedge a session.
- **Wasted re-probe:** after cooldown expiry, one fast failing primary call per 30 min during a sustained outage. Acceptable.
- **Child provider not registered** (e.g. OpenCode SDK missing in image): `createProvider` throws `Unknown provider`; the wrapper logs and skips that link, advancing to the next. A chain must degrade, not crash.

## Testing

Bun unit tests (`container/agent-runner/src/providers/fallback.test.ts`, `import { test } from 'bun:test'`):

- Error on primary → advances to next child; result delivered from fallback.
- Sticky: after fallback, a second `query()` (with the composite token) starts on the fallback link, not the primary.
- Cooldown re-probe: with `cooldownUntil` in the past, `query()` starts at the primary again.
- Full recovery: successful primary turn clears `cooldownUntil` and resets `active` to primary.
- Composite token encode/decode round-trip; malformed token → fresh primary start.
- Recap injected only on switch, sourced from a stubbed `conversations/` transcript.
- All-links-fail surfaces the last child's error unchanged.
- Classifier: `quota`/`auth`/`billing` messages match; unrelated errors don't.

Child providers are mocked (fake `AgentProvider`s emitting scripted event sequences). No live API calls in unit tests.

## Implementation Phases

1. **Validate Codex standalone.** Finish and commit the in-flight Codex provider work (currently untracked: `container/agent-runner/src/providers/codex*.ts`, `exchange-archive.ts`, host `src/providers/codex.ts`, `setup/providers/codex.ts`). Stand up a throwaway `provider=codex` group and confirm one real turn runs against the OneCLI Codex token. **Gate:** green before wiring the chain.
2. **Build `FallbackProvider` + tests** (above).
3. **Host config wiring** — default chain constant, `providerChain` resolution in `container.json` materialization, `container_configs` field, `ncl groups config` flag.
4. **Runner dispatch** — `index.ts` builds the wrapper when `providerChain.length > 1`.
5. **Roll out** — enable on `dm-with-brad` first (verify a forced fallback via a revoked/exhausted primary), then extend the default across the claude fleet.

### Files Touched

- **New:** `container/agent-runner/src/providers/fallback.ts` (+ `fallback.test.ts`); possibly `providers/error-classification.ts` (+ test).
- **Modified:** `container/agent-runner/src/index.ts` (dispatch); the container config loader + its type (add `providerChain`, `providerChainCooldownMinutes`); `src/providers/` (host default chain); `src/container-config.ts` + `container.json` materialization; `ncl groups config` resource.
- **Prerequisite:** commit the pending Codex provider files (host + container + setup) already present in the working tree.

## Open Risks

- **Codex maturity.** Freshly built, untracked. Phase 1 gates on a real standalone turn; if Codex fails messily (bad output vs clean error), we reassess whether it belongs at position #2 or defer to `[claude, opencode]`.
- **Silent masking.** Broad triggers (quota+auth+billing) could hide a real misconfig. Mitigated by loud per-fallback logging + optional owner DM on first fallback of an outage.
- **Recap token cost.** Small per-switch cost; bounded to ~2-3 exchanges. Negligible versus an unavailable agent.

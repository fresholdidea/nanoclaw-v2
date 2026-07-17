# Provider Fallback Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent group's primary provider returns a non-retryable quota/auth/billing error, the agent-runner transparently continues the turn on the next provider in the chain (Claude → Codex → OpenCode Go), staying responsive through a provider outage.

**Architecture:** A composite `FallbackProvider` implements the existing `AgentProvider` interface and wraps an ordered list of child providers. It stores all cross-turn state (active link, each child's session id, cooldown) inside the opaque continuation token it already owns, so the poll loop, dispatch, delivery, and MCP layers stay unchanged. Fallback is sticky with a 30-minute cooldown re-probe of the primary; each switch injects a short recap for continuity.

**Tech Stack:** TypeScript. Container agent-runner runs on **Bun** (`bun:test`, `bun:sqlite`); host runs on **Node + pnpm** (`vitest`, `better-sqlite3`). The two never share modules — they communicate only via session DBs.

## Global Constraints

- **Poll loop stays unchanged.** No edits to `container/agent-runner/src/poll-loop.ts`. All fallback state rides in the continuation token via the existing `setContinuation(providerName, token)` call.
- **Container tests use `bun:test`**, imported as `import { test, expect, describe } from 'bun:test'`. Never `vitest` in `container/agent-runner/`. Run with `cd container/agent-runner && bun test <file>`.
- **Host tests use `vitest`.** Run with `pnpm test`.
- **Named SQL params in the container use `$name`** in both SQL and JS keys (`bun:sqlite` does not strip the prefix). Host uses `better-sqlite3` (`@name` stripped).
- **Timestamps:** written as `new Date().toISOString()` (ISO-8601 UTC `Z`). SQL comparisons wrap both sides in `datetime()`.
- **Fallback triggers only on non-retryable errors classified `quota`, `auth`, or `billing`.** All other errors pass through unchanged.
- **Cooldown default = 30 minutes** (`COOLDOWN_MS = 30 * 60 * 1000`), overridable via `providerChainCooldownMinutes`.
- **Default chain = `['claude', 'codex', 'opencode']`.**
- **Container typecheck** after editing `container/agent-runner/src/`: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.
- Work on branch `provider-fallback-chain` (already created). Do not push to `origin`.

## File Structure

**Container (agent-runner, Bun):**
- Create `container/agent-runner/src/providers/fallback-state.ts` — continuation-token codec + types (pure, no I/O).
- Create `container/agent-runner/src/providers/fallback-state.test.ts`.
- Create `container/agent-runner/src/providers/error-classification.ts` — `classifyFailure()` shared classifier.
- Create `container/agent-runner/src/providers/error-classification.test.ts`.
- Create `container/agent-runner/src/providers/fallback.ts` — the `FallbackProvider` composite.
- Create `container/agent-runner/src/providers/fallback.test.ts`.
- Modify `container/agent-runner/src/config.ts` — add `providerChain`, `providerChainCooldownMinutes` to `RunnerConfig`.
- Modify `container/agent-runner/src/index.ts` — build `FallbackProvider` when `providerChain.length > 1`.

**Host (Node, vitest):**
- Modify `src/container-config.ts` — add `providerChain` to `ContainerConfig`, resolve default/override in `configFromDb`.
- Create `src/container-config.provider-chain.test.ts`.
- Modify `src/db/migrations/` — add a migration adding a nullable `provider_chain` column to `container_configs`.
- Modify `src/db/container-configs.ts` — read/write the new column.
- Modify `src/cli/resources/groups.ts` (or the config sub-resource) — `--provider-chain` / `--no-fallback` flags on `ncl groups config update`.

---

## Phase 1 — Validate the Codex provider standalone (GATE)

The Codex provider (`container/agent-runner/src/providers/codex*.ts`, host `src/providers/codex.ts`, `setup/providers/codex.ts`) is built but untracked and unproven in a live turn. Prove it works before making it link #2. **Do not start Phase 2 until Task 1 passes.**

### Task 1: Commit and smoke-test the Codex provider

**Files:**
- Commit (already present, untracked): `container/agent-runner/src/providers/codex.ts`, `codex-app-server.ts`, `exchange-archive.ts`, their `*.test.ts`, `src/providers/codex.ts`, `src/providers/codex-*.test.ts`, `setup/providers/codex.ts`, `setup/providers/codex*.test.ts`, and the barrel edits already in `container/agent-runner/src/providers/index.ts`, `container/cli-tools.json`, `setup/providers/index.ts`, `src/providers/index.ts`.

**Interfaces:**
- Consumes: existing `AgentProvider` interface from `providers/types.ts`.
- Produces: a registered `codex` provider (via `providers/index.ts` `import './codex.js'`).

- [ ] **Step 1: Run the existing Codex unit tests**

Run: `cd container/agent-runner && bun test src/providers/codex.turns.test.ts src/providers/codex-app-server.test.ts src/providers/codex.factory.test.ts src/providers/codex-registration.test.ts src/providers/codex-cli-tools.test.ts`
Expected: PASS (all). If any fail, fix the Codex provider before proceeding — it is not ready to be a fallback link.

- [ ] **Step 2: Container typecheck**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the OneCLI Codex credential injects**

The Codex token lives in OneCLI (Connections → LLMs). Confirm the gateway has a host pattern for the Codex/OpenAI endpoint:
Run: `onecli secrets list` (redact values in any output; never print token values)
Expected: an entry whose `hostPattern` matches the Codex app-server's upstream host (e.g. `api.openai.com` or `chatgpt.com` per the Codex provider's endpoint). If absent, stop and tell the operator to add it — the fallback link cannot authenticate without it.

- [ ] **Step 4: Live standalone turn on a throwaway group**

Create a temporary agent group whose primary provider is `codex`, wired to a DM, and send it one message. Confirm a real reply is delivered.
Run (create the group + config; adjust ids to the install):
```bash
./container/build.sh   # only if the image lacks the codex app-server binary
# then, via ncl (host socket):
ncl groups create --name codex-smoke --folder codex-smoke
ncl groups config update --id <new-id> --provider codex
# wire a DM messaging group + destination per /init-first-agent, send a test DM
```
Expected: the group replies via Codex. Inspect `data/v2-sessions/<group>/<session>/outbound.db` `messages_out` for a produced response, and container stderr for `[agent-runner] Starting v2 agent-runner (provider: codex)` with no auth error.

- [ ] **Step 5: Tear down the throwaway group**

Run: `ncl groups delete --id <new-id>` and remove its `groups/codex-smoke/` folder.
Expected: group gone.

- [ ] **Step 6: Commit the Codex provider**

```bash
git add container/agent-runner/src/providers/codex.ts container/agent-runner/src/providers/codex-app-server.ts container/agent-runner/src/providers/exchange-archive.ts container/agent-runner/src/providers/codex*.test.ts container/agent-runner/src/providers/exchange-archive.test.ts container/agent-runner/src/providers/index.ts container/cli-tools.json src/providers/codex.ts src/providers/codex-*.test.ts src/providers/index.ts setup/providers/codex.ts setup/providers/codex*.test.ts setup/providers/index.ts
git commit -m "feat(providers): add Codex provider (validated standalone)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**GATE:** Phase 2 begins only after Task 1 Step 4 delivered a real Codex reply.

---

## Phase 2 — The composite FallbackProvider

### Task 2: Continuation-token state codec

**Files:**
- Create: `container/agent-runner/src/providers/fallback-state.ts`
- Test: `container/agent-runner/src/providers/fallback-state.test.ts`

**Interfaces:**
- Produces:
  - `interface FallbackState { v: 1; active: string; children: Record<string, string>; cooldownUntil: string | null }`
  - `encodeState(state: FallbackState): string` — returns base64 of the JSON.
  - `decodeState(token: string | undefined): FallbackState | null` — returns `null` for undefined/empty/malformed/unknown-version tokens (caller then starts fresh).

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from 'bun:test';
import { encodeState, decodeState, type FallbackState } from './fallback-state.js';

const sample: FallbackState = {
  v: 1,
  active: 'codex',
  children: { claude: 'sess-a', codex: 'thread-b' },
  cooldownUntil: '2026-07-17T20:30:00.000Z',
};

test('encode → decode round-trips', () => {
  expect(decodeState(encodeState(sample))).toEqual(sample);
});

test('decode returns null for undefined', () => {
  expect(decodeState(undefined)).toBeNull();
});

test('decode returns null for empty string', () => {
  expect(decodeState('')).toBeNull();
});

test('decode returns null for malformed base64/json', () => {
  expect(decodeState('not-base64-!@#')).toBeNull();
  expect(decodeState(Buffer.from('{not json').toString('base64'))).toBeNull();
});

test('decode returns null for unknown version', () => {
  const bad = Buffer.from(JSON.stringify({ ...sample, v: 2 })).toString('base64');
  expect(decodeState(bad)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container/agent-runner && bun test src/providers/fallback-state.test.ts`
Expected: FAIL — `Cannot find module './fallback-state.js'`.

- [ ] **Step 3: Implement the codec**

```ts
// container/agent-runner/src/providers/fallback-state.ts
export interface FallbackState {
  v: 1;
  /** Provider name currently in effect. */
  active: string;
  /** Each child provider's own last continuation token. */
  children: Record<string, string>;
  /** ISO-8601 UTC; null when active === primary (no re-probe pending). */
  cooldownUntil: string | null;
}

export function encodeState(state: FallbackState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

export function decodeState(token: string | undefined): FallbackState | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Partial<FallbackState>;
    if (parsed.v !== 1 || typeof parsed.active !== 'string' || typeof parsed.children !== 'object' || parsed.children === null) {
      return null;
    }
    return {
      v: 1,
      active: parsed.active,
      children: parsed.children as Record<string, string>,
      cooldownUntil: typeof parsed.cooldownUntil === 'string' ? parsed.cooldownUntil : null,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd container/agent-runner && bun test src/providers/fallback-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/providers/fallback-state.ts container/agent-runner/src/providers/fallback-state.test.ts
git commit -m "feat(providers): fallback state continuation-token codec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: Failure classifier

**Files:**
- Create: `container/agent-runner/src/providers/error-classification.ts`
- Test: `container/agent-runner/src/providers/error-classification.test.ts`

**Interfaces:**
- Consumes: `ProviderEvent` from `providers/types.js`.
- Produces:
  - `type FailureClass = 'quota' | 'auth' | 'billing'`
  - `FALLBACK_CLASSES: ReadonlySet<FailureClass>` = `{quota, auth, billing}`.
  - `classifyFailure(event: ProviderEvent): FailureClass | null` — returns a fallback-triggering class, or `null` if the event is not a triggering failure. Handles BOTH the `error` event (uses `event.classification`, requires `retryable === false`) AND the `result` event with `isError === true` (classifies from `event.text`).
  - `classifyMessage(message: string): FailureClass | null` — text classifier reused by both paths and by providers.

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from 'bun:test';
import { classifyFailure, classifyMessage } from './error-classification.js';
import type { ProviderEvent } from './types.js';

test('quota error event triggers', () => {
  const e: ProviderEvent = { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
  expect(classifyFailure(e)).toBe('quota');
});

test('retryable error never triggers', () => {
  const e: ProviderEvent = { type: 'error', message: 'API retry', retryable: true };
  expect(classifyFailure(e)).toBeNull();
});

test('non-trigger classification does not fall back', () => {
  const e: ProviderEvent = { type: 'error', message: 'boom', retryable: false, classification: 'unknown' };
  expect(classifyFailure(e)).toBeNull();
});

test('isError result classified from text (billing)', () => {
  const e: ProviderEvent = { type: 'result', text: 'Your credit balance is too low (billing_error)', isError: true };
  expect(classifyFailure(e)).toBe('billing');
});

test('isError result classified from text (auth)', () => {
  const e: ProviderEvent = { type: 'result', text: 'Not logged in · Please run /login', isError: true };
  expect(classifyFailure(e)).toBe('auth');
});

test('successful result never triggers', () => {
  const e: ProviderEvent = { type: 'result', text: 'hello', isError: false };
  expect(classifyFailure(e)).toBeNull();
});

test('classifyMessage maps keywords', () => {
  expect(classifyMessage('unauthorized')).toBe('auth');
  expect(classifyMessage('usage limit reached')).toBe('quota');
  expect(classifyMessage('billing_error')).toBe('billing');
  expect(classifyMessage('something else')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container/agent-runner && bun test src/providers/error-classification.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the classifier**

```ts
// container/agent-runner/src/providers/error-classification.ts
import type { ProviderEvent } from './types.js';

export type FailureClass = 'quota' | 'auth' | 'billing';

export const FALLBACK_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>(['quota', 'auth', 'billing']);

const AUTH_RE = /\b(unauthorized|not logged in|please run \/login|invalid api key|invalid.*credential|401)\b/i;
const BILLING_RE = /\b(billing_error|credit balance|payment required|402|insufficient.*(credit|quota|funds))\b/i;
const QUOTA_RE = /\b(quota|usage limit|rate limit|429|too many requests)\b/i;

export function classifyMessage(message: string): FailureClass | null {
  if (AUTH_RE.test(message)) return 'auth';
  if (BILLING_RE.test(message)) return 'billing';
  if (QUOTA_RE.test(message)) return 'quota';
  return null;
}

export function classifyFailure(event: ProviderEvent): FailureClass | null {
  if (event.type === 'error') {
    if (event.retryable) return null;
    if (event.classification && FALLBACK_CLASSES.has(event.classification as FailureClass)) {
      return event.classification as FailureClass;
    }
    return classifyMessage(event.message);
  }
  if (event.type === 'result' && event.isError === true) {
    return classifyMessage(event.text ?? '');
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd container/agent-runner && bun test src/providers/error-classification.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/providers/error-classification.ts container/agent-runner/src/providers/error-classification.test.ts
git commit -m "feat(providers): fallback failure classifier (quota/auth/billing)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: FallbackProvider — advance-on-failure

**Files:**
- Create: `container/agent-runner/src/providers/fallback.ts`
- Test: `container/agent-runner/src/providers/fallback.test.ts`

**Interfaces:**
- Consumes: `AgentProvider`, `AgentQuery`, `QueryInput`, `ProviderEvent`, `ProviderOptions` from `types.js`; `encodeState`/`decodeState`/`FallbackState` from `fallback-state.js`; `classifyFailure` from `error-classification.js`.
- Produces:
  - `type ChildFactory = (name: string) => AgentProvider`
  - `interface FallbackDeps { createChild: ChildFactory; now: () => number; cooldownMs: number }`
  - `class FallbackProvider implements AgentProvider` with constructor `(chain: string[], deps: FallbackDeps)`.
  - Recap helper is added in Task 6; keep a no-op recap seam here.

**Test doubles** (define at top of `fallback.test.ts`, reused by Tasks 4–6):

```ts
import { test, expect } from 'bun:test';
import { FallbackProvider, type FallbackDeps } from './fallback.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './types.js';

/** A scripted child provider: each query yields the given event sequence. */
function scriptedChild(name: string, script: (input: QueryInput) => ProviderEvent[]): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    registerMemorySessionHook() {},
    isSessionInvalid() { return false; },
    query(input: QueryInput): AgentQuery {
      const events = script(input);
      return {
        push() {},
        end() {},
        abort() {},
        events: (async function* () { for (const e of events) yield e; })(),
      };
    },
  };
}

async function collect(q: AgentQuery): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of q.events) out.push(e);
  return out;
}

function makeDeps(children: Record<string, AgentProvider>, nowMs = 1_000_000): FallbackDeps {
  return { createChild: (n) => children[n], now: () => nowMs, cooldownMs: 30 * 60 * 1000 };
}
```

- [ ] **Step 1: Write the failing test (advance on quota error)**

```ts
test('primary quota error advances to next child; result comes from fallback', async () => {
  const claude = scriptedChild('claude', () => [
    { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' },
  ]);
  const codex = scriptedChild('codex', () => [
    { type: 'init', continuation: 'codex-thread-1' },
    { type: 'result', text: 'answer from codex', isError: false },
  ]);
  const deps = makeDeps({ claude, codex });
  const provider = new FallbackProvider(['claude', 'codex'], deps);

  const q = provider.query({ prompt: 'hi', cwd: '/tmp' });
  const events = await collect(q);

  // No error surfaced; a result from codex is delivered.
  expect(events.some((e) => e.type === 'error')).toBe(false);
  const result = events.find((e) => e.type === 'result');
  expect(result && 'text' in result ? result.text : null).toBe('answer from codex');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container/agent-runner && bun test src/providers/fallback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement FallbackProvider (advance + passthrough + state emit)**

```ts
// container/agent-runner/src/providers/fallback.ts
import type {
  AgentProvider, AgentQuery, ProviderEvent, ProviderExchange, QueryInput,
} from './types.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { decodeState, encodeState, type FallbackState } from './fallback-state.js';
import { classifyFailure } from './error-classification.js';

export type ChildFactory = (name: string) => AgentProvider;
export interface FallbackDeps {
  createChild: ChildFactory;
  now: () => number;
  cooldownMs: number;
}

function log(msg: string): void {
  console.error(`[fallback] ${msg}`);
}

export class FallbackProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private children = new Map<string, AgentProvider>();
  private memoryHook: MemorySessionHookRegistration | null = null;

  constructor(private chain: string[], private deps: FallbackDeps) {
    if (chain.length < 2) throw new Error('FallbackProvider requires at least 2 providers');
  }

  private child(name: string): AgentProvider {
    let c = this.children.get(name);
    if (!c) {
      c = this.deps.createChild(name);
      if (this.memoryHook) c.registerMemorySessionHook(this.memoryHook);
      this.children.set(name, c);
    }
    return c;
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    // Store and forward to every child built now or later.
    this.memoryHook = hook;
    for (const c of this.children.values()) c.registerMemorySessionHook(hook);
  }

  isSessionInvalid(err: unknown): boolean {
    // Defer to whichever child is active; conservative default false.
    return false;
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    // Forward to the child that produced the exchange is not knowable here;
    // recap capture (Task 6) records exchanges. Child archiving happens inside
    // the child query path via its own hook, so nothing to do by default.
  }

  query(input: QueryInput): AgentQuery {
    const state = decodeState(input.continuation);
    const startIndex = this.pickStartIndex(state);
    const self = this;

    let currentChild: AgentQuery | null = null;
    let aborted = false;

    async function* run(): AsyncGenerator<ProviderEvent> {
      // Working copy of state (or fresh from primary).
      const work: FallbackState = state ?? { v: 1, active: self.chain[0], children: {}, cooldownUntil: null };
      for (let i = startIndex; i < self.chain.length; i++) {
        if (aborted) return;
        const name = self.chain[i];
        const childInput: QueryInput = { ...input, continuation: work.children[name] };
        const q = self.child(name).query(childInput);
        currentChild = q;
        let committed = false;
        let failed = false;

        for await (const e of q.events) {
          if (aborted) { q.abort(); return; }
          if (!committed) {
            const cls = classifyFailure(e);
            if (cls) {
              // Advance: record cooldown, log, do NOT emit this failure.
              failed = true;
              const from = name;
              const to = self.chain[i + 1];
              if (to) {
                log(`${from}→${to} classification=${cls}`);
                work.active = to;
                work.cooldownUntil = new Date(self.deps.now() + self.deps.cooldownMs).toISOString();
              } else {
                // Last link failed — surface the failure downstream unchanged.
                log(`${from} failed (classification=${cls}); no further links — surfacing error`);
                yield e;
              }
              break;
            }
          }
          // Not a triggering failure → emit. Rewrite init to carry composite state.
          if (e.type === 'init') {
            work.active = name;
            work.children[name] = e.continuation;
            // Reaching the primary successfully clears the cooldown.
            if (i === 0) work.cooldownUntil = null;
            committed = true;
            yield { type: 'init', continuation: encodeState(work) };
          } else {
            if (e.type === 'result' && e.isError !== true) committed = true;
            yield e;
          }
        }
        if (!failed) return; // committed to this child; turn complete
      }
    }

    return {
      push(message: string) { currentChild?.push(message); },
      end() { currentChild?.end(); },
      abort() { aborted = true; currentChild?.abort(); },
      events: run(),
    };
  }

  private pickStartIndex(state: FallbackState | null): number {
    if (!state) return 0;
    if (state.cooldownUntil && this.deps.now() >= Date.parse(state.cooldownUntil)) return 0; // re-probe primary
    const idx = this.chain.indexOf(state.active);
    return idx >= 0 ? idx : 0;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd container/agent-runner && bun test src/providers/fallback.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/providers/fallback.ts container/agent-runner/src/providers/fallback.test.ts
git commit -m "feat(providers): FallbackProvider advance-on-failure core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: Sticky start, cooldown re-probe, and recovery

**Files:**
- Modify: `container/agent-runner/src/providers/fallback.test.ts` (add tests)
- (Implementation already present from Task 4 — these tests lock the behavior.)

**Interfaces:** unchanged from Task 4.

- [ ] **Step 1: Write the failing tests**

```ts
import { encodeState } from './fallback-state.js';

test('sticky: within cooldown, starts on the fallback link, not primary', async () => {
  let claudeCalled = false;
  const claude = scriptedChild('claude', () => { claudeCalled = true; return [
    { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' },
  ]; });
  const codex = scriptedChild('codex', () => [
    { type: 'init', continuation: 'codex-thread-2' },
    { type: 'result', text: 'sticky codex', isError: false },
  ]);
  const now = 2_000_000;
  const deps = { createChild: (n: string) => ({ claude, codex }[n]!), now: () => now, cooldownMs: 30 * 60 * 1000 };
  const provider = new FallbackProvider(['claude', 'codex'], deps);

  // Prior state: active codex, cooldown still in the future.
  const token = encodeState({ v: 1, active: 'codex', children: { codex: 'codex-thread-2' },
    cooldownUntil: new Date(now + 60_000).toISOString() });

  const events = await collect(provider.query({ prompt: 'again', cwd: '/tmp', continuation: token }));
  expect(claudeCalled).toBe(false); // primary NOT probed while in cooldown
  const result = events.find((e) => e.type === 'result');
  expect(result && 'text' in result ? result.text : null).toBe('sticky codex');
});

test('cooldown expired: re-probes primary; success clears cooldown', async () => {
  const claude = scriptedChild('claude', () => [
    { type: 'init', continuation: 'claude-sess-9' },
    { type: 'result', text: 'claude recovered', isError: false },
  ]);
  const codex = scriptedChild('codex', () => [{ type: 'result', text: 'should not run', isError: false }]);
  const now = 3_000_000;
  const deps = { createChild: (n: string) => ({ claude, codex }[n]!), now: () => now, cooldownMs: 30 * 60 * 1000 };
  const provider = new FallbackProvider(['claude', 'codex'], deps);

  const token = encodeState({ v: 1, active: 'codex', children: { codex: 'codex-thread-2' },
    cooldownUntil: new Date(now - 1000).toISOString() }); // expired

  const events = await collect(provider.query({ prompt: 'back?', cwd: '/tmp', continuation: token }));
  const init = events.find((e) => e.type === 'init');
  expect(init && 'continuation' in init ? decodeState(init.continuation) : null).toMatchObject({
    active: 'claude', cooldownUntil: null,
  });
  const result = events.find((e) => e.type === 'result');
  expect(result && 'text' in result ? result.text : null).toBe('claude recovered');
});

test('all links fail: last child error is surfaced', async () => {
  const err = (name: string): ProviderEvent => ({ type: 'error', message: `${name} down`, retryable: false, classification: 'quota' });
  const claude = scriptedChild('claude', () => [err('claude')]);
  const codex = scriptedChild('codex', () => [err('codex')]);
  const deps = makeDeps({ claude, codex });
  const provider = new FallbackProvider(['claude', 'codex'], deps);

  const events = await collect(provider.query({ prompt: 'x', cwd: '/tmp' }));
  const error = events.find((e) => e.type === 'error');
  expect(error && 'message' in error ? error.message : null).toBe('codex down');
});
```

Add `import { decodeState } from './fallback-state.js';` to the test file if not present.

- [ ] **Step 2: Run to verify (expect PASS — behavior implemented in Task 4)**

Run: `cd container/agent-runner && bun test src/providers/fallback.test.ts`
Expected: PASS (4 tests total). If any fail, fix `pickStartIndex` / cooldown handling in `fallback.ts` until green.

- [ ] **Step 3: Container typecheck**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/providers/fallback.test.ts container/agent-runner/src/providers/fallback.ts
git commit -m "test(providers): sticky + cooldown re-probe + all-fail behavior

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6: Recap injection on switch

**Files:**
- Modify: `container/agent-runner/src/providers/fallback.ts`
- Modify: `container/agent-runner/src/providers/fallback.test.ts`

**Interfaces:**
- The recap is sourced from the wrapper's **own in-memory buffer of observed exchanges** (prompt + last result text), captured as it emits results. This is more robust than parsing the markdown transcript and honors the spec's intent ("immediate continuity on switch"). On a cold container with an empty buffer, no recap is injected (the agent can still read `conversations/` and memory itself).
- Produces: recap is prepended to `childInput.systemContext.instructions` only when switching to a link different from the turn's starting link.

- [ ] **Step 1: Write the failing test**

```ts
test('switch injects a recap into the fallback child systemContext', async () => {
  let codexSawInstructions = '';
  const claude = scriptedChild('claude', () => [
    { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' },
  ]);
  const codex: AgentProvider = {
    supportsNativeSlashCommands: false,
    registerMemorySessionHook() {},
    isSessionInvalid() { return false; },
    query(input: QueryInput): AgentQuery {
      codexSawInstructions = input.systemContext?.instructions ?? '';
      return {
        push() {}, end() {}, abort() {},
        events: (async function* () {
          yield { type: 'init', continuation: 'codex-x' } as ProviderEvent;
          yield { type: 'result', text: 'ok', isError: false } as ProviderEvent;
        })(),
      };
    },
  };
  const deps = makeDeps({ claude, codex });
  const provider = new FallbackProvider(['claude', 'codex'], deps);
  // Seed a prior exchange so the buffer is non-empty.
  provider.onExchangeComplete({ prompt: 'earlier question', result: 'earlier answer', status: 'completed' });

  await collect(provider.query({ prompt: 'current question', cwd: '/tmp' }));
  expect(codexSawInstructions).toContain('continuing an ongoing conversation');
  expect(codexSawInstructions).toContain('earlier question');
  expect(codexSawInstructions).toContain('current question');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container/agent-runner && bun test src/providers/fallback.test.ts -t recap`
Expected: FAIL — `codexSawInstructions` lacks the recap text.

- [ ] **Step 3: Implement recap capture + injection**

In `fallback.ts`, add a bounded buffer and a builder, and inject on switch:

```ts
// add field
private recent: Array<{ prompt: string; result: string }> = [];
private static RECAP_MAX = 3;

// replace onExchangeComplete body
onExchangeComplete(exchange: ProviderExchange): void {
  if (exchange.result && exchange.result.trim()) {
    this.recent.push({ prompt: exchange.prompt, result: exchange.result });
    if (this.recent.length > FallbackProvider.RECAP_MAX) this.recent.shift();
  }
}

private buildRecap(currentPrompt: string): string | null {
  if (this.recent.length === 0) return null;
  const lines = this.recent
    .map((x) => `  User: ${x.prompt.slice(0, 400)}\n  Assistant: ${x.result.slice(0, 400)}`)
    .join('\n');
  return (
    `<system>You're continuing an ongoing conversation that was being handled by another ` +
    `assistant. Recent context:\n${lines}\n  User: ${currentPrompt.slice(0, 400)}\n` +
    `Continue naturally. Full history is in conversations/ and shared memory if you need it.</system>`
  );
}
```

Then in `run()`, when building `childInput` for a link that is **not** the starting link (`i > startIndex`), inject the recap:

```ts
const childInput: QueryInput = { ...input, continuation: work.children[name] };
if (i > startIndex) {
  const recap = self.buildRecap(input.prompt);
  if (recap) {
    childInput.systemContext = {
      ...input.systemContext,
      instructions: `${recap}\n${input.systemContext?.instructions ?? ''}`.trim(),
    };
  }
}
```

Also capture the current turn's result into the buffer as it completes: after `if (e.type === 'result' && e.isError !== true) committed = true;`, add:

```ts
if (e.type === 'result' && e.isError !== true && e.text) {
  self.recent.push({ prompt: input.prompt, result: e.text });
  if (self.recent.length > FallbackProvider.RECAP_MAX) self.recent.shift();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd container/agent-runner && bun test src/providers/fallback.test.ts`
Expected: PASS (all fallback tests).

- [ ] **Step 5: Container typecheck**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/providers/fallback.ts container/agent-runner/src/providers/fallback.test.ts
git commit -m "feat(providers): recap injection on provider switch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Host config wiring

### Task 7: DB migration — `provider_chain` column

**Files:**
- Create: `src/db/migrations/<NNN>_add_provider_chain.ts` (match the existing migration naming/number sequence in `src/db/migrations/`)
- Modify: `src/db/container-configs.ts` (read/write column)
- Test: `src/db/container-configs.provider-chain.test.ts`

**Interfaces:**
- Produces: `container_configs.provider_chain` — nullable `TEXT` holding a JSON array of provider names, or `NULL` (derive default), or the string `'[]'`-encoded single-element array to opt out.
- `getContainerConfig()` row gains `provider_chain: string | null`.

- [ ] **Step 1: Inspect the migration runner + latest number**

Run: `ls src/db/migrations/ | sort | tail -5`
Expected: see the highest-numbered migration; the new file uses the next number and the same `export`/shape as its siblings (open one to copy the pattern).

- [ ] **Step 2: Write the migration**

```ts
// src/db/migrations/<NNN>_add_provider_chain.ts  (follow sibling file's exact export shape)
import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE container_configs ADD COLUMN provider_chain TEXT`);
}
```

- [ ] **Step 3: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
// import the test-db helper this repo uses (mirror an existing container-configs test's setup)
import { getContainerConfig, updateContainerConfig } from './container-configs.js';

describe('provider_chain column', () => {
  it('round-trips a provider chain', () => {
    // set up an in-memory/central test DB per existing container-configs tests, seed a group
    updateContainerConfig('ag-test', { providerChain: ['claude', 'codex', 'opencode'] });
    expect(getContainerConfig('ag-test')?.provider_chain).toBe(JSON.stringify(['claude', 'codex', 'opencode']));
  });
});
```

(Match the existing `container-configs` test harness — reuse its DB bootstrap; do not invent a new one.)

- [ ] **Step 4: Run to verify failure**

Run: `pnpm test src/db/container-configs.provider-chain.test.ts`
Expected: FAIL — `updateContainerConfig` doesn't accept `providerChain` / column missing.

- [ ] **Step 5: Wire the column in `container-configs.ts`**

Add `provider_chain` to the row type and to the `SELECT`/`UPDATE` statements. In the update input, accept `providerChain?: string[] | null` and persist `JSON.stringify(providerChain)` (or `NULL`). Follow the file's existing column-handling pattern exactly.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm test src/db/container-configs.provider-chain.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/ src/db/container-configs.ts src/db/container-configs.provider-chain.test.ts
git commit -m "feat(db): provider_chain column on container_configs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 8: Resolve `providerChain` in `container.json` materialization

**Files:**
- Modify: `src/container-config.ts` (`ContainerConfig` interface + `configFromDb`)
- Create: `src/container-config.provider-chain.test.ts`

**Interfaces:**
- Consumes: `row.provider_chain` (Task 7), `row.provider`.
- Produces: `ContainerConfig.providerChain?: string[]`, resolved by `resolveProviderChain(provider, providerChainJson)`:

| Input | Output |
|-------|--------|
| `provider_chain` JSON array present | that array verbatim |
| `provider_chain` NULL, resolved provider === `claude` | `['claude','codex','opencode']` |
| `provider_chain` NULL, provider ≠ `claude` | `[<provider>]` |
| `provider_chain` = `[<provider>]` (single) | `[<provider>]` (opt out) |

- `DEFAULT_PROVIDER_CHAIN = ['claude', 'codex', 'opencode']` exported constant.
- Invariant: `providerChain[0] === (provider ?? 'claude')`; if a stored chain violates this, prepend the primary and log a warning.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { resolveProviderChain, DEFAULT_PROVIDER_CHAIN } from './container-config.js';

describe('resolveProviderChain', () => {
  it('claude with no override → default chain', () => {
    expect(resolveProviderChain('claude', null)).toEqual(DEFAULT_PROVIDER_CHAIN);
  });
  it('non-claude with no override → single provider', () => {
    expect(resolveProviderChain('opencode', null)).toEqual(['opencode']);
  });
  it('explicit override used verbatim', () => {
    expect(resolveProviderChain('claude', JSON.stringify(['claude', 'opencode']))).toEqual(['claude', 'opencode']);
  });
  it('opt out via single-element chain', () => {
    expect(resolveProviderChain('claude', JSON.stringify(['claude']))).toEqual(['claude']);
  });
  it('primary mismatch is corrected by prepending', () => {
    expect(resolveProviderChain('claude', JSON.stringify(['codex', 'opencode']))).toEqual(['claude', 'codex', 'opencode']);
  });
  it('undefined provider defaults to claude chain', () => {
    expect(resolveProviderChain(undefined, null)).toEqual(DEFAULT_PROVIDER_CHAIN);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/container-config.provider-chain.test.ts`
Expected: FAIL — `resolveProviderChain` not exported.

- [ ] **Step 3: Implement**

```ts
// src/container-config.ts — add near the top-level exports
export const DEFAULT_PROVIDER_CHAIN = ['claude', 'codex', 'opencode'];

export function resolveProviderChain(provider: string | undefined, providerChainJson: string | null): string[] {
  const primary = provider ?? 'claude';
  let chain: string[];
  if (providerChainJson) {
    try {
      const parsed = JSON.parse(providerChainJson) as unknown;
      chain = Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : [];
    } catch {
      chain = [];
    }
  } else {
    chain = primary === 'claude' ? [...DEFAULT_PROVIDER_CHAIN] : [primary];
  }
  if (chain.length === 0) chain = primary === 'claude' ? [...DEFAULT_PROVIDER_CHAIN] : [primary];
  if (chain[0] !== primary) {
    console.warn(`[container-config] providerChain[0] (${chain[0]}) != primary (${primary}); prepending primary`);
    chain = [primary, ...chain.filter((p) => p !== primary)];
  }
  return chain;
}
```

Add `providerChain?: string[];` to the `ContainerConfig` interface, and in `configFromDb` set:

```ts
providerChain: resolveProviderChain(row.provider ?? undefined, row.provider_chain ?? null),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test src/container-config.provider-chain.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/container-config.ts src/container-config.provider-chain.test.ts
git commit -m "feat(host): resolve providerChain for container.json (default + override)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 9: `ncl groups config` flags for the chain

**Files:**
- Modify: `src/cli/resources/groups.ts` (or the `config` sub-resource file it delegates to — inspect first)

**Interfaces:**
- Consumes: `updateContainerConfig({ providerChain })` (Task 7).
- Produces: `ncl groups config update --id <id> --provider-chain claude,codex,opencode` and `--no-fallback` (sets `providerChain` to `[<primary>]`).

- [ ] **Step 1: Inspect the config verb wiring**

Run: `grep -rn "config" src/cli/resources/groups.ts | head`
Expected: find where `config update` parses flags (`--provider`, `--model`, etc.); add the new flags alongside.

- [ ] **Step 2: Add the flags**

In the `config update` handler, parse:
```ts
// --provider-chain claude,codex,opencode
if (flags['provider-chain']) {
  patch.providerChain = String(flags['provider-chain']).split(',').map((s) => s.trim()).filter(Boolean);
}
// --no-fallback → single primary only
if (flags['no-fallback']) {
  patch.providerChain = [currentProvider]; // currentProvider resolved from the existing row
}
```
Follow the file's existing flag-parsing + help-text conventions; add a line to the resource's `help` output describing both flags.

- [ ] **Step 3: Manual verification**

Run:
```bash
ncl groups config update --id <a-test-group> --provider-chain claude,codex,opencode
ncl groups config get --id <a-test-group>
```
Expected: `get` shows the stored chain. Then:
```bash
ncl groups config update --id <a-test-group> --no-fallback
ncl groups config get --id <a-test-group>
```
Expected: chain collapses to the single primary.

- [ ] **Step 4: Commit**

```bash
git add src/cli/resources/groups.ts
git commit -m "feat(ncl): --provider-chain / --no-fallback flags on groups config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Runner dispatch

### Task 10: Build FallbackProvider in the runner when a chain is configured

**Files:**
- Modify: `container/agent-runner/src/config.ts` (`RunnerConfig` + `loadConfig`)
- Modify: `container/agent-runner/src/index.ts` (dispatch)
- Test: `container/agent-runner/src/providers/fallback.factory.test.ts`

**Interfaces:**
- Consumes: `createProvider` (`providers/factory.js`), `FallbackProvider` (`providers/fallback.js`), `ProviderOptions`.
- Produces: a `buildProvider(config, options)` helper deciding single vs composite, exported for test.

- [ ] **Step 1: Extend `RunnerConfig`**

In `container/agent-runner/src/config.ts`, add to the interface and to `loadConfig`'s returned object:
```ts
// interface
providerChain?: string[];
providerChainCooldownMinutes?: number;
// loadConfig()
providerChain: Array.isArray(raw.providerChain) ? (raw.providerChain as string[]) : undefined,
providerChainCooldownMinutes: (raw.providerChainCooldownMinutes as number) || undefined,
```

- [ ] **Step 2: Write the failing test**

```ts
import { test, expect } from 'bun:test';
import { buildProvider } from '../index.js';
import type { RunnerConfig } from '../config.js';

const base: RunnerConfig = {
  provider: 'claude', assistantName: '', groupName: '', agentGroupId: '',
  maxMessagesPerPrompt: 10, mcpServers: {},
};

test('single provider when no chain', () => {
  const p = buildProvider({ ...base }, {});
  expect(p.constructor.name).not.toBe('FallbackProvider');
});

test('FallbackProvider when chain length > 1', () => {
  const p = buildProvider({ ...base, providerChain: ['claude', 'codex', 'opencode'] }, {});
  expect(p.constructor.name).toBe('FallbackProvider');
});
```

(If `buildProvider` is not importable from `index.ts` because `main()` runs on import, extract `buildProvider` into a small exported function guarded so `main()` only runs when invoked as the entrypoint. Mirror how the repo already guards entrypoints, or move `buildProvider` into a new `providers/build-provider.ts` and import it in both `index.ts` and the test.)

- [ ] **Step 3: Run to verify failure**

Run: `cd container/agent-runner && bun test src/providers/fallback.factory.test.ts`
Expected: FAIL — `buildProvider` not found.

- [ ] **Step 4: Implement `buildProvider` and use it in `main()`**

Create `container/agent-runner/src/providers/build-provider.ts`:
```ts
import { createProvider } from './factory.js';
import { FallbackProvider } from './fallback.js';
import type { AgentProvider, ProviderOptions } from './types.js';
import type { RunnerConfig } from '../config.js';

export function buildProvider(config: RunnerConfig, options: ProviderOptions): AgentProvider {
  const chain = config.providerChain;
  if (chain && chain.length > 1) {
    const cooldownMs = (config.providerChainCooldownMinutes ?? 30) * 60 * 1000;
    return new FallbackProvider(chain, {
      createChild: (name) => createProvider(name, options),
      now: () => Date.now(),
      cooldownMs,
    });
  }
  return createProvider(config.provider.toLowerCase(), options);
}
```

In `index.ts`, replace the `const provider = createProvider(providerName, {...})` block (line ~120) with:
```ts
const providerOptions = {
  assistantName: config.assistantName || undefined,
  mcpServers,
  env: { ...process.env },
  additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  model: config.model,
  effort: config.effort,
};
const provider = buildProvider(config, providerOptions);
```
Add `import { buildProvider } from './providers/build-provider.js';`. Update the factory test import path to `../providers/build-provider.js` if you moved it there.

- [ ] **Step 5: Run to verify pass**

Run: `cd container/agent-runner && bun test src/providers/fallback.factory.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Full container test sweep + typecheck**

Run: `cd container/agent-runner && bun test && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (run tsc from repo root)
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/config.ts container/agent-runner/src/index.ts container/agent-runner/src/providers/build-provider.ts container/agent-runner/src/providers/fallback.factory.test.ts
git commit -m "feat(runner): dispatch FallbackProvider when providerChain configured

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Rollout

### Task 11: Rebuild image, enable on dm-with-brad, verify a forced fallback

**Files:** none (operational).

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Rebuild the agent image**

Run: `./container/build.sh`
Expected: image `nanoclaw-agent:latest` builds with the new provider files. (If COPY steps look stale, prune the builder first per CLAUDE.md, then rebuild.)

- [ ] **Step 2: Enable the chain on dm-with-brad**

Run:
```bash
ncl groups config update --id ag-1777506396678-rqprll --provider-chain claude,codex,opencode
ncl groups config get --id ag-1777506396678-rqprll
```
Expected: `get` shows `providerChain: [claude, codex, opencode]`. (The materialized `groups/dm-with-brad/container.json` updates at next spawn.)

- [ ] **Step 3: Force a fallback and observe**

With the Claude subscription still rate-limited (or by temporarily pointing the primary at an exhausted credential), send dm-with-brad a message and watch:
Run: `tail -f logs/nanoclaw.log` and the container stderr (before exit).
Expected: a `[fallback] claude→codex classification=quota` line, and a reply delivered via Codex. Confirm the outbound.db has a produced response.

- [ ] **Step 4: Verify recovery**

After the Claude window resets (or the primary credential is restored), wait past the 30-minute cooldown and send another message.
Expected: the turn re-probes Claude first and, on success, the persisted continuation shows `active: claude, cooldownUntil: null` (decode the `messages` continuation for the session, or observe a `[fallback]` absence + Claude session id in logs).

- [ ] **Step 5: Roll out to the fleet (optional, after dm-with-brad is proven)**

For each remaining claude-primary group you want covered, leave `provider_chain` NULL (the default resolves to the chain automatically at materialization) — no per-group command needed. To opt a group OUT, run `ncl groups config update --id <id> --no-fallback`.

- [ ] **Step 6: Final commit / branch wrap-up**

Run: `git log --oneline provider-fallback-chain` to review the series; then use the `superpowers:finishing-a-development-branch` skill to decide merge/PR. Do not push to `origin` (per project rule, pushes go to `fork`).

---

## Self-Review

**Spec coverage:**
- Composite `FallbackProvider` behind `AgentProvider`, poll loop unchanged → Tasks 4–6, 10. ✓
- State in opaque continuation token → Task 2 codec, used in Task 4. ✓
- Triggers quota/auth/billing (error + isError paths) → Task 3. ✓
- Sticky + 30-min cooldown re-probe → Task 5. ✓
- Recap on switch from recent exchanges → Task 6. ✓
- Global default + per-group override + opt-out → Tasks 7–9. ✓
- Runner dispatch → Task 10. ✓
- Codex validation gate → Task 1. ✓
- All-links-fail surfaces last error → Task 5. ✓
- Visibility logging → `log('[fallback] ...')` in Task 4 (owner-DM flag deferred; noted below). 
- Rollout dm-with-brad first → Task 11. ✓

**Deferred from spec (YAGNI for v1):** the *optional owner-DM on first fallback* is left as loud logging only. Wiring a host-side DM requires the container→host signal path (the container can't DM directly); logging + the `progress` event give visibility now. Add the DM in a follow-up if the logging proves insufficient. This is called out here so it isn't mistaken for an omission.

**Placeholder scan:** no TBD/TODO; every code step shows code; commands have expected output. ✓

**Type consistency:** `FallbackState`, `encodeState`/`decodeState`, `classifyFailure`, `FallbackDeps` (`createChild`/`now`/`cooldownMs`), `buildProvider`, `resolveProviderChain`/`DEFAULT_PROVIDER_CHAIN`, `providerChain` used consistently across Tasks 2–10. ✓

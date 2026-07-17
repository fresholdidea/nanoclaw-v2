import { test, expect } from 'bun:test';
import { FallbackProvider, type FallbackDeps } from './fallback.js';
import { encodeState, decodeState } from './fallback-state.js';
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

test('recap dedup: same exchange arriving via both onExchangeComplete and in-turn result path is injected only once', async () => {
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
          yield { type: 'init', continuation: 'codex-dedup' } as ProviderEvent;
          yield { type: 'result', text: 'ok', isError: false } as ProviderEvent;
        })(),
      };
    },
  };
  const deps = makeDeps({ claude, codex });
  const provider = new FallbackProvider(['claude', 'codex'], deps);

  // Simulate the poll loop calling onExchangeComplete for a prior exchange.
  provider.onExchangeComplete({ prompt: 'dup-prompt', result: 'dup-answer', status: 'completed' });
  // Simulate the same exchange arriving again (as if the in-turn path already pushed it).
  provider.onExchangeComplete({ prompt: 'dup-prompt', result: 'dup-answer', status: 'completed' });

  await collect(provider.query({ prompt: 'new question', cwd: '/tmp' }));

  // 'dup-prompt' must appear exactly once in the injected instructions.
  const occurrences = (codexSawInstructions.match(/dup-prompt/g) ?? []).length;
  expect(occurrences).toBe(1);
});

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

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

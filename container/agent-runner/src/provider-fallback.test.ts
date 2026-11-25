import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_QUOTA_COOLDOWN_MS,
  ProviderChain,
  cooldownUntil,
  isQuotaErrorEvent,
  parseResetHint,
  quotaDeferralNotice,
} from './provider-fallback.js';
import { classifyError } from './providers/codex.js';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    get: (name: string) => values.get(name),
    set: (name: string, until: string) => void values.set(name, until),
    clear: (name: string) => void values.delete(name),
  };
}

// The message Codex returned on 2026-11-24 when the ChatGPT plan ran out.
const CODEX_USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:43 PM.";

describe('classifying quota errors', () => {
  it('classifies the Codex ChatGPT usage-limit message as quota, not auth', () => {
    expect(classifyError(CODEX_USAGE_LIMIT)).toBe('quota');
    expect(classifyError('usage_limit_exceeded')).toBe('quota');
  });

  it('keeps the other Codex classifications', () => {
    expect(classifyError('401 unauthorized')).toBe('auth');
    expect(classifyError('rate limit reached')).toBe('quota');
    expect(classifyError('something else')).toBeUndefined();
  });

  it('treats only non-retryable quota and rate-limit errors as quota events', () => {
    expect(isQuotaErrorEvent({ type: 'error', message: 'x', retryable: false, classification: 'quota' })).toBe(true);
    expect(isQuotaErrorEvent({ type: 'error', message: 'x', retryable: false, classification: 'rate_limit' })).toBe(
      true,
    );
    expect(isQuotaErrorEvent({ type: 'error', message: 'API retry', retryable: true })).toBe(false);
    expect(isQuotaErrorEvent({ type: 'error', message: 'x', retryable: false, classification: 'auth' })).toBe(false);
    expect(isQuotaErrorEvent({ type: 'result', text: null, isError: true })).toBe(false);
  });
});

describe('parseResetHint', () => {
  it('reads an ISO reset from a Claude rate-limit message', () => {
    expect(parseResetHint('Rate limit [five_hour] (resets 2026-11-24T20:43:00.000Z)')?.toISOString()).toBe(
      '2026-11-24T20:43:00.000Z',
    );
  });

  it('reads a wall-clock time later today', () => {
    const now = new Date(2026, 10, 24, 14, 12, 0);
    const at = parseResetHint(CODEX_USAGE_LIMIT, now)!;
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([
      2026, 10, 24, 15, 43,
    ]);
  });

  it('rolls a wall-clock time that already passed to tomorrow', () => {
    const now = new Date(2026, 10, 24, 17, 0, 0);
    const at = parseResetHint('try again at 3:43 PM', now)!;
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([25, 15, 43]);
  });

  it('handles AM and 12 o’clock', () => {
    const now = new Date(2026, 10, 24, 1, 0, 0);
    expect(parseResetHint('try again at 12:05 AM', now)!.getHours()).toBe(0);
    expect(parseResetHint('try again at 12:05 PM', now)!.getHours()).toBe(12);
  });

  it('returns undefined without a time', () => {
    expect(parseResetHint("You've hit your usage limit.")).toBeUndefined();
  });
});

describe('cooldownUntil', () => {
  const now = new Date('2026-11-24T19:00:00.000Z');

  it('uses a sane provider reset', () => {
    const reset = new Date('2026-11-24T20:43:00.000Z');
    expect(cooldownUntil(reset, now)).toEqual(reset);
  });

  it('falls back to the default for a missing, past or absurd reset', () => {
    const fallback = now.getTime() + DEFAULT_QUOTA_COOLDOWN_MS;
    expect(cooldownUntil(undefined, now).getTime()).toBe(fallback);
    expect(cooldownUntil(new Date('2026-11-24T18:00:00.000Z'), now).getTime()).toBe(fallback);
    expect(cooldownUntil(new Date('2027-06-01T00:00:00.000Z'), now).getTime()).toBe(fallback);
  });
});

describe('ProviderChain', () => {
  const now = new Date('2026-11-24T19:00:00.000Z');

  it('selects the primary when nothing is cooling down', () => {
    const chain = new ProviderChain(['codex', 'claude'], memoryStore());
    expect(chain.select(now)).toEqual({ name: 'codex', allExhausted: false });
  });

  it('falls to the next provider while the primary cools down, and back after', () => {
    const store = memoryStore();
    const chain = new ProviderChain(['codex', 'claude'], store);
    chain.markExhausted('codex', new Date('2026-11-24T20:43:00.000Z'), now);
    expect(chain.select(now).name).toBe('claude');
    expect(chain.betterThan('claude', now)).toBeUndefined();

    const later = new Date('2026-11-24T20:44:00.000Z');
    expect(chain.select(later).name).toBe('codex');
    expect(chain.betterThan('claude', later)).toBe('codex');
    // An expired cooldown is cleared from the store.
    expect(store.values.has('codex')).toBe(false);
  });

  it('reports the earliest reset when every provider is out', () => {
    const chain = new ProviderChain(['codex', 'claude'], memoryStore());
    chain.markExhausted('codex', new Date('2026-11-24T22:00:00.000Z'), now);
    chain.markExhausted('claude', new Date('2026-11-24T20:00:00.000Z'), now);
    expect(chain.select(now)).toEqual({
      name: 'codex',
      allExhausted: true,
      earliestReset: new Date('2026-11-24T20:00:00.000Z'),
    });
  });

  it('a single-provider chain waits for its own reset', () => {
    const chain = new ProviderChain(['claude'], memoryStore());
    expect(chain.hasFallbacks).toBe(false);
    chain.markExhausted('claude', undefined, now);
    expect(chain.select(now).allExhausted).toBe(true);
  });

  it('ignores an unreadable stored cooldown', () => {
    const store = memoryStore();
    store.set('codex', 'not a date');
    expect(new ProviderChain(['codex', 'claude'], store).select(now).name).toBe('codex');
  });
});

describe('quotaDeferralNotice', () => {
  it('names the providers and the time, and says not to resend', () => {
    const text = quotaDeferralNotice(['codex', 'claude'], new Date('2026-11-24T20:43:00.000Z'));
    expect(text).toContain('Codex and Claude are both out of quota');
    expect(text).toContain('no need to resend');
  });

  it('reads naturally for one provider', () => {
    expect(quotaDeferralNotice(['claude'], new Date())).toContain('Claude is out of quota');
  });
});

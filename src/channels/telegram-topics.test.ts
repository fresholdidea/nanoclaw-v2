import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createTelegramInboundInterceptor, normalizeTelegramThreadId } from './telegram.js';

describe('normalizeTelegramThreadId', () => {
  it('collapses the chat-level thread id (no topic) to null', () => {
    expect(normalizeTelegramThreadId('telegram:-1001', 'telegram:-1001')).toBeNull();
    expect(normalizeTelegramThreadId('telegram:12345', 'telegram:12345')).toBeNull();
    expect(normalizeTelegramThreadId('telegram:-1001', null)).toBeNull();
  });

  it('passes a forum-topic thread id through', () => {
    expect(normalizeTelegramThreadId('telegram:-1001', 'telegram:-1001:77')).toBe('telegram:-1001:77');
  });
});

describe('inbound interceptor thread ids', () => {
  it('forwards a topic id and nulls the chat-level id before the host sees them', async () => {
    const seen: Array<string | null> = [];
    const hostOnInbound = vi.fn(async (_p: string, t: string | null) => {
      seen.push(t);
    });
    const intercept = createTelegramInboundInterceptor(Promise.resolve(null), hostOnInbound, 'tok', 'telegram');
    const msg = {
      content: JSON.stringify({ text: 'hello' }),
      sender: 'u',
      timestamp: new Date().toISOString(),
    } as never;
    await intercept('telegram:-1001', 'telegram:-1001:77', msg);
    await intercept('telegram:-1001', 'telegram:-1001', msg);
    expect(seen).toEqual(['telegram:-1001:77', null]);
  });
});

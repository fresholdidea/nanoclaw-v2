import { describe, it, expect, beforeEach } from 'bun:test';

import { clearTurnDedup, recordTurnSend, wasSentThisTurn } from './turn-dedup.js';

beforeEach(() => {
  clearTurnDedup();
});

describe('turn-dedup', () => {
  it('returns false for unseen (dest, body) pairs', () => {
    expect(wasSentThisTurn('telegram:123', 'hello')).toBe(false);
  });

  it('matches exact (dest, body) pairs after record', () => {
    recordTurnSend('telegram:123', 'hello');
    expect(wasSentThisTurn('telegram:123', 'hello')).toBe(true);
  });

  it('normalizes whitespace — trims and collapses runs', () => {
    recordTurnSend('telegram:123', '  hello   world  ');
    expect(wasSentThisTurn('telegram:123', 'hello world')).toBe(true);
    expect(wasSentThisTurn('telegram:123', 'hello\n  world')).toBe(true);
  });

  it('treats different destinations as distinct keys', () => {
    recordTurnSend('telegram:123', 'hello');
    expect(wasSentThisTurn('telegram:456', 'hello')).toBe(false);
    expect(wasSentThisTurn('agent:ag-1', 'hello')).toBe(false);
  });

  it('treats different bodies on same destination as distinct', () => {
    recordTurnSend('telegram:123', 'hello');
    expect(wasSentThisTurn('telegram:123', 'hello there')).toBe(false);
  });

  it('clearTurnDedup forgets prior records', () => {
    recordTurnSend('telegram:123', 'hello');
    clearTurnDedup();
    expect(wasSentThisTurn('telegram:123', 'hello')).toBe(false);
  });

  it('treats empty body as no-op (never matches, never records)', () => {
    recordTurnSend('telegram:123', '');
    expect(wasSentThisTurn('telegram:123', '')).toBe(false);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type BrokerConfig, loadBrokerConfig } from './config.js';
import { dayKey, readUsage, refundRequest, reserveRequest, settleTokens } from './ledger.js';

let cfg: BrokerConfig;
const D = '2026-11-04';
const NEXT = '2026-11-05';

beforeEach(() => {
  cfg = {
    ...loadBrokerConfig({}),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-ledger-')),
    dailyRequests: 3,
    groupDailyRequests: 2,
    dailyInputTokens: 100_000,
  };
});

afterEach(() => fs.rmSync(cfg.stateDir, { recursive: true, force: true }));

describe('reserveRequest', () => {
  it('enforces the per-group cap, then the install-wide cap', () => {
    expect(reserveRequest(cfg, 'ag-a', 10_000, D).ok).toBe(true);
    expect(reserveRequest(cfg, 'ag-a', 10_000, D).ok).toBe(true);
    expect(reserveRequest(cfg, 'ag-a', 10_000, D)).toMatchObject({ ok: false, reason: /this agent/ });
    expect(reserveRequest(cfg, 'ag-b', 10_000, D).ok).toBe(true);
    expect(reserveRequest(cfg, 'ag-c', 10_000, D)).toMatchObject({ ok: false, reason: /install-wide/ });
  });

  it('holds each estimate, so queued requests cannot jointly overrun the token cap', () => {
    cfg.dailyRequests = 100;
    cfg.groupDailyRequests = 100;
    expect(reserveRequest(cfg, 'ag-a', 60_000, D).ok).toBe(true);
    expect(reserveRequest(cfg, 'ag-a', 60_000, D)).toMatchObject({ ok: false, reason: /token budget/ });
    expect(readUsage(cfg, D).inputTokens).toBe(60_000);
  });

  it('starts fresh on a new day', () => {
    reserveRequest(cfg, 'ag-a', 1, D);
    reserveRequest(cfg, 'ag-a', 1, D);
    expect(reserveRequest(cfg, 'ag-a', 1, NEXT).ok).toBe(true);
  });

  it('fails closed on a corrupt ledger', () => {
    fs.writeFileSync(path.join(cfg.stateDir, 'usage.json'), '{not json');
    expect(reserveRequest(cfg, 'ag-a', 1, D)).toMatchObject({ ok: false, reason: /unreadable/ });
  });
});

describe('settleTokens and refundRequest', () => {
  it('replaces the estimate with the real count', () => {
    reserveRequest(cfg, 'ag-a', 30_000, D);
    settleTokens(cfg, 'ag-a', 30_000, 12_345, 400, D);
    expect(readUsage(cfg, D)).toMatchObject({
      requests: 1,
      inputTokens: 12_345,
      outputTokens: 400,
      groups: { 'ag-a': { requests: 1, inputTokens: 12_345 } },
    });
  });

  it('gives a reservation back', () => {
    reserveRequest(cfg, 'ag-a', 30_000, D);
    refundRequest(cfg, 'ag-a', 30_000, D);
    expect(readUsage(cfg, D)).toMatchObject({ requests: 0, inputTokens: 0, groups: { 'ag-a': { requests: 0 } } });
  });

  it("never touches the next day's ledger when a job crosses midnight", () => {
    reserveRequest(cfg, 'ag-a', 10_000, D);
    reserveRequest(cfg, 'ag-a', 10_000, NEXT);
    reserveRequest(cfg, 'ag-a', 10_000, NEXT);
    settleTokens(cfg, 'ag-a', 10_000, 999, 1, D);
    refundRequest(cfg, 'ag-a', 10_000, D);
    expect(readUsage(cfg, NEXT)).toMatchObject({ requests: 2, inputTokens: 20_000 });
    expect(reserveRequest(cfg, 'ag-a', 1, NEXT)).toMatchObject({ ok: false, reason: /this agent/ });
  });
});

describe('dayKey', () => {
  it('uses the given timezone', () => {
    const lateEvening = new Date('2026-11-05T03:30:00Z'); // 22:30 in New York
    expect(dayKey(lateEvening, 'America/New_York')).toBe(D);
    expect(dayKey(lateEvening, 'UTC')).toBe(NEXT);
  });
});

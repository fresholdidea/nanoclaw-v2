import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type BrokerConfig, loadBrokerConfig } from './config.js';
import { dayKey, readUsage, recordTokens, reserveRequest } from './ledger.js';

let cfg: BrokerConfig;

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
    expect(reserveRequest(cfg, 'ag-a', 10_000, '2026-11-04').ok).toBe(true);
    expect(reserveRequest(cfg, 'ag-a', 10_000, '2026-11-04').ok).toBe(true);
    expect(reserveRequest(cfg, 'ag-a', 10_000, '2026-11-04')).toMatchObject({ ok: false, reason: /this agent/ });
    expect(reserveRequest(cfg, 'ag-b', 10_000, '2026-11-04').ok).toBe(true);
    expect(reserveRequest(cfg, 'ag-c', 10_000, '2026-11-04')).toMatchObject({ ok: false, reason: /install-wide/ });
  });

  it('refuses when the estimate would cross the token budget, counting real usage', () => {
    recordTokens(cfg, 'ag-a', 95_000, 500, '2026-11-04');
    expect(reserveRequest(cfg, 'ag-a', 10_000, '2026-11-04')).toMatchObject({ ok: false, reason: /token budget/ });
    expect(readUsage(cfg, '2026-11-04')).toMatchObject({ requests: 0, inputTokens: 95_000, outputTokens: 500 });
  });

  it('starts fresh on a new day', () => {
    reserveRequest(cfg, 'ag-a', 1, '2026-11-04');
    reserveRequest(cfg, 'ag-a', 1, '2026-11-04');
    expect(reserveRequest(cfg, 'ag-a', 1, '2026-11-05').ok).toBe(true);
  });

  it('fails closed on a corrupt ledger', () => {
    fs.writeFileSync(path.join(cfg.stateDir, 'usage.json'), '{not json');
    expect(reserveRequest(cfg, 'ag-a', 1, '2026-11-04')).toMatchObject({ ok: false, reason: /unreadable/ });
  });
});

describe('dayKey', () => {
  it('uses the given timezone', () => {
    const lateEvening = new Date('2026-11-05T03:30:00Z'); // 22:30 in New York
    expect(dayKey(lateEvening, 'America/New_York')).toBe('2026-11-04');
    expect(dayKey(lateEvening, 'UTC')).toBe('2026-11-05');
  });
});

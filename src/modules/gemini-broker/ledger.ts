/**
 * Daily budget for the Gemini broker: request counts (install-wide and per
 * agent group) and input tokens, keyed by the install-timezone date.
 *
 * A reservation holds the request's token estimate until the run settles, so
 * queued jobs cannot jointly overrun the token cap. Settling and refunding
 * only touch the reservation's own day: a job that finishes after midnight
 * must never overwrite the new day's ledger.
 *
 * The host is a single process holding the host-instance lease, so a plain
 * read-modify-write of one JSON file is enough; writes are atomic renames.
 */
import fs from 'fs';
import path from 'path';

import type { BrokerConfig } from './config.js';

export interface GroupUsage {
  requests: number;
  inputTokens: number;
}

export interface DayUsage {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  groups: Record<string, GroupUsage>;
  /** Set (never persisted) when usage.json exists but cannot be parsed. */
  corrupt?: true;
}

/** Fixed per-request overhead: agy's own system prompt and tool schemas (7-16K measured 2026-11-04). */
export const BASE_REQUEST_TOKENS = 16_000;

export function dayKey(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function estimateTokens(totalBytes: number, promptChars: number): number {
  return BASE_REQUEST_TOKENS + Math.ceil(totalBytes / 4) + Math.ceil(promptChars / 4);
}

function usagePath(cfg: BrokerConfig): string {
  return path.join(cfg.stateDir, 'usage.json');
}

type Stored = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'ok'; usage: DayUsage };

function readStored(cfg: BrokerConfig): Stored {
  let raw: string;
  try {
    raw = fs.readFileSync(usagePath(cfg), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  let parsed: Partial<DayUsage>;
  try {
    parsed = JSON.parse(raw) as Partial<DayUsage>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- any parse failure means a corrupt ledger
  } catch {
    return { kind: 'corrupt' };
  }
  if (typeof parsed.day !== 'string') return { kind: 'corrupt' };
  return {
    kind: 'ok',
    usage: {
      day: parsed.day,
      requests: Number(parsed.requests) || 0,
      inputTokens: Number(parsed.inputTokens) || 0,
      outputTokens: Number(parsed.outputTokens) || 0,
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
    },
  };
}

/** Today's usage: zeroes if nothing is recorded for `day`; `corrupt` if the file is unreadable. */
export function readUsage(cfg: BrokerConfig, day: string): DayUsage {
  const fresh: DayUsage = { day, requests: 0, inputTokens: 0, outputTokens: 0, groups: {} };
  const stored = readStored(cfg);
  if (stored.kind === 'corrupt') return { ...fresh, corrupt: true };
  if (stored.kind === 'missing' || stored.usage.day !== day) return fresh;
  return stored.usage;
}

function writeUsage(cfg: BrokerConfig, usage: DayUsage): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const target = usagePath(cfg);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(usage, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Apply `fn` to the stored ledger only if it is for `day`; otherwise leave the file alone. */
function adjustSameDay(cfg: BrokerConfig, day: string, fn: (usage: DayUsage) => void): void {
  const stored = readStored(cfg);
  if (stored.kind !== 'ok' || stored.usage.day !== day) return;
  fn(stored.usage);
  writeUsage(cfg, stored.usage);
}

function groupOf(usage: DayUsage, agentGroupId: string): GroupUsage {
  const group = usage.groups[agentGroupId] ?? { requests: 0, inputTokens: 0 };
  usage.groups[agentGroupId] = group;
  return group;
}

export type ReserveResult = { ok: true } | { ok: false; reason: string };

/**
 * Count one request and hold its token estimate against today's caps, or
 * refuse it. A refused request changes nothing.
 */
export function reserveRequest(
  cfg: BrokerConfig,
  agentGroupId: string,
  estimatedTokens: number,
  day: string,
): ReserveResult {
  const usage = readUsage(cfg, day);
  if (usage.corrupt) {
    return { ok: false, reason: 'the broker usage ledger on the host is unreadable; the operator needs to repair it' };
  }
  const group = usage.groups[agentGroupId] ?? { requests: 0, inputTokens: 0 };
  if (usage.requests >= cfg.dailyRequests) {
    return { ok: false, reason: `the install-wide daily cap of ${cfg.dailyRequests} Gemini requests is used up` };
  }
  if (group.requests >= cfg.groupDailyRequests) {
    return { ok: false, reason: `this agent's daily cap of ${cfg.groupDailyRequests} Gemini requests is used up` };
  }
  if (usage.inputTokens + estimatedTokens > cfg.dailyInputTokens) {
    return {
      ok: false,
      reason: `today's input-token budget (${cfg.dailyInputTokens.toLocaleString('en-US')}, counting queued requests) would be exceeded; send fewer or smaller files`,
    };
  }
  usage.requests += 1;
  usage.inputTokens += estimatedTokens;
  usage.groups[agentGroupId] = { requests: group.requests + 1, inputTokens: group.inputTokens + estimatedTokens };
  writeUsage(cfg, usage);
  return { ok: true };
}

/** Replace a reservation's estimate with the real counts. A no-op once its day has passed. */
export function settleTokens(
  cfg: BrokerConfig,
  agentGroupId: string,
  estimatedTokens: number,
  inputTokens: number,
  outputTokens: number,
  day: string,
): void {
  adjustSameDay(cfg, day, (usage) => {
    const group = groupOf(usage, agentGroupId);
    usage.inputTokens = Math.max(0, usage.inputTokens - estimatedTokens + inputTokens);
    usage.outputTokens += outputTokens;
    group.inputTokens = Math.max(0, group.inputTokens - estimatedTokens + inputTokens);
  });
}

/** Give a reservation back: the request never reached Gemini. A no-op once its day has passed. */
export function refundRequest(cfg: BrokerConfig, agentGroupId: string, estimatedTokens: number, day: string): void {
  adjustSameDay(cfg, day, (usage) => {
    const group = groupOf(usage, agentGroupId);
    usage.requests = Math.max(0, usage.requests - 1);
    usage.inputTokens = Math.max(0, usage.inputTokens - estimatedTokens);
    group.requests = Math.max(0, group.requests - 1);
    group.inputTokens = Math.max(0, group.inputTokens - estimatedTokens);
  });
}

export interface RequestLogEntry {
  id: string;
  at: string;
  agentGroupId: string;
  folder: string;
  files: number;
  bytes: number;
  model: string;
  outcome: 'ok' | 'failed' | 'refused' | 'interrupted' | 'withheld';
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationSec?: number;
}

/** Append-only metadata log (no prompts, no file contents) for the steward's usage ledger. */
export function appendRequestLog(cfg: BrokerConfig, entry: RequestLogEntry): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(cfg.stateDir, 'requests.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

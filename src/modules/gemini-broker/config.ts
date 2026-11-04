/**
 * Gemini broker configuration, read from `.env` on every request so an
 * operator can tighten a cap without restarting the host.
 */
import crypto from 'crypto';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';

export type GeminiEffort = 'low' | 'medium' | 'high';
export const GEMINI_EFFORTS: readonly GeminiEffort[] = ['low', 'medium', 'high'];

export interface BrokerConfig {
  enabled: boolean;
  /** The Antigravity CLI. `gemini` itself no longer signs in headless. */
  agyBin: string;
  /** Brad's interactive sign-in, copied into the broker home when it changes. */
  sourceTokenPath: string;
  /** Host-only state: usage ledger, request log, pending jobs, broker HOME. */
  stateDir: string;
  /** Isolated HOME for agy: no MCP servers, no skills, deny-everything rules. */
  homeDir: string;
  /** Per-request workspaces. Under the OS temp dir so no `.git` ancestor widens agy's workspace. */
  workRoot: string;
  /** Agent folders allowed to use the broker, or '*' for all. */
  groups: '*' | string[];
  modelPrefix: string;
  dailyRequests: number;
  groupDailyRequests: number;
  dailyInputTokens: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPromptChars: number;
  timeoutSec: number;
  maxQueue: number;
}

const KEYS = [
  'GEMINI_BROKER_ENABLED',
  'GEMINI_BROKER_AGY_BIN',
  'GEMINI_BROKER_SOURCE_TOKEN',
  'GEMINI_BROKER_GROUPS',
  'GEMINI_BROKER_MODEL_PREFIX',
  'GEMINI_BROKER_DAILY_REQUESTS',
  'GEMINI_BROKER_GROUP_DAILY_REQUESTS',
  'GEMINI_BROKER_DAILY_INPUT_TOKENS',
  'GEMINI_BROKER_MAX_FILES',
  'GEMINI_BROKER_MAX_FILE_BYTES',
  'GEMINI_BROKER_MAX_TOTAL_BYTES',
  'GEMINI_BROKER_TIMEOUT_SEC',
];

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadBrokerConfig(env: Record<string, string> = readEnvFile(KEYS)): BrokerConfig {
  const stateDir = path.join(DATA_DIR, 'gemini-broker');
  const groupsRaw = (env.GEMINI_BROKER_GROUPS ?? '*').trim();
  const groups =
    groupsRaw === '' || groupsRaw === '*'
      ? ('*' as const)
      : groupsRaw
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean);
  return {
    enabled: !/^(0|false|no|off)$/i.test((env.GEMINI_BROKER_ENABLED ?? '').trim()),
    agyBin: env.GEMINI_BROKER_AGY_BIN?.trim() || path.join(os.homedir(), '.local', 'bin', 'agy'),
    sourceTokenPath:
      env.GEMINI_BROKER_SOURCE_TOKEN?.trim() ||
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    stateDir,
    homeDir: path.join(stateDir, 'home'),
    // Install-specific: startup sweeps orphan workspaces, and another copy's must survive it.
    workRoot: path.join(
      os.tmpdir(),
      `nanoclaw-gemini-broker-${crypto.createHash('sha256').update(DATA_DIR).digest('hex').slice(0, 8)}`,
    ),
    groups,
    modelPrefix: env.GEMINI_BROKER_MODEL_PREFIX?.trim() || 'gemini-3.8-flash',
    dailyRequests: int(env.GEMINI_BROKER_DAILY_REQUESTS, 40, 0, 10_000),
    groupDailyRequests: int(env.GEMINI_BROKER_GROUP_DAILY_REQUESTS, 15, 0, 10_000),
    dailyInputTokens: int(env.GEMINI_BROKER_DAILY_INPUT_TOKENS, 8_000_000, 0, 1_000_000_000),
    maxFiles: int(env.GEMINI_BROKER_MAX_FILES, 20, 0, 200),
    maxFileBytes: int(env.GEMINI_BROKER_MAX_FILE_BYTES, 3 * 1024 * 1024, 1, 100 * 1024 * 1024),
    maxTotalBytes: int(env.GEMINI_BROKER_MAX_TOTAL_BYTES, 3 * 1024 * 1024, 1, 200 * 1024 * 1024),
    maxPromptChars: 12_000,
    timeoutSec: int(env.GEMINI_BROKER_TIMEOUT_SEC, 600, 30, 3600),
    maxQueue: 8,
  };
}

export function modelFor(cfg: BrokerConfig, effort: GeminiEffort): string {
  return `${cfg.modelPrefix}-${effort}`;
}

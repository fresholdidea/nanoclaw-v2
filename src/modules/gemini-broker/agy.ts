/**
 * Run the Antigravity CLI (`agy`) headless for one broker request.
 *
 * agy is a full agent with terminal, file, browser and MCP tools, and Brad's
 * own config loads eleven MCP servers (ad accounts, HubSpot, Plane, n8n) and
 * allows non-workspace reads. A document with planted instructions must not
 * be able to reach any of that, so every run gets:
 *
 *   - its own HOME (data/gemini-broker/home), scrubbed before and after each
 *     run down to a copy of the sign-in token and agy's own binaries, with a
 *     settings.json that denies commands, MCP, URL reads/actuation and every
 *     file write; agy auto-denies anything that would need an interactive
 *     approval, so non-workspace reads fail too, and nothing one group's run
 *     leaves behind (conversations, memories) reaches the next;
 *   - a fresh workspace under the OS temp dir with only the requested files,
 *     so no `.git` ancestor turns the NanoClaw checkout into its workspace;
 *   - `--sandbox` and `--disable-slash-commands` (which also keeps the browser
 *     off), a bare PATH and env, and its own process group so a shutdown or
 *     timeout kills the whole tree.
 *
 * Verified 2026-11-04 against agy 1.1.13: `whoami`, `curl`, `ls`/`grep`
 * outside the workspace and outside reads are refused; the browser is off;
 * Google search grounding still works (it is server-side); the refresh token
 * does not rotate, so the broker's copy and the operator's never invalidate
 * each other.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { BrokerConfig } from './config.js';
import { BrokerError } from './paths.js';

const DENY_RULES = ['command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)', 'write_file(*)'];
const TOKEN_FILE = 'antigravity-oauth-token';
/** What survives a scrub: the token copy and agy's own binaries and update state. */
const KEEP = new Set([TOKEN_FILE, 'bin', 'builtin', 'updater', 'installation_id']);

function agyStateDir(cfg: BrokerConfig): string {
  return path.join(cfg.homeDir, '.gemini', 'antigravity-cli');
}

function removeAllExcept(dir: string, keep: ReadonlySet<string>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of entries) {
    if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Delete everything agy wrote outside its token and binaries: conversations, caches, memories, logs. */
export function scrubBrokerHome(cfg: BrokerConfig): void {
  removeAllExcept(cfg.homeDir, new Set(['.gemini']));
  removeAllExcept(path.join(cfg.homeDir, '.gemini'), new Set(['antigravity-cli']));
  removeAllExcept(agyStateDir(cfg), KEEP);
}

/**
 * Create the isolated HOME, scrub it, (re)write its deny rules, and refresh
 * the token copy when Brad's interactive sign-in is newer.
 */
export function prepareBrokerHome(cfg: BrokerConfig): void {
  const stateDir = agyStateDir(cfg);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cfg.homeDir, 0o700);
  scrubBrokerHome(cfg);

  const settings = { allowNonWorkspaceAccess: false, permissions: { allow: [], ask: [], deny: DENY_RULES } };
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });

  const source = fs.statSync(cfg.sourceTokenPath, { throwIfNoEntry: false });
  if (!source) throw new BrokerError(notSignedIn());
  const target = path.join(stateDir, TOKEN_FILE);
  const current = fs.statSync(target, { throwIfNoEntry: false });
  if (!current || source.mtimeMs > current.mtimeMs) {
    fs.copyFileSync(cfg.sourceTokenPath, target);
    fs.chmodSync(target, 0o600);
  }
}

export function notSignedIn(): string {
  return 'the host is not signed in to Antigravity (no ~/.gemini/antigravity-cli/antigravity-oauth-token); Brad needs to run `agy` once on the Mac and sign in';
}

/**
 * Secret strings in the sign-in token files (the operator's and the
 * broker's copy). An answer that contains one is withheld: the token sits in
 * agy's HOME, and only agy's own workspace rule keeps Gemini from reading it.
 */
export function tokenSecrets(cfg: BrokerConfig): string[] {
  const out = new Set<string>();
  for (const file of [cfg.sourceTokenPath, path.join(agyStateDir(cfg), TOKEN_FILE)]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or unparsable file contributes nothing
    } catch {
      continue;
    }
    const walk = (v: unknown): void => {
      if (typeof v === 'string' && v.length >= 24) out.add(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(parsed);
  }
  return [...out];
}

/** True if `text` contains any secret, or a 24-character stretch of one. */
export function leaksSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => {
    for (let i = 0; i + 24 <= s.length; i += 12) if (text.includes(s.slice(i, i + 24))) return true;
    return false;
  });
}

export interface AgyResult {
  status: string;
  response: string;
  conversationId?: string;
  inputTokens: number;
  outputTokens: number;
  durationSec?: number;
  deniedActions: string[];
}

export function parseAgyOutput(stdout: string): AgyResult {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new BrokerError('Gemini returned output the broker could not parse');
  }
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const denied = Array.isArray(data.denied_actions)
    ? data.denied_actions.map((d) => String((d as Record<string, unknown>)?.action ?? 'unknown'))
    : [];
  return {
    status: String(data.status ?? ''),
    response: typeof data.response === 'string' ? data.response : '',
    conversationId: typeof data.conversation_id === 'string' ? data.conversation_id : undefined,
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: (Number(usage.output_tokens) || 0) + (Number(usage.thinking_tokens) || 0),
    durationSec: typeof data.duration_seconds === 'number' ? data.duration_seconds : undefined,
    deniedActions: denied,
  };
}

/** Thrown when agy produced no answer at all: the request never reached Gemini, so it is refunded. */
export class AgyNoOutputError extends BrokerError {}

const AUTH_HINT = /(sign[ -]?in|log[ -]?in|authenticat|oauth|unauthori[sz]ed|invalid_grant|credential)/i;

function tail(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

export interface RunAgyOptions {
  cwd: string;
  prompt: string;
  model: string;
  signal?: AbortSignal;
}

/** Spawn agy once. Resolves with the parsed result; rejects with a BrokerError once the process tree has exited. */
export function runAgy(cfg: BrokerConfig, opts: RunAgyOptions): Promise<AgyResult> {
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'json',
    '--print-timeout',
    `${cfg.timeoutSec}s`,
    '--model',
    opts.model,
    '--sandbox',
    '--disable-slash-commands',
  ];
  const env: Record<string, string> = {
    HOME: cfg.homeDir,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    USER: os.userInfo().username,
  };

  return new Promise((resolve, reject) => {
    // Own process group: a kill reaches agy's helpers too.
    const child = spawn(cfg.agyBin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let stopReason: string | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
        // eslint-disable-next-line no-catch-all/no-catch-all -- the group may already be gone
      } catch {
        child.kill(signal);
      }
    };
    const stop = (reason: string) => {
      if (stopReason) return;
      stopReason = reason;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        // Settle even if 'close' never fires, so the worker cannot hang.
        giveUpTimer = setTimeout(() => finish(() => reject(new AgyNoOutputError(reason))), 5_000);
      }, 5_000);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      if (killTimer) clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    // agy enforces --print-timeout itself; this is the backstop for a hang.
    const hardStop = setTimeout(
      () => stop(`Gemini did not finish within ${cfg.timeoutSec + 60}s`),
      (cfg.timeoutSec + 60) * 1000,
    );
    const onAbort = () => stop('the host shut down while Gemini was running');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(() =>
        reject(
          new AgyNoOutputError(
            code === 'ENOENT'
              ? `agy is not installed at ${cfg.agyBin} on the host`
              : `agy could not start (${code ?? err.message})`,
          ),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        if (stopReason) return reject(new AgyNoOutputError(stopReason));
        if (stdout.trim() === '') {
          const detail = tail(stderr) || `exit code ${code}`;
          return reject(
            new AgyNoOutputError(
              AUTH_HINT.test(stderr)
                ? `the host's Antigravity sign-in has expired or was refused; Brad needs to run \`agy\` once on the Mac and sign in (${detail})`
                : `Gemini produced no answer (${detail})`,
            ),
          );
        }
        try {
          resolve(parseAgyOutput(stdout));
          // eslint-disable-next-line no-catch-all/no-catch-all -- rejection is the rethrow
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

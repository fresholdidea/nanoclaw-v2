/**
 * Run the Antigravity CLI (`agy`) headless for one broker request.
 *
 * agy is a full agent with terminal, file, browser and MCP tools, and Brad's
 * own config loads eleven MCP servers (ad accounts, HubSpot, Plane, n8n) and
 * allows non-workspace reads. A document with planted instructions must not
 * be able to reach any of that, so every run gets:
 *
 *   - its own HOME (data/gemini-broker/home), holding only a copy of the
 *     sign-in token and a settings.json that denies commands, MCP, URL
 *     reads/actuation and every file write; agy auto-denies anything that
 *     would need an interactive approval, so non-workspace reads fail too;
 *   - a fresh workspace under the OS temp dir with only the requested files,
 *     so no `.git` ancestor turns the NanoClaw checkout into its workspace;
 *   - `--sandbox` and `--disable-slash-commands`, a bare PATH and env.
 *
 * Verified 2026-11-04 against agy 1.1.13: `whoami`/`curl` and outside reads
 * are refused; Google search grounding still works (it is server-side).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { BrokerConfig } from './config.js';
import { BrokerError } from './paths.js';

const DENY_RULES = ['command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)', 'write_file(*)'];

/** Per-conversation artifacts agy keeps in its home; they hold request content. */
const CONVERSATION_DIRS = ['conversations', 'annotations', 'presence', 'brain'];

function agyStateDir(cfg: BrokerConfig): string {
  return path.join(cfg.homeDir, '.gemini', 'antigravity-cli');
}

/**
 * Create the isolated HOME, (re)write its deny rules, and refresh the token
 * copy when Brad's interactive sign-in is newer. agy rewrites settings.json
 * on start, so the rules are written before every run.
 */
export function prepareBrokerHome(cfg: BrokerConfig): void {
  const stateDir = agyStateDir(cfg);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cfg.homeDir, 0o700);

  const settings = { allowNonWorkspaceAccess: false, permissions: { allow: [], ask: [], deny: DENY_RULES } };
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });

  const source = fs.statSync(cfg.sourceTokenPath, { throwIfNoEntry: false });
  if (!source) {
    throw new BrokerError(
      'the host is not signed in to Antigravity (no ~/.gemini/antigravity-cli/antigravity-oauth-token); Brad needs to run `agy` once on the Mac and sign in',
    );
  }
  const target = path.join(stateDir, 'antigravity-oauth-token');
  const current = fs.statSync(target, { throwIfNoEntry: false });
  if (!current || source.mtimeMs > current.mtimeMs) {
    fs.copyFileSync(cfg.sourceTokenPath, target);
    fs.chmodSync(target, 0o600);
  }
}

/** Remove one run's conversation artifacts, plus any leftovers older than a day. */
export function pruneConversations(cfg: BrokerConfig, conversationId: string | undefined, now = Date.now()): void {
  const stateDir = agyStateDir(cfg);
  for (const dir of CONVERSATION_DIRS) {
    const full = path.join(stateDir, dir);
    let entries: string[];
    try {
      entries = fs.readdirSync(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of entries) {
      const entryPath = path.join(full, name);
      const mine = conversationId !== undefined && name.startsWith(conversationId);
      const stale = (fs.lstatSync(entryPath, { throwIfNoEntry: false })?.mtimeMs ?? now) < now - 24 * 3600 * 1000;
      if (mine || stale) fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }
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

/** Spawn agy once. Resolves with the parsed result; rejects with a BrokerError. */
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
    const child = spawn(cfg.agyBin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    };
    // agy enforces --print-timeout itself; this is the backstop for a hang.
    const hardStop = setTimeout(
      () => {
        kill();
        finish(() => reject(new BrokerError(`Gemini did not finish within ${cfg.timeoutSec + 60}s`)));
      },
      (cfg.timeoutSec + 60) * 1000,
    );
    const onAbort = () => {
      kill();
      finish(() => reject(new BrokerError('the host shut down while Gemini was running')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(() =>
        reject(
          new BrokerError(
            code === 'ENOENT'
              ? `agy is not installed at ${cfg.agyBin} on the host`
              : `agy could not start (${code ?? err.message})`,
          ),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        if (stdout.trim() === '') {
          const detail = tail(stderr) || `exit code ${code}`;
          if (AUTH_HINT.test(stderr)) {
            reject(
              new BrokerError(
                `the host's Antigravity sign-in has expired or was refused; Brad needs to run \`agy\` once on the Mac and sign in (${detail})`,
              ),
            );
          } else {
            reject(new BrokerError(`Gemini produced no answer (${detail})`));
          }
          return;
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

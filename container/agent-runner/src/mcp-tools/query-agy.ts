/**
 * query_agy: spawn an ephemeral `agy -p` subprocess and return its final
 * stdout. Lets a Claude-backed orchestrator delegate bulk/draft work to
 * agy on a per-call basis without flipping the whole group's provider.
 *
 * Single-shot only. Each call:
 *   - Spawns a fresh agy subprocess (no --conversation re-use).
 *   - Runs in a unique cwd under SUBQUERY_ROOT so the cwd→conversation
 *     cache key doesn't collide with the main agy provider's cwd
 *     (when both are active in the same container).
 *   - Captures stdout/stderr; returns trimmed stdout as the tool result.
 *
 * Known issue: agy emits narration/tool-call chatter to stdout alongside
 * its final answer. The result text will contain both. The orchestrator
 * model is expected to skim past the narration. This matches the agy
 * provider's own behavior — fixing it cleanly is a separate body of work.
 *
 * Enablement: this tool requires the agy binary + ~/.gemini state to be
 * mounted into the container. For groups whose `provider` is "agy", the
 * provider-container registry already adds those mounts. Otherwise, set
 * `enableAgyTooling: true` in the group's container.json.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[query-agy] ${msg}`);
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // matches agy provider's --print-timeout 15m
const HARD_TIMEOUT_CEILING_MS = 30 * 60 * 1000;

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({
  content: [{ type: 'text' as const, text: `Error: ${text}` }],
  isError: true,
});

function getAgyBin(): string {
  return process.env.AGY_BIN || 'agy';
}

function getSubqueryRoot(): string {
  return process.env.AGY_SUBQUERY_ROOT || '/workspace/agent/.agy-subquery';
}

function makeSubqueryCwd(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(getSubqueryRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function agyBinExists(agyBin: string): boolean {
  if (path.isAbsolute(agyBin)) return fs.existsSync(agyBin);
  return true;
}

export const queryAgy: McpToolDefinition = {
  tool: {
    name: 'query_agy',
    description:
      `Run a one-shot query against an ephemeral agy (Google Antigravity) subprocess and return its final stdout. ` +
      `Use this to delegate bulk drafting, broad research, or cheap exploratory work to agy without switching this group's main provider. ` +
      `Each call is independent — no conversation re-use, no shared state with the main agent. ` +
      `Returns rough stdout including agy's tool-call narration; the final answer is at the end. ` +
      `Times out after 15 minutes by default.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description:
            'The full prompt to send to agy. Be explicit — agy has no context from this conversation.',
        },
        timeoutMs: {
          type: 'number',
          description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}). Hard ceiling: 30 minutes.`,
        },
      },
      required: ['prompt'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    if (!prompt || typeof prompt !== 'string') return err('prompt is required (string)');

    const agyBin = getAgyBin();
    if (!agyBinExists(agyBin)) {
      return err(
        `agy binary not found at ${agyBin}. This group is not enabled for query_agy — set enableAgyTooling: true in container.json.`,
      );
    }

    const requestedTimeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(1000, Math.min(requestedTimeout, HARD_TIMEOUT_CEILING_MS));

    const cwd = makeSubqueryCwd();
    log(`spawn agy -p (cwd=${cwd}, timeout=${timeoutMs}ms, prompt=${prompt.slice(0, 80).replace(/\n/g, ' ')}…)`);

    return await new Promise((resolve) => {
      const printTimeout = `${Math.ceil(timeoutMs / 1000)}s`;
      const proc = spawn(
        agyBin,
        ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', printTimeout, '--add-dir', cwd],
        { cwd, env: { ...process.env }, detached: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;

      let settled = false;
      const settle = (result: ReturnType<typeof ok> | ReturnType<typeof err>) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const killTimer = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        // Resolve immediately on timeout — orphaned grandchildren may hold
        // the stdio pipes open and delay the 'close' event indefinitely.
        const stdoutSoFar = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        settle(err(`agy timed out after ${timeoutMs}ms. Partial stdout:\n${stdoutSoFar.slice(-2000)}`));
      }, timeoutMs);

      proc.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
      proc.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

      proc.on('error', (e) => {
        clearTimeout(killTimer);
        settle(err(`failed to spawn agy: ${e.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(killTimer);
        if (settled) return; // already resolved (e.g. by timeout)
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

        if (killed) {
          settle(err(`agy timed out after ${timeoutMs}ms. Partial stdout:\n${stdout.slice(-2000)}`));
          return;
        }
        if (code !== 0) {
          settle(err(`agy exited ${code}. stderr: ${stderr.slice(0, 1000)}`));
          return;
        }
        if (!stdout) {
          settle(err(`agy returned empty stdout (exit 0). stderr: ${stderr.slice(0, 500)}`));
          return;
        }
        settle(ok(stdout));
      });
    });
  },
};

registerTools([queryAgy]);

/**
 * query_opencode: spawn an ephemeral `opencode run` subprocess and return its
 * final stdout. Lets a Claude-backed orchestrator delegate bulk/draft work to
 * an OpenRouter-routed model (DeepSeek, etc.) on a per-call basis without
 * flipping the whole group's provider.
 *
 * Single-shot only. Each call:
 *   - Spawns a fresh `opencode run` subprocess (no --continue, no session reuse).
 *   - Builds a minimal OPENCODE_CONFIG_CONTENT in-process — no MCP, no
 *     instructions. The wrapped subprocess answers a single prompt and exits.
 *   - Runs in a unique cwd under SUBQUERY_ROOT so cwd-based session caches
 *     don't collide with the main opencode provider (when both are active).
 *   - Captures stdout/stderr; returns trimmed stdout as the tool result.
 *
 * Enablement: this tool requires the opencode CLI binary (in every image) AND
 * the OPENCODE_PROVIDER / OPENCODE_MODEL env vars (set by the opencode
 * provider's container contribution). For groups whose `provider` is
 * "opencode", that contribution applies automatically. Otherwise, set
 * `enableOpencodeTooling: true` in the group's container.json.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[query-opencode] ${msg}`);
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // OC is faster than agy; 5min default
const HARD_TIMEOUT_CEILING_MS = 30 * 60 * 1000;

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({
  content: [{ type: 'text' as const, text: `Error: ${text}` }],
  isError: true,
});

function getOpencodeBin(): string {
  return process.env.OPENCODE_BIN || 'opencode';
}

function getSubqueryRoot(): string {
  // Under /tmp, not /workspace/agent/, so per-call dirs don't pollute the
  // group's primary working tree (the agent would see leftovers in `ls`).
  // The real reason this dir exists isn't session keying (opencode is
  // stateless aside from XDG_DATA_HOME) — it's to keep XDG project-config
  // discovery from picking up the main session's project dir.
  return process.env.OPENCODE_SUBQUERY_ROOT || '/tmp/opencode-subquery';
}

function makeSubqueryCwd(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(getSubqueryRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmSubqueryCwd(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function opencodeBinExists(opencodeBin: string): boolean {
  if (path.isAbsolute(opencodeBin)) return fs.existsSync(opencodeBin);
  return true;
}

/**
 * SIGKILL the whole process tree. `opencode run` spawns its own backend
 * (the same machinery as `opencode serve`) plus an HTTP client; killing
 * just the parent PID can leave those children holding stdio pipes open,
 * preventing the 'close' event from firing.
 *
 * Mirrors the killProcessTree helper in container/agent-runner/src/providers/opencode.ts.
 */
function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

/**
 * Build a minimal OPENCODE_CONFIG_CONTENT for one-shot `opencode run`. Strips
 * MCP and instructions — sub-queries get no tools and no system prompt beyond
 * what's in `prompt`. Matches the auth pattern in the main provider: real
 * credentials never enter the container; the OneCLI proxy at ANTHROPIC_BASE_URL
 * intercepts and injects the OpenRouter key per request.
 *
 * Mirrors `buildOpenCodeConfig` in
 * container/agent-runner/src/providers/opencode.ts. If that function adds a
 * required field (new provider option shape, new top-level key), this
 * minimal version rots silently — keep them in sync or refactor to share.
 */
function buildMinimalConfig(modelOverride?: string): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = modelOverride || process.env.OPENCODE_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(providerModelId
              ? { models: { [providerModelId]: { id: providerModelId, name: providerModelId, tool_call: true } } }
              : {}),
          },
        };

  return {
    ...(model ? { model } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp: {},
  };
}

export const queryOpencode: McpToolDefinition = {
  tool: {
    name: 'query_opencode',
    description:
      `Run a one-shot query against an ephemeral opencode subprocess (OpenRouter-routed model — DeepSeek, etc.) and return its final stdout. ` +
      `Use this to delegate bulk drafting, cheap exploratory work, or alternative-model second opinions without switching this group's main provider. ` +
      `Each call is independent — no session reuse, no shared state with the main agent. ` +
      `Returns trimmed stdout; some 'opencode run' decorations may be present, skim past them. ` +
      `Times out after 5 minutes by default.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description:
            'The full prompt to send to opencode. Be explicit — opencode has no context from this conversation and no MCP tools.',
        },
        model: {
          type: 'string',
          description:
            'Optional model override in OpenCode format (e.g. "openrouter/deepseek/deepseek-chat"). Falls back to OPENCODE_MODEL env var.',
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

    const opencodeBin = getOpencodeBin();
    if (!opencodeBinExists(opencodeBin)) {
      return err(
        `opencode binary not found at ${opencodeBin}. Set OPENCODE_BIN or rebuild the container image (pinned in container/Dockerfile).`,
      );
    }

    const modelOverride = typeof args.model === 'string' ? (args.model as string) : undefined;
    const effectiveModel = modelOverride || process.env.OPENCODE_MODEL;
    const provider = process.env.OPENCODE_PROVIDER;

    if (!provider || !effectiveModel) {
      return err(
        'opencode env vars not set (OPENCODE_PROVIDER / OPENCODE_MODEL). This group is not enabled for query_opencode — set enableOpencodeTooling: true in container.json.',
      );
    }

    const requestedTimeout = typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(1000, Math.min(requestedTimeout, HARD_TIMEOUT_CEILING_MS));

    const cwd = makeSubqueryCwd();
    log(`spawn opencode run (cwd=${cwd}, model=${effectiveModel}, timeout=${timeoutMs}ms, prompt=${prompt.slice(0, 80).replace(/\n/g, ' ')}…)`);

    const config = buildMinimalConfig(modelOverride);
    const subprocessEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };

    const result = await new Promise<ReturnType<typeof ok> | ReturnType<typeof err>>((resolve) => {
      const argv = ['run', prompt, '--model', effectiveModel];
      const proc = spawn(opencodeBin, argv, {
        cwd,
        env: subprocessEnv,
        detached: true, // own process group so we can SIGKILL the tree on timeout
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let killed = false;

      let settled = false;
      const settle = (r: ReturnType<typeof ok> | ReturnType<typeof err>) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const killTimer = setTimeout(() => {
        killed = true;
        killProcessTree(proc);
        // Resolve immediately on timeout — orphaned grandchildren may hold
        // the stdio pipes open and delay the 'close' event indefinitely.
        const stdoutSoFar = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        settle(err(`opencode timed out after ${timeoutMs}ms. Partial stdout:\n${stdoutSoFar.slice(-2000)}`));
      }, timeoutMs);

      proc.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
      proc.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

      proc.on('error', (e) => {
        clearTimeout(killTimer);
        settle(err(`failed to spawn opencode: ${e.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(killTimer);
        if (settled) return;
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

        if (killed) {
          settle(err(`opencode timed out after ${timeoutMs}ms. Partial stdout:\n${stdout.slice(-2000)}`));
          return;
        }
        if (code !== 0) {
          log(`opencode exited ${code}. stderr: ${stderr.slice(0, 500)}`);
          settle(err(`opencode exited ${code}. stderr: ${stderr.slice(0, 1000)}`));
          return;
        }
        if (!stdout) {
          log(`opencode returned empty stdout (exit 0). stderr: ${stderr.slice(0, 500)}`);
          settle(err(`opencode returned empty stdout (exit 0). stderr: ${stderr.slice(0, 500)}`));
          return;
        }
        settle(ok(stdout));
      });
    });

    rmSubqueryCwd(cwd);
    return result;
  },
};

registerTools([queryOpencode]);

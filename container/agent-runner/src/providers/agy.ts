import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToAgyConfig } from './mcp-to-agy.js';

function log(msg: string): void {
  console.error(`[agy-provider] ${msg}`);
}

/**
 * Stale-session detection. agy exits 0 when --conversation <id> is missing
 * and prints `Warning: conversation "<id>" not found.` on stdout, then
 * silently starts a fresh conversation. The provider scans stdout for this
 * warning and throws an error whose message matches this regex.
 * (Verified in spike Task 1.3 step 3.)
 */
const STALE_SESSION_RE = /Warning: conversation ".*" not found\./;

const AGY_BIN = process.env.AGY_BIN || 'agy';
const CLI_DATA_DIR = process.env.AGY_CLI_DATA_DIR || '/home/node/.gemini/antigravity-cli';
const MCP_CONFIG_PATH = process.env.AGY_MCP_CONFIG_PATH || `${CLI_DATA_DIR}/mcp_config.json`;
const LAST_CONVS_PATH = process.env.AGY_LAST_CONVS_PATH || `${CLI_DATA_DIR}/cache/last_conversations.json`;
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || '15m';

function writeMcpConfig(servers: ProviderOptions['mcpServers']): void {
  fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  const config = { mcpServers: mcpServersToAgyConfig(servers) };
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Look up the conversation id agy associated with this cwd. agy writes the
 * cwd→uuid mapping to `cache/last_conversations.json` shortly after starting
 * a -p run. Race-free vs. the brain/ folder diff because the key is known.
 * (Verified in spike Task 1.3.)
 */
function getConvIdForCwd(cwd: string): string | null {
  try {
    const cache = JSON.parse(fs.readFileSync(LAST_CONVS_PATH, 'utf-8')) as Record<string, unknown>;
    const value = cache[cwd];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export class AgyProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeConversationId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeConversationId = input.continuation;
    }

    writeMcpConfig(this.options.mcpServers);

    const pending: string[] = [input.prompt];
    const self = this;
    let activeProc: ChildProcess | null = null;
    let aborted = false;
    let ended = false;
    let waiting: (() => void) | null = null;

    const kick = (): void => { waiting?.(); waiting = null; };

    function spawnTurn(text: string): ChildProcess {
      const args = ['-p', text, '--dangerously-skip-permissions', '--print-timeout', PRINT_TIMEOUT];
      if (self.activeConversationId) {
        args.push('--conversation', self.activeConversationId);
      }
      args.push('--add-dir', input.cwd);
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      return spawn(AGY_BIN, args, { cwd: input.cwd, env, detached: false });
    }

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => { waiting = resolve; });
        }
        if (aborted || (pending.length === 0 && ended)) return;

        const turnText = pending.shift()!;
        const proc = spawnTurn(turnText);
        activeProc = proc;

        let stdoutBuf = '';
        let staleWarningDetected = false;

        // Stdout handler: collect lines, scan for the stale-conversation
        // warning. agy doesn't error when --conversation is missing — it
        // exits 0 after printing this warning and silently starts a fresh
        // conversation. We must abort the turn and surface as session-
        // invalid so the agent-runner clears the stored continuation.
        const lines: string[] = [];
        const errorChunks: string[] = [];
        const stdoutPromise = new Promise<void>((resolve, reject) => {
          proc.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stdoutBuf += text;
            const parts = stdoutBuf.split('\n');
            stdoutBuf = parts.pop() ?? '';
            for (const ln of parts) {
              lines.push(ln);
              if (STALE_SESSION_RE.test(ln)) {
                staleWarningDetected = true;
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              }
            }
          });
          proc.stderr?.on('data', (chunk: Buffer) => {
            errorChunks.push(chunk.toString());
          });
          proc.on('close', (code) => {
            if (stdoutBuf) lines.push(stdoutBuf);
            if (staleWarningDetected) {
              const id = self.activeConversationId ?? '?';
              reject(new Error(`Warning: conversation "${id}" not found.`));
              return;
            }
            if (code !== 0 && !aborted) {
              reject(new Error(`agy exited ${code}: ${errorChunks.join('').slice(0, 500)}`));
            } else {
              resolve();
            }
          });
          proc.on('error', reject);
        });

        // Discover the conversation id on first turn via the cwd-keyed
        // last_conversations.json cache (see spike Task 1.3). Poll every
        // 500ms until the id appears or the process exits. The poll also
        // serves as activity-pings while we wait.
        if (!initYielded && !self.activeConversationId) {
          const start = Date.now();
          while (Date.now() - start < 30_000) {
            const id = getConvIdForCwd(input.cwd);
            if (id) {
              self.activeConversationId = id;
              yield { type: 'init', continuation: id };
              initYielded = true;
              break;
            }
            yield { type: 'activity' };
            await new Promise((r) => setTimeout(r, 500));
            if (proc.exitCode !== null) break;
          }
          if (!initYielded) {
            log('Failed to discover conversation id within 30s — proceeding without continuation');
          }
        } else if (!initYielded && self.activeConversationId) {
          yield { type: 'init', continuation: self.activeConversationId };
          initYielded = true;
        }

        // Heartbeat: yield activity at most every 5s while waiting for close.
        const heartbeat = (async function* () {
          while (proc.exitCode === null && !aborted) {
            yield { type: 'activity' as const };
            await new Promise((r) => setTimeout(r, 5000));
          }
        })();

        try {
          // Drain heartbeats in parallel with awaiting close.
          let closed = false;
          stdoutPromise.then(() => { closed = true; }).catch(() => { closed = true; });
          while (!closed && !aborted) {
            const { value, done } = await heartbeat.next();
            if (done) break;
            if (value) yield value;
          }
          await stdoutPromise;
        } catch (err) {
          self.activeConversationId = undefined;
          throw err;
        } finally {
          activeProc = null;
        }

        const resultText = lines.join('\n').trim();
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        // CLI-per-turn pattern: aborting the current process and respawning
        // is the only way to inject a follow-up message into a `-p` run.
        pending.push(message);
        if (activeProc) {
          try { activeProc.kill('SIGTERM'); } catch { /* ignore */ }
        }
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        if (activeProc) {
          try { activeProc.kill('SIGKILL'); } catch { /* ignore */ }
        }
        kick();
      },
    };
  }
}

registerProvider('agy', (opts) => new AgyProvider(opts));

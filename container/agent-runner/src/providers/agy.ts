import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

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

  query(_input: QueryInput): AgentQuery {
    // Implemented in Task 2.5
    throw new Error('AgyProvider.query() not implemented yet');
  }
}

registerProvider('agy', (opts) => new AgyProvider(opts));

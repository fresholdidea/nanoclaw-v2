import type {
  AgentProvider, AgentQuery, ProviderEvent, ProviderExchange, QueryInput,
} from './types.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { decodeState, encodeState, type FallbackState } from './fallback-state.js';
import { classifyFailure } from './error-classification.js';

export type ChildFactory = (name: string) => AgentProvider;
export interface FallbackDeps {
  createChild: ChildFactory;
  now: () => number;
  cooldownMs: number;
}

function log(msg: string): void {
  console.error(`[fallback] ${msg}`);
}

export class FallbackProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private children = new Map<string, AgentProvider>();
  private memoryHook: MemorySessionHookRegistration | null = null;

  constructor(private chain: string[], private deps: FallbackDeps) {
    if (chain.length < 2) throw new Error('FallbackProvider requires at least 2 providers');
  }

  private child(name: string): AgentProvider {
    let c = this.children.get(name);
    if (!c) {
      c = this.deps.createChild(name);
      if (this.memoryHook) c.registerMemorySessionHook(this.memoryHook);
      this.children.set(name, c);
    }
    return c;
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    // Store and forward to every child built now or later.
    this.memoryHook = hook;
    for (const c of this.children.values()) c.registerMemorySessionHook(hook);
  }

  isSessionInvalid(_err: unknown): boolean {
    // Defer to whichever child is active; conservative default false.
    return false;
  }

  onExchangeComplete(_exchange: ProviderExchange): void {
    // Forward to the child that produced the exchange is not knowable here;
    // recap capture (Task 6) records exchanges. Child archiving happens inside
    // the child query path via its own hook, so nothing to do by default.
  }

  query(input: QueryInput): AgentQuery {
    const state = decodeState(input.continuation);
    const startIndex = this.pickStartIndex(state);
    const self = this;

    let currentChild: AgentQuery | null = null;
    let aborted = false;

    async function* run(): AsyncGenerator<ProviderEvent> {
      // Working copy of state (or fresh from primary).
      const work: FallbackState = state ?? { v: 1, active: self.chain[0], children: {}, cooldownUntil: null };
      for (let i = startIndex; i < self.chain.length; i++) {
        if (aborted) return;
        const name = self.chain[i];
        const childInput: QueryInput = { ...input, continuation: work.children[name] };
        const q = self.child(name).query(childInput);
        currentChild = q;
        let committed = false;
        let failed = false;

        for await (const e of q.events) {
          if (aborted) { q.abort(); return; }
          if (!committed) {
            const cls = classifyFailure(e);
            if (cls) {
              // Advance: record cooldown, log, do NOT emit this failure.
              failed = true;
              const from = name;
              const to = self.chain[i + 1];
              if (to) {
                log(`${from}→${to} classification=${cls}`);
                work.active = to;
                work.cooldownUntil = new Date(self.deps.now() + self.deps.cooldownMs).toISOString();
              } else {
                // Last link failed — surface the failure downstream unchanged.
                log(`${from} failed (classification=${cls}); no further links — surfacing error`);
                yield e;
              }
              break;
            }
          }
          // Not a triggering failure → emit. Rewrite init to carry composite state.
          if (e.type === 'init') {
            work.active = name;
            work.children[name] = e.continuation;
            // Reaching the primary successfully clears the cooldown.
            if (i === 0) work.cooldownUntil = null;
            committed = true;
            yield { type: 'init', continuation: encodeState(work) };
          } else {
            if (e.type === 'result' && e.isError !== true) committed = true;
            yield e;
          }
        }
        if (!failed) return; // committed to this child; turn complete
      }
    }

    return {
      push(message: string) { currentChild?.push(message); },
      end() { currentChild?.end(); },
      abort() { aborted = true; currentChild?.abort(); },
      events: run(),
    };
  }

  private pickStartIndex(state: FallbackState | null): number {
    if (!state) return 0;
    if (state.cooldownUntil && this.deps.now() >= Date.parse(state.cooldownUntil)) return 0; // re-probe primary
    const idx = this.chain.indexOf(state.active);
    return idx >= 0 ? idx : 0;
  }
}

/**
 * Provider fallback chain: which providers a group's runner may switch to when
 * its own provider is out of quota. The first entry is always the provider the
 * session runs on; the rest are tried in order (see the runner's
 * `provider-fallback.ts`).
 *
 * Stored in `container_configs.provider_chain` as a JSON array of provider
 * names, primary first:
 *   - NULL            → the default chain for the provider (DEFAULT_FALLBACKS)
 *   - `["codex"]`     → no fallback
 *   - `["codex","claude"]` → explicit chain
 *
 * A stored chain whose first entry is not the provider the session runs on was
 * written for a different provider (pre-rebuild rows still hold
 * `["claude","codex","opencode"]` on Codex groups). It is ignored, with a
 * warning, and the default applies; it is never reordered into something the
 * operator didn't write.
 */
import { log } from '../log.js';

/** Default fallbacks per primary provider. Providers not listed get none. */
export const DEFAULT_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  codex: ['claude'],
};

/** Ignored chains already warned about (one line per group and value, not per spawn). */
const warned = new Set<string>();

export interface ProviderChainOptions {
  /** Provider names this host can realize; unknown fallbacks are dropped. */
  known?: readonly string[];
  /** Group name, for the warning on an ignored chain. */
  groupName?: string;
}

/** Parse the stored column. Returns undefined for NULL/empty or anything malformed. */
export function parseStoredProviderChain(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    if (!parsed.every((entry) => typeof entry === 'string' && entry.trim() !== '')) return undefined;
    return parsed.map((entry: string) => entry.trim().toLowerCase());
  } catch {
    return undefined;
  }
}

/**
 * The full chain for a session running on `primary`: `[primary, ...fallbacks]`,
 * de-duplicated, with fallbacks this host doesn't know dropped.
 */
export function resolveProviderChain(
  primary: string,
  stored: string | null | undefined,
  opts: ProviderChainOptions = {},
): string[] {
  const head = primary.toLowerCase();
  const parsed = parseStoredProviderChain(stored);
  let fallbacks: readonly string[];
  if (parsed && parsed[0] === head) {
    fallbacks = parsed.slice(1);
  } else {
    const warnKey = `${opts.groupName ?? ''}\0${head}\0${stored ?? ''}`;
    if (stored && !warned.has(warnKey)) {
      warned.add(warnKey);
      log.warn('Ignoring provider_chain that does not start with the group provider; using the default', {
        groupName: opts.groupName,
        provider: head,
        stored,
      });
    }
    fallbacks = DEFAULT_FALLBACKS[head] ?? [];
  }
  const chain = [head];
  for (const name of fallbacks) {
    if (chain.includes(name)) continue;
    if (opts.known && !opts.known.includes(name)) continue;
    chain.push(name);
  }
  return chain;
}

/** The chain's fallback providers only (everything after the primary). */
export function resolveProviderFallbacks(
  primary: string,
  stored: string | null | undefined,
  opts: ProviderChainOptions = {},
): string[] {
  return resolveProviderChain(primary, stored, opts).slice(1);
}

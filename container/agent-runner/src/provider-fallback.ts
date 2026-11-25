/**
 * Quota fallback across providers (e.g. codex → claude).
 *
 * One provider runs per runner process. When it reports its quota exhausted
 * before doing any work on a batch, the runner records a cooldown for it,
 * defers the batch a few seconds and exits; the host respawns the session and
 * the new runner starts on the first provider in the chain that is not
 * cooling down. When every provider is cooling down, batches are deferred to
 * the earliest reset and the sender is told once when the run will happen.
 *
 * The chain comes from container.json `providerChain` (primary first). The
 * cooldowns live in outbound.db `session_state` (see db/session-state.ts).
 */
import { clearQuotaCooldown, getQuotaCooldown, setQuotaCooldown } from './db/session-state.js';
import type { ProviderEvent } from './providers/types.js';

/** `error` event classifications that mean "this provider can't run anything until a reset". */
const QUOTA_CLASSIFICATIONS = new Set(['quota', 'rate_limit']);

/** Cooldown when the provider names no reset time. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
/** Never trust a reset further out than this (a misparsed date must not park a group for weeks). */
const MAX_QUOTA_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a batch waits before the respawned runner (on the next provider) picks it up. */
export const SWITCH_DEFER_MS = 5 * 1000;
/** Deferrals before a message stops waiting and fails like any other run. */
export const MAX_QUOTA_DEFERRALS = 6;

type ErrorEvent = Extract<ProviderEvent, { type: 'error' }>;

export function isQuotaErrorEvent(event: ProviderEvent): event is ErrorEvent {
  return (
    event.type === 'error' &&
    !event.retryable &&
    event.classification !== undefined &&
    QUOTA_CLASSIFICATIONS.has(event.classification)
  );
}

/** Thrown out of processQuery when a quota error ended a turn that had done nothing yet. */
export class ProviderQuotaExhausted extends Error {
  constructor(
    readonly provider: string,
    readonly resetsAt: Date | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderQuotaExhausted';
  }
}

/**
 * Best-effort reset time from a provider's quota message:
 *   - an ISO timestamp ("resets 2026-11-24T20:43:00.000Z"), or
 *   - a wall-clock time ("try again at 3:43 PM"), taken as the next such time
 *     in the runner's timezone (TZ is the group's timezone).
 */
export function parseResetHint(message: string, now: Date = new Date()): Date | undefined {
  const iso = message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/);
  if (iso) {
    const at = new Date(iso[0]);
    if (Number.isFinite(at.getTime())) return at;
  }
  const clock = message.match(/\b(?:at|after)\s+(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?/);
  if (clock) {
    let hours = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === 'p') hours += 12;
    const at = new Date(now);
    at.setHours(hours, Number(clock[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }
  return undefined;
}

/** The cooldown end for a quota hit: the provider's reset if it gave a sane one, else the default. */
export function cooldownUntil(resetsAt: Date | undefined, now: Date = new Date()): Date {
  const nowMs = now.getTime();
  const at = resetsAt?.getTime();
  if (at !== undefined && Number.isFinite(at) && at > nowMs && at - nowMs <= MAX_QUOTA_COOLDOWN_MS) {
    return new Date(at);
  }
  return new Date(nowMs + DEFAULT_QUOTA_COOLDOWN_MS);
}

export interface ProviderSelection {
  /** The provider this runner should run. */
  name: string;
  /** Every provider in the chain is cooling down; `name` is the primary. */
  allExhausted: boolean;
  /** Earliest cooldown end across the chain (set when allExhausted). */
  earliestReset?: Date;
}

export class ProviderChain {
  /**
   * @param chain    providers in order, primary first, already filtered to those registered in this runner
   * @param readCooldown / writeCooldown  persistence seam (session_state in production)
   */
  constructor(
    readonly chain: readonly string[],
    private readonly store: {
      get(name: string): string | undefined;
      set(name: string, untilIso: string): void;
      clear(name: string): void;
    } = { get: getQuotaCooldown, set: setQuotaCooldown, clear: clearQuotaCooldown },
  ) {
    if (chain.length === 0) throw new Error('ProviderChain needs at least the primary provider');
  }

  get primary(): string {
    return this.chain[0];
  }

  get hasFallbacks(): boolean {
    return this.chain.length > 1;
  }

  /** Cooldown end for a provider, or undefined when it is available. Expired cooldowns are cleared. */
  cooldown(name: string, now: Date = new Date()): Date | undefined {
    const raw = this.store.get(name);
    if (!raw) return undefined;
    const until = new Date(raw);
    if (!Number.isFinite(until.getTime()) || until.getTime() <= now.getTime()) {
      this.store.clear(name);
      return undefined;
    }
    return until;
  }

  select(now: Date = new Date()): ProviderSelection {
    let earliest: Date | undefined;
    for (const name of this.chain) {
      const until = this.cooldown(name, now);
      if (!until) return { name, allExhausted: false };
      if (!earliest || until < earliest) earliest = until;
    }
    return { name: this.primary, allExhausted: true, earliestReset: earliest };
  }

  /** Record a quota hit; returns the cooldown end. */
  markExhausted(name: string, resetsAt: Date | undefined, now: Date = new Date()): Date {
    const until = cooldownUntil(resetsAt, now);
    this.store.set(name, until.toISOString());
    return until;
  }

  /** A provider ahead of `active` in the chain is available again (switch back up). */
  betterThan(active: string, now: Date = new Date()): string | undefined {
    for (const name of this.chain) {
      if (name === active) return undefined;
      if (!this.cooldown(name, now)) return name;
    }
    return undefined;
  }
}

/** Short user-facing notice for a batch held until a quota resets. */
export function quotaDeferralNotice(chain: readonly string[], until: Date): string {
  const names = chain.map(displayName);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const when = until.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const verb = names.length === 1 ? 'is' : names.length === 2 ? 'are both' : 'are all';
  return `${who} ${verb} out of quota right now. I'll run this automatically at ${when}; no need to resend.`;
}

function displayName(provider: string): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  return provider;
}

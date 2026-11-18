/**
 * The timeline: what changed, per client, in the order it happened.
 *
 * Two feeds. Events are the HUD's own record, written when a push shows
 * something different from the push before it (an issue opened or closed, an
 * ask appeared, a health row changed verdict) and when an action is taken
 * from the dashboard. Status lines are read from each client's Client Log,
 * which the hourly client dashboard writes and the HUD never touches.
 *
 * A change is only recorded for a scope that was read this time: a project
 * that could not be read has not had all its issues closed.
 */
import path from 'node:path';
import { SourceCache } from './io.js';
import { exclusionFilter } from './exclusions.js';
import { parseClientLog } from './sources/client-log.js';
import { parseClientRegistry } from './sources/clients.js';
import type { HudPaths } from './collect.js';
import type { EventRow, HudStore } from './store.js';
import type { HudClients, HudHealth, HudTimeline, TimelineEvent } from './types.js';

export interface Fact {
  /** What a missing fact may be concluded from: every fact of a scope is listed, or none is. */
  scope: string;
  id: string;
  kind: 'issue' | 'waiting' | 'health' | 'wall';
  client: string | null;
  label: string;
  state: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const HEALTH_WORD: Record<string, string> = {
  ok: 'is working again',
  warn: 'is partly working',
  down: 'is not working',
};

function describe(f: Pick<Fact, 'kind' | 'label'>, from: string | null, to: string | null): string | null {
  const label = clip(f.label, 200);
  switch (f.kind) {
    case 'issue':
      if (from === null) return `Issue opened: ${label}`;
      if (to === null) return `Issue no longer open: ${label}`;
      return to === 'overdue' ? `Issue became overdue: ${label}` : `Issue no longer overdue: ${label}`;
    case 'waiting':
      return from === null ? `Now waiting on you: ${label}` : to === null ? `No longer waiting on you: ${label}` : null;
    case 'wall':
      return from === null ? `New access wall: ${label}` : to === null ? `Access wall cleared: ${label}` : null;
    case 'health':
      // A row that starts or stops being watched is not news; a change of verdict is.
      if (from === null || to === null) return null;
      return `${label} ${HEALTH_WORD[to] ?? `is now ${to}`}`;
  }
}

/** The facts the timeline follows, from an unsnoozed, uncapped clients list and the health table. */
export function timelineFacts(
  clients: (HudClients & { waitingUnavailable?: boolean }) | undefined,
  health: HudHealth | undefined,
): { facts: Fact[]; scopes: string[] } {
  const facts: Fact[] = [],
    scopes: string[] = [];
  for (const c of clients?.clients ?? []) {
    if (c.source === 'Plane' && !c.unavailable && c.asOf) {
      const scope = `issue:${c.id}`;
      scopes.push(scope);
      for (const i of c.issues)
        facts.push({
          scope,
          id: i.id,
          kind: 'issue',
          client: c.id,
          label: i.title,
          state: i.flag === 'overdue' ? 'overdue' : 'open',
        });
    }
    if (clients && !clients.waitingUnavailable) {
      const scope = `waiting:${c.id}`;
      scopes.push(scope);
      for (const w of c.waiting)
        facts.push({ scope, id: w.id, kind: 'waiting', client: c.id, label: w.title, state: 'open' });
    }
  }
  if (health) {
    // A row whose own record could not be read keeps whatever was last recorded.
    for (const r of health.rows.filter((r) => r.group !== 'walls' && !r.unavailable && r.asOf)) {
      const scope = `health:${r.id}`;
      scopes.push(scope);
      facts.push({ scope, id: r.id, kind: 'health', client: null, label: r.label, state: r.status });
    }
    // Walls come from one file: either the whole list was read or none of it counts.
    const walls = health.rows.filter((r) => r.group === 'walls');
    if (walls.length && walls.every((r) => !r.unavailable)) {
      scopes.push('wall');
      for (const r of walls)
        facts.push({ scope: 'wall', id: r.id, kind: 'wall', client: null, label: r.label, state: r.status });
    }
  }
  return { facts, scopes };
}

interface Seen {
  k: Fact['kind'];
  c: string | null;
  l: string;
  s: string;
}

/**
 * Compare this push's facts with the last ones recorded and write what
 * changed. The first time a scope is seen it is recorded without events:
 * a newly added client did not just open thirty issues.
 */
export function recordChanges(store: HudStore, facts: Fact[], scopes: string[], t: string): EventRow[] {
  const seen = store.seen();
  const events: EventRow[] = [];
  const upserts: Array<[string, string]> = [];
  const removals: string[] = [];
  const key = (scope: string, id: string) => `${scope}|${id}`;
  for (const scope of new Set(scopes)) {
    const marker = `@${scope}`;
    const baseline = !seen.has(marker);
    if (baseline) upserts.push([marker, t]);
    const current = new Map(facts.filter((f) => f.scope === scope).map((f) => [key(scope, f.id), f]));
    for (const [k, f] of current) {
      const raw = seen.get(k);
      let old: Seen | null = null;
      try {
        old = raw ? (JSON.parse(raw) as Seen) : null;
      } catch {
        /* treated as new */
      }
      if (!old || old.s !== f.state || old.l !== f.label)
        upserts.push([k, JSON.stringify({ k: f.kind, c: f.client, l: f.label, s: f.state } satisfies Seen)]);
      if (baseline || old?.s === f.state) continue;
      const text = describe(f, old?.s ?? null, f.state);
      if (text) events.push({ t, client: f.client, kind: f.kind === 'wall' ? 'health' : f.kind, item: f.id, text });
    }
    for (const [k, raw] of seen) {
      if (!k.startsWith(`${scope}|`) || current.has(k)) continue;
      removals.push(k);
      try {
        const old = JSON.parse(raw) as Seen;
        const text = describe({ kind: old.k, label: old.l }, old.s, null);
        if (text)
          events.push({
            t,
            client: old.c,
            kind: old.k === 'wall' ? 'health' : old.k,
            item: k.slice(scope.length + 1),
            text,
          });
      } catch {
        /* dropped without an event */
      }
    }
  }
  if (upserts.length || removals.length || events.length) store.record(events, upserts, removals);
  return events;
}

const KINDS = new Set(['issue', 'waiting', 'health', 'action']);

export function createTimelineCollector(cache = new SourceCache()) {
  return function collectTimeline(
    paths: HudPaths,
    input: { store: HudStore | null; deadline?: number },
  ): HudTimeline | undefined {
    cache.deadline = input.deadline ?? performance.now() + 100;
    const registryFile =
      paths.primary && /^[\w-]+$/.test(paths.primary)
        ? path.join(paths.groupsDir, paths.primary, 'scripts/client-dashboard/registry.json')
        : undefined;
    const raw = cache.load(registryFile, JSON.parse);
    if (!raw.value) return undefined;
    const registry = parseClientRegistry(raw.value);
    const keep = exclusionFilter(raw.value, paths.exclusions !== false).keep;
    const clients = registry.clients.filter((c) => keep({ id: c.id, label: c.label }));
    const known = new Set(clients.map((c) => c.id));

    let events: TimelineEvent[] = [];
    try {
      events = (input.store?.events(400) ?? [])
        // An event for a client since excluded or removed stays in the store and off the page.
        .filter((e) => KINDS.has(e.kind) && (e.client === null || known.has(e.client)) && keep(e.text))
        .slice(0, 200)
        .map((e) => ({
          t: e.t,
          client: e.client,
          kind: e.kind as TimelineEvent['kind'],
          text: e.text,
          item: e.item || undefined,
        }));
    } catch {
      /* the page shows the status lines alone */
    }

    const logs: HudTimeline['logs'] = [];
    for (const c of clients) {
      if (!paths.vault || !c.folder) continue;
      const log = cache.load(path.join(paths.vault, '30-Areas/Clients', c.folder, 'Client Log.md'), parseClientLog);
      if (!log.value) continue;
      logs.push({
        client: c.id,
        asOf: log.asOf,
        entries: log.value.filter((e) => keep(e.text)).map((e) => ({ t: e.t, text: clip(e.text, 300) })),
      });
    }
    return { clients: clients.map((c) => ({ id: c.id, label: c.label })), events, logs };
  };
}

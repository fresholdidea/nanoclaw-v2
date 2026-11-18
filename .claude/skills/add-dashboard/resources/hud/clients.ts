/**
 * The clients page: one entry per registry client with its open Plane issues
 * and the asks waiting on the operator, each as an item with its buttons.
 *
 * Nothing is fetched here. The registry and the waiting-on ledger are files;
 * the issues come from the board the host keeps current (issues.ts).
 */
import path from 'node:path';
import { SourceCache, iso, localDay } from './io.js';
import { exclusionFilter } from './exclusions.js';
import type { BoardEntry } from './issues.js';
import { openIssues, parseClientRegistry } from './sources/clients.js';
import { parseWaiting } from './sources/waiting.js';
import type { HudPaths } from './collect.js';
import type { HudClient, HudClients, InboxAction, InboxItem } from './types.js';

export interface ClientsInput {
  /** The host's last Plane read for a project. */
  board(projectId: string): BoardEntry | undefined;
  /** False when there is no Plane client: issues are shown as unavailable, not as none. */
  planeConfigured: boolean;
  /** False when the HUD store is unavailable: issues are listed without edit buttons. */
  canEdit: boolean;
  snoozed: ReadonlyMap<string, string>;
  timezone: string;
  now?: Date;
  deadline?: number;
}

const PER_CLIENT = 30;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const snooze = (item: string, label: string, hours: string): InboxAction => ({
  name: 'item.snooze',
  label,
  args: { item, hours },
});

export function createClientsCollector(cache = new SourceCache()) {
  return function collectClients(paths: HudPaths, input: ClientsInput): HudClients | undefined {
    const now = input.now ?? new Date();
    cache.deadline = input.deadline ?? performance.now() + 100;
    const primary = (...parts: string[]) =>
      paths.primary && /^[\w-]+$/.test(paths.primary) ? path.join(paths.groupsDir, paths.primary, ...parts) : undefined;
    const raw = cache.load(primary('scripts/client-dashboard/registry.json'), JSON.parse);
    if (!raw.value) return undefined;
    const registry = parseClientRegistry(raw.value);
    const keep = exclusionFilter(raw.value, paths.exclusions !== false).keep;
    const waiting = cache.load(primary('state/waiting-on/ledger.json'), parseWaiting);
    const today = localDay(now, input.timezone);
    const result: HudClients = { clients: [], snoozed: 0 };
    const awake = (item: InboxItem) => {
      const until = input.snoozed.get(item.id);
      if (!until || Date.parse(until) <= now.getTime()) return true;
      result.snoozed++;
      return false;
    };

    for (const c of registry.clients) {
      if (!keep({ id: c.id, label: c.label })) continue;
      const entry = c.projectId ? input.board(c.projectId) : undefined;
      const open = entry
        ? openIssues(entry.items, entry.states, { terminal: registry.terminal, me: registry.me, today })
        : [];
      const issues = open
        .map((i): InboxItem => {
          const id = `issue:${i.id}`;
          const args = { client: c.id, id: i.id };
          return {
            id,
            kind: 'issue',
            title: clip(i.name, 240),
            detail: [
              i.overdue ? `Overdue since ${i.due}` : i.due ? `Due ${i.due}` : null,
              i.state,
              i.priority,
              i.mine ? 'mine' : null,
              `#${i.seq}`,
            ]
              .filter(Boolean)
              .join(' · '),
            since: iso(i.createdAt),
            href:
              registry.planeWeb && /^https:\/\/app\.plane\.so\//.test(registry.planeWeb)
                ? `${registry.planeWeb.replace(/\/$/, '')}/${c.projectId}/issues/${i.id}`
                : undefined,
            flag: i.overdue ? 'overdue' : i.mine ? 'mine' : undefined,
            actions: input.canEdit
              ? [
                  { name: 'issue.close', label: 'Done', args, style: 'primary' },
                  { name: 'issue.update', label: 'Rename…', args: { ...args, field: 'name' }, prompt: 'New title' },
                  {
                    name: 'issue.update',
                    label: 'Due date…',
                    args: { ...args, field: 'due' },
                    prompt: 'YYYY-MM-DD',
                    input: 'date',
                  },
                  snooze(id, 'Snooze 1w', '168'),
                ]
              : [],
          };
        })
        .filter(keep)
        .filter(awake);
      const asks = (waiting.value ?? [])
        .filter((w) => !!w.client && c.names.includes(w.client.toLowerCase()))
        .map((w): InboxItem => {
          const id = `waiting:${w.id}`;
          return {
            id,
            kind: 'waiting',
            title: clip(w.what, 240),
            detail: w.blocks ? clip(`Blocks: ${w.blocks}`, 300) : undefined,
            since: iso(w.asked),
            actions: [snooze(id, 'Snooze 1d', '24'), snooze(id, 'Snooze 1w', '168')],
          };
        })
        .filter(keep)
        .filter(awake);
      const client: HudClient = {
        id: c.id,
        label: c.label,
        open: issues.length,
        overdue: issues.filter((i) => i.flag === 'overdue').length,
        mine: open.filter((i) => i.mine).length,
        issues: issues.slice(0, PER_CLIENT),
        waiting: asks.slice(0, PER_CLIENT),
        waitingCount: asks.length,
        asOf: entry?.asOf ?? null,
        cadenceMin: 10,
        source: c.projectId ? 'Plane' : 'no Plane project',
        unavailable: !!c.projectId && (!input.planeConfigured || !entry || !!entry.unavailable),
      };
      result.clients.push(client);
    }
    // Whoever needs attention first; the rest alphabetically.
    result.clients.sort(
      (a, b) => b.overdue + b.waitingCount - (a.overdue + a.waitingCount) || a.label.localeCompare(b.label),
    );
    return result;
  };
}

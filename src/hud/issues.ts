/**
 * The host's copy of each client project's Plane work items, and the only way
 * the HUD changes one.
 *
 * Plane stays the store. This holds the last list read per project so the
 * snapshot can carry it without a network call, and so an edit can be checked
 * against it: the HUD only patches an item it listed itself.
 */
import type { HudActionResult } from './actions.js';
import type { Plane, PlaneState, PlaneWorkItem } from './plane.js';

export interface BoardEntry {
  items: PlaneWorkItem[];
  states: PlaneState[];
  /** When this list was last read from Plane. */
  asOf: string | null;
  /** The latest read failed; `items` is the last good list. */
  unavailable?: boolean;
}
export type IssueChange = { done: true } | { name: string } | { due: string | null };

const STATES_TTL_MS = 60 * 60_000;

export function createIssueBoard(now: () => Date = () => new Date()) {
  const entries = new Map<string, BoardEntry & { statesAt: number }>();

  return {
    get(projectId: string): BoardEntry | undefined {
      return entries.get(projectId);
    },
    /** Re-read every listed project, a few at a time. A failed project keeps its last list, marked unavailable. */
    async refresh(plane: Plane, projectIds: string[]): Promise<void> {
      const queue = [...new Set(projectIds)];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          const previous = entries.get(id);
          try {
            const fresh = !previous || now().getTime() - previous.statesAt > STATES_TTL_MS;
            const states = fresh ? await plane.states(id) : previous.states;
            const items = await plane.items(id);
            entries.set(id, {
              items,
              states,
              asOf: now().toISOString(),
              statesAt: fresh ? now().getTime() : previous.statesAt,
            });
          } catch {
            entries.set(id, { ...(previous ?? { items: [], states: [], asOf: null, statesAt: 0 }), unavailable: true });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    },
    /** Patch one item this board listed for this project. */
    async edit(plane: Plane, projectId: string, itemId: string, change: IssueChange): Promise<HudActionResult> {
      const entry = entries.get(projectId);
      const item = entry?.items.find((w) => w.id === itemId);
      if (!entry || !item) return { ok: false, message: 'That issue is not in the current list. Reload and retry.' };
      let body: Record<string, unknown>, done: string;
      if ('done' in change) {
        const state = entry.states.find((s) => s.group === 'completed');
        if (!state) return { ok: false, message: 'This project has no completed state to move the issue to.' };
        body = { state: state.id };
        done = 'Marked done';
      } else if ('name' in change) {
        body = { name: change.name };
        done = 'Renamed';
      } else {
        body = { target_date: change.due };
        done = change.due ? `Due ${change.due}` : 'Due date cleared';
      }
      const updated = await plane.patch(projectId, itemId, body);
      // Keep the list in step with what was just written, so the next snapshot shows it.
      Object.assign(item, body, updated && typeof updated === 'object' && updated.id === itemId ? updated : {});
      return { ok: true, message: `${done}: ${item.name}`.slice(0, 200) };
    },
  };
}
export type IssueBoard = ReturnType<typeof createIssueBoard>;

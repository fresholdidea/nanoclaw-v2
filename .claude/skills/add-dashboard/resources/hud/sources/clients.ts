import { isUuid, type PlaneState, type PlaneWorkItem } from '../plane.js';

export interface RegistryClient {
  id: string;
  label: string;
  projectId: string | null;
  /** Names this client goes by in the waiting-on ledger, lowercased. */
  names: string[];
  /** The client's folder name under the vault's clients area, when it is a plain name. */
  folder: string | null;
}
export interface ClientRegistry {
  planeBase: string | null;
  planeWeb: string | null;
  /** State groups that mean an issue is finished. */
  terminal: string[];
  /** The operator's Plane member id. */
  me: string | null;
  clients: RegistryClient[];
}

/** The client-dashboard registry, reduced to what the clients page needs. Disabled clients are left out. */
export function parseClientRegistry(registry: unknown): ClientRegistry {
  const r = registry as Record<string, any> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.clients)) throw new Error('Malformed client registry');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const clients: RegistryClient[] = [];
  for (const c of r.clients) {
    const id = str(c?.id);
    if (!id || !/^[\w-]{1,60}$/.test(id) || c.enabled === false) continue;
    const label = str(c.label) ?? id;
    const names = [label, ...(Array.isArray(c.ledger_names) ? c.ledger_names : [])]
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    const folder = str(c.folder);
    clients.push({
      id,
      label,
      projectId: isUuid(c.plane_project_id) ? c.plane_project_id : null,
      names,
      // One path segment, nothing that climbs.
      folder: folder && /^[^/\\]{1,80}$/.test(folder) && !/^\.+$/.test(folder) ? folder : null,
    });
  }
  const terminal = Array.isArray(r.plane?.terminal_state_groups)
    ? r.plane.terminal_state_groups.filter((g: unknown): g is string => typeof g === 'string')
    : [];
  return {
    planeBase: str(r.plane?.base),
    planeWeb: str(r.plane?.web),
    terminal: terminal.length ? terminal : ['completed', 'cancelled'],
    me: isUuid(r.brad?.plane_user_id) ? r.brad.plane_user_id : null,
    clients,
  };
}

export interface OpenIssue {
  id: string;
  seq: number;
  name: string;
  state: string;
  group: string;
  priority: string | null;
  /** YYYY-MM-DD */
  due: string | null;
  mine: boolean;
  overdue: boolean;
  updatedAt: string | null;
  createdAt: string | null;
}

const PRIORITY = ['urgent', 'high', 'medium', 'low'];

/** A project's open work items, most pressing first: mine, then overdue, then by due date, then priority. */
export function openIssues(
  items: PlaneWorkItem[],
  states: PlaneState[],
  opts: { terminal: string[]; me: string | null; today: string },
): OpenIssue[] {
  const byId = new Map(states.map((s) => [s.id, s]));
  const rank = (p: string | null) => (PRIORITY.includes(p ?? '') ? PRIORITY.indexOf(p!) : PRIORITY.length);
  return items
    .filter((w) => w && isUuid(w.id) && typeof w.name === 'string' && !w.archived_at && !w.is_draft)
    .map((w) => {
      const state = byId.get(w.state);
      const due = typeof w.target_date === 'string' && /^\d{4}-\d\d-\d\d$/.test(w.target_date) ? w.target_date : null;
      return {
        id: w.id,
        seq: w.sequence_id,
        name: w.name,
        state: state?.name ?? 'Unknown',
        // An item in a state the host does not know is shown, not silently dropped.
        group: state?.group ?? 'unknown',
        priority: typeof w.priority === 'string' && w.priority !== 'none' ? w.priority : null,
        due,
        mine: !!opts.me && Array.isArray(w.assignees) && w.assignees.includes(opts.me),
        overdue: !!due && due < opts.today,
        updatedAt: w.updated_at ?? null,
        createdAt: w.created_at ?? null,
      };
    })
    .filter((i) => !opts.terminal.includes(i.group))
    .sort(
      (a, b) =>
        Number(b.mine) - Number(a.mine) ||
        Number(b.overdue) - Number(a.overdue) ||
        (a.due ?? '9').localeCompare(b.due ?? '9') ||
        rank(a.priority) - rank(b.priority) ||
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
}

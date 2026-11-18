/**
 * The few Plane REST calls the HUD makes: list a project's states and work
 * items, and patch one work item. Mirrors the agents' plane.py helper.
 *
 * The API key is sent to one fixed origin and nowhere else: the base URL comes
 * from a file an agent can edit, so anything that is not that origin is refused
 * before a request is built.
 */
export const PLANE_ORIGIN = 'https://api.plane.so';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export interface PlaneState {
  id: string;
  name: string;
  group: string;
}
export interface PlaneWorkItem {
  id: string;
  sequence_id: number;
  name: string;
  state: string;
  priority: string | null;
  target_date: string | null;
  assignees: string[];
  updated_at: string | null;
  created_at: string | null;
  archived_at?: string | null;
  is_draft?: boolean;
}
export interface Plane {
  states(projectId: string): Promise<PlaneState[]>;
  items(projectId: string): Promise<PlaneWorkItem[]>;
  patch(projectId: string, itemId: string, body: Record<string, unknown>): Promise<PlaneWorkItem>;
}
export interface PlaneOptions {
  /** `https://api.plane.so/api/v1/workspaces/<slug>` */
  base: string;
  key: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_PAGES = 10;

/** A client for one workspace, or null when the base is not Plane's API or there is no key. */
export function createPlane(options: PlaneOptions): Plane | null {
  let base: URL;
  try {
    base = new URL(options.base);
  } catch {
    return null;
  }
  if (base.origin !== PLANE_ORIGIN || !/^\/api\/v1\/workspaces\/[\w-]+\/?$/.test(base.pathname) || !options.key) {
    return null;
  }
  const root = PLANE_ORIGIN + base.pathname.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await doFetch(root + path, {
      method,
      headers: { 'X-API-Key': options.key, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    // Never echo the response body: an error page is not something to show on the dashboard.
    if (!res.ok) throw new Error(`Plane answered ${res.status}`);
    return res.json();
  }
  async function pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call('GET', `${path}?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!data || !Array.isArray(data.results)) throw new Error('Plane sent an unexpected list');
      all.push(...data.results);
      if (!data.next_page_results || typeof data.next_cursor !== 'string') break;
      cursor = data.next_cursor;
    }
    return all;
  }
  const project = (id: string) => {
    if (!isUuid(id)) throw new Error('Not a Plane project id');
    return `/projects/${id}`;
  };
  return {
    states: async (projectId) => pages<PlaneState>(`${project(projectId)}/states/`),
    items: async (projectId) => pages<PlaneWorkItem>(`${project(projectId)}/work-items/`),
    async patch(projectId, itemId, body) {
      if (!isUuid(itemId)) throw new Error('Not a Plane work item id');
      return call('PATCH', `${project(projectId)}/work-items/${itemId}/`, body);
    },
  };
}

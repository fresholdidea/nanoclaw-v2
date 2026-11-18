import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHudActions, type HudActionDeps } from './actions.js';
import { createClientsCollector, type ClientsInput } from './clients.js';
import { createIssueBoard } from './issues.js';
import { createPlane, type Plane, type PlaneState, type PlaneWorkItem } from './plane.js';
import { openIssues, parseClientRegistry } from './sources/clients.js';
import { openHudStore, type HudStore } from './store.js';

const NOW = new Date('2026-11-17T15:00:00Z');
const BASE = 'https://api.plane.so/api/v1/workspaces/acme-ws';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STATES: PlaneState[] = [
  { id: 's-todo', name: 'Todo', group: 'unstarted' },
  { id: 's-doing', name: 'In Progress', group: 'started' },
  { id: 's-done', name: 'Done', group: 'completed' },
  { id: 's-cancel', name: 'Cancelled', group: 'cancelled' },
];
const item = (n: number, over: Partial<PlaneWorkItem> = {}): PlaneWorkItem => ({
  id: uuid(n),
  sequence_id: n,
  name: `Item ${n}`,
  state: 's-todo',
  priority: 'none',
  target_date: null,
  assignees: [],
  updated_at: '2026-11-10T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
  ...over,
});
const REGISTRY = {
  exclusions: { ids: ['hidden-co'], aliases: ['hidden co'] },
  plane: {
    base: BASE,
    web: 'https://app.plane.so/acme-ws/projects',
    terminal_state_groups: ['completed', 'cancelled'],
  },
  brad: { plane_user_id: ME },
  clients: [
    { id: 'acme', label: 'Acme', enabled: true, plane_project_id: P1, ledger_names: ['Acme Inc'] },
    { id: 'beta', label: 'Beta', enabled: true, plane_project_id: P2 },
    { id: 'off', label: 'Off', enabled: false, plane_project_id: P2 },
    { id: 'hidden-co', label: 'Hidden Co', enabled: true, plane_project_id: P2 },
    { id: 'no-plane', label: 'No Plane', enabled: true, plane_project_id: 'nope' },
  ],
};

function fakePlane(data: Record<string, PlaneWorkItem[]>, calls: unknown[] = []): Plane {
  return {
    states: async () => STATES,
    items: async (p) => {
      if (!data[p]) throw new Error('Plane answered 500');
      return structuredClone(data[p]);
    },
    patch: async (p, id, body) => {
      calls.push({ p, id, body });
      return Object.assign(data[p].find((w) => w.id === id)!, body);
    },
  };
}

describe('plane client', () => {
  it('sends the key only to the Plane API origin', () => {
    const f = (async () => new Response('{}')) as unknown as typeof fetch;
    expect(createPlane({ base: 'https://evil.example/api/v1/workspaces/x', key: 'k', fetch: f })).toBeNull();
    expect(createPlane({ base: 'http://api.plane.so/api/v1/workspaces/x', key: 'k', fetch: f })).toBeNull();
    expect(
      createPlane({ base: 'https://api.plane.so.evil.example/api/v1/workspaces/x', key: 'k', fetch: f }),
    ).toBeNull();
    expect(
      createPlane({ base: 'https://api.plane.so/api/v1/workspaces/x/../../other', key: 'k', fetch: f }),
    ).toBeNull();
    expect(createPlane({ base: BASE, key: '', fetch: f })).toBeNull();
    expect(createPlane({ base: BASE, key: 'k', fetch: f })).not.toBeNull();
  });

  it('follows pages, patches one item, and never passes on an error body', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (init.method === 'PATCH') return Response.json({ id: uuid(1), name: 'New' });
      if (url.includes('/states/')) return new Response('secret detail', { status: 403 });
      return url.includes('cursor=')
        ? Response.json({ results: [item(2)], next_page_results: false, next_cursor: 'x' })
        : Response.json({ results: [item(1)], next_page_results: true, next_cursor: '100:1:0' });
    }) as unknown as typeof fetch;
    const plane = createPlane({ base: BASE, key: 'the-key', fetch: f })!;
    expect((await plane.items(P1)).map((w) => w.sequence_id)).toEqual([1, 2]);
    expect(seen[0].url).toBe(`${BASE}/projects/${P1}/work-items/?per_page=100`);
    expect((seen[0].init.headers as Record<string, string>)['X-API-Key']).toBe('the-key');
    await plane.patch(P1, uuid(1), { name: 'New' });
    expect(seen.at(-1)!.url).toBe(`${BASE}/projects/${P1}/work-items/${uuid(1)}/`);
    await expect(plane.states(P1)).rejects.toThrow('Plane answered 403');
    await expect(plane.states(P1)).rejects.not.toThrow(/secret/);
    await expect(plane.items('../../x')).rejects.toThrow('Not a Plane project id');
    await expect(plane.patch(P1, 'x/../y', {})).rejects.toThrow('Not a Plane work item id');
  });
});

describe('client registry', () => {
  it('keeps enabled clients, their Plane project and ledger names', () => {
    const r = parseClientRegistry(REGISTRY);
    expect(r.clients.map((c) => c.id)).toEqual(['acme', 'beta', 'hidden-co', 'no-plane']);
    expect(r.clients[0]).toMatchObject({ projectId: P1, names: ['acme', 'acme inc'] });
    expect(r.clients[3].projectId).toBeNull();
    expect(r).toMatchObject({ planeBase: BASE, me: ME, terminal: ['completed', 'cancelled'] });
    expect(() => parseClientRegistry({ clients: 'x' })).toThrow();
  });

  it('lists open issues, mine and overdue first, and keeps unknown states visible', () => {
    const open = openIssues(
      [
        item(1, { state: 's-done' }),
        item(2, { target_date: '2026-11-30' }),
        item(3, { target_date: '2026-11-10' }),
        item(4, { assignees: [ME] }),
        item(5, { state: 's-gone' }),
        item(6, { archived_at: '2026-11-01T00:00:00Z' }),
        item(7, { is_draft: true }),
        item(8, { state: 's-cancel' }),
      ],
      STATES,
      { terminal: ['completed', 'cancelled'], me: ME, today: '2026-11-17' },
    );
    expect(open.map((i) => i.seq)).toEqual([4, 3, 2, 5]);
    expect(open[1]).toMatchObject({ overdue: true, due: '2026-11-10', mine: false });
    expect(open[3]).toMatchObject({ group: 'unknown', state: 'Unknown' });
  });
});

describe('issue board', () => {
  it('keeps the last good list when a project cannot be read', async () => {
    const board = createIssueBoard(() => NOW);
    const data: Record<string, PlaneWorkItem[]> = { [P1]: [item(1)] };
    await board.refresh(fakePlane(data), [P1, P2]);
    expect(board.get(P1)).toMatchObject({ asOf: NOW.toISOString() });
    expect(board.get(P1)!.unavailable).toBeUndefined();
    expect(board.get(P2)).toMatchObject({ items: [], asOf: null, unavailable: true });
    delete data[P1];
    await board.refresh(fakePlane(data), [P1]);
    expect(board.get(P1)).toMatchObject({ unavailable: true, asOf: NOW.toISOString() });
    expect(board.get(P1)!.items).toHaveLength(1);
  });

  it('patches only an item it listed for that project, and updates its own copy', async () => {
    const board = createIssueBoard(() => NOW);
    const calls: any[] = [];
    const plane = fakePlane({ [P1]: [item(1)], [P2]: [item(2)] }, calls);
    await board.refresh(plane, [P1, P2]);
    expect(await board.edit(plane, P1, uuid(2), { done: true })).toMatchObject({ ok: false });
    expect(await board.edit(plane, P1, uuid(9), { name: 'x' })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    expect(await board.edit(plane, P1, uuid(1), { name: 'Renamed' })).toEqual({
      ok: true,
      message: 'Renamed: Renamed',
    });
    expect(await board.edit(plane, P1, uuid(1), { due: '2026-12-01' })).toMatchObject({ ok: true });
    expect(await board.edit(plane, P1, uuid(1), { done: true })).toMatchObject({ ok: true });
    expect(calls.map((c) => c.body)).toEqual([{ name: 'Renamed' }, { target_date: '2026-12-01' }, { state: 's-done' }]);
    expect(board.get(P1)!.items[0]).toMatchObject({ name: 'Renamed', target_date: '2026-12-01', state: 's-done' });
  });
});

describe('clients', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-clients-'));
    fs.mkdirSync(path.join(dir, 'main/scripts/client-dashboard'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'main/state/waiting-on'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'main/scripts/client-dashboard/registry.json'), JSON.stringify(REGISTRY));
    fs.writeFileSync(
      path.join(dir, 'main/state/waiting-on/ledger.json'),
      JSON.stringify({
        a: { id: 'a', status: 'open', owner: 'brad', what: 'Send the brief', client: 'Acme Inc', asked: '2026-11-10' },
        b: { id: 'b', status: 'open', owner: 'brad', what: 'Other', client: 'Someone else' },
        c: { id: 'c', status: 'resolved', owner: 'brad', what: 'Old', client: 'Acme' },
      }),
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function collect(over: Partial<ClientsInput> = {}, data?: Record<string, PlaneWorkItem[]>) {
    const board = createIssueBoard(() => NOW);
    await board.refresh(
      fakePlane(
        data ?? {
          [P1]: [item(1, { target_date: '2026-11-10', assignees: [ME] }), item(2), item(3, { state: 's-done' })],
          [P2]: [item(4, { name: 'Call Hidden Co about renewal' }), item(5)],
        },
      ),
      [P1, P2],
    );
    return createClientsCollector()(
      { groupsDir: dir, primary: 'main' },
      {
        board: (id) => board.get(id),
        planeConfigured: true,
        canEdit: true,
        snoozed: new Map(),
        timezone: 'UTC',
        now: NOW,
        deadline: Infinity,
        ...over,
      },
    )!;
  }

  it('lists each registry client with its open issues and asks, most pressing first', async () => {
    const { clients } = await collect();
    expect(clients.map((c) => c.id)).toEqual(['acme', 'beta', 'no-plane']);
    const acme = clients[0];
    expect(acme).toMatchObject({ open: 2, overdue: 1, mine: 1, waitingCount: 1, asOf: NOW.toISOString() });
    expect(acme.unavailable).toBe(false);
    expect(acme.issues[0]).toMatchObject({
      id: `issue:${uuid(1)}`,
      kind: 'issue',
      flag: 'overdue',
      detail: 'Overdue since 2026-11-10 · Todo · mine · #1',
      href: `https://app.plane.so/acme-ws/projects/${P1}/issues/${uuid(1)}`,
    });
    expect(acme.issues[0].actions.map((a) => [a.name, a.args.field ?? a.args.hours ?? ''])).toEqual([
      ['issue.close', ''],
      ['issue.update', 'name'],
      ['issue.update', 'due'],
      ['item.snooze', '168'],
    ]);
    expect(acme.issues[0].actions[0].args).toEqual({ client: 'acme', id: uuid(1) });
    expect(acme.waiting.map((w) => w.id)).toEqual(['waiting:a']);
  });

  it('drops excluded clients and any issue that names one', async () => {
    const { clients } = await collect();
    expect(clients.find((c) => c.id === 'hidden-co')).toBeUndefined();
    expect(clients.find((c) => c.id === 'beta')!.issues.map((i) => i.title)).toEqual(['Item 5']);
  });

  it('shows a project that could not be read as unavailable, and one without a project as plain', async () => {
    const { clients } = await collect({}, { [P1]: [item(1)] });
    expect(clients.find((c) => c.id === 'beta')).toMatchObject({ unavailable: true, open: 0, asOf: null });
    expect(clients.find((c) => c.id === 'no-plane')).toMatchObject({ unavailable: false, source: 'no Plane project' });
    expect((await collect({ planeConfigured: false })).clients[0].unavailable).toBe(true);
  });

  it('lists issues without buttons when the HUD cannot edit, and hides snoozed ones', async () => {
    expect((await collect({ canEdit: false })).clients[0].issues[0].actions).toEqual([]);
    const snoozed = new Map([
      [`issue:${uuid(1)}`, '2026-11-18T00:00:00Z'],
      ['waiting:a', '2026-11-18T00:00:00Z'],
    ]);
    const result = await collect({ snoozed });
    expect(result.snoozed).toBe(2);
    expect(result.clients.find((c) => c.id === 'acme')).toMatchObject({ open: 1, overdue: 0, waitingCount: 0 });
  });
});

describe('issue actions', () => {
  let store: HudStore, dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-issue-'));
    store = openHudStore(path.join(dir, 'hud.db'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const actor = { login: 'owner@example.com', via: 'tailnet' as const };
  function setup(editIssue?: HudActionDeps['editIssue']) {
    const calls: unknown[] = [];
    let pushed = 0;
    const deps = {
      store,
      now: () => NOW,
      editIssue:
        editIssue ?? (async (client, id, change) => (calls.push({ client, id, change }), { ok: true, message: 'ok' })),
      changed: () => void pushed++,
    } as unknown as HudActionDeps;
    return { actions: createHudActions(deps), calls, pushed: () => pushed };
  }

  it('closes, renames and re-dates one issue, and asks for a fresh snapshot after each', async () => {
    const { actions, calls, pushed } = setup();
    const args = { client: 'acme', id: uuid(1) };
    expect(await actions['issue.close'](args, actor)).toMatchObject({ ok: true });
    expect(await actions['issue.update']({ ...args, field: 'name', text: '  New title ' }, actor)).toMatchObject({
      ok: true,
    });
    expect(await actions['issue.update']({ ...args, field: 'due', text: '2026-12-31' }, actor)).toMatchObject({
      ok: true,
    });
    expect(calls.map((c: any) => c.change)).toEqual([{ done: true }, { name: 'New title' }, { due: '2026-12-31' }]);
    expect(pushed()).toBe(3);
  });

  it('refuses malformed clients, ids, fields and values before reaching Plane', async () => {
    const { actions, calls, pushed } = setup();
    const ok = { client: 'acme', id: uuid(1) };
    for (const [name, args] of [
      ['issue.close', { client: '../x', id: uuid(1) }],
      ['issue.close', { client: 'acme', id: 'not-a-uuid' }],
      ['issue.update', { ...ok, field: 'state', text: 'x' }],
      ['issue.update', { ...ok, field: 'name', text: '   ' }],
      ['issue.update', { ...ok, field: 'name', text: 'a\nb' }],
      ['issue.update', { ...ok, field: 'name', text: 'x'.repeat(256) }],
      ['issue.update', { ...ok, field: 'due', text: '2026-02-30' }],
      ['issue.update', { ...ok, field: 'due', text: 'tomorrow' }],
    ] as const) {
      expect(await actions[name](args, actor), JSON.stringify(args)).toMatchObject({ ok: false });
    }
    expect(calls).toEqual([]);
    expect(pushed()).toBe(0);
  });

  it('audits a Plane failure as a failure and does not ask for a snapshot', async () => {
    const { actions, pushed } = setup(async () => {
      throw new Error('Plane answered 500');
    });
    expect(await actions['issue.close']({ client: 'acme', id: uuid(1) }, actor)).toEqual({
      ok: false,
      message: 'Failed: Plane answered 500',
    });
    expect(store.recentAudit(1)[0]).toMatchObject({
      action: 'issue.close',
      ok: false,
      actor: 'tailnet:owner@example.com',
    });
    expect(pushed()).toBe(0);
  });

  it('snoozes an issue like any other item', async () => {
    const { actions } = setup();
    expect(await actions['item.snooze']({ item: `issue:${uuid(1)}`, hours: '168' }, actor)).toMatchObject({ ok: true });
    expect(store.snoozed(NOW.toISOString()).has(`issue:${uuid(1)}`)).toBe(true);
  });
});

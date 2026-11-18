import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHudActions, type HudActionDeps } from './actions.js';
import { parseClientLog } from './sources/client-log.js';
import { openHudStore, type HudStore } from './store.js';
import { createTimelineCollector, recordChanges, timelineFacts, type Fact } from './timeline.js';
import type { HealthRow, HudClient, HudClients, InboxItem } from './types.js';

const T1 = '2026-11-18T15:00:00.000Z';
const T2 = '2026-11-18T15:01:00.000Z';
const T3 = '2026-11-18T15:02:00.000Z';

let dir: string;
let store: HudStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-timeline-'));
  store = openHudStore(path.join(dir, 'hud.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const issue = (id: string, over: Partial<Fact> = {}): Fact => ({
  scope: 'issue:acme',
  id: `issue:${id}`,
  kind: 'issue',
  client: 'acme',
  label: `Issue ${id}`,
  state: 'open',
  ...over,
});
const texts = () =>
  store
    .events()
    .map((e) => e.text)
    .reverse();

describe('recordChanges', () => {
  it('records the first sight of a scope without events, then what changes', () => {
    expect(recordChanges(store, [issue('a'), issue('b')], ['issue:acme'], T1)).toEqual([]);
    recordChanges(store, [issue('a', { state: 'overdue' }), issue('c')], ['issue:acme'], T2);
    expect(texts().sort()).toEqual([
      'Issue became overdue: Issue a',
      'Issue no longer open: Issue b',
      'Issue opened: Issue c',
    ]);
    expect(store.events()[0]).toMatchObject({ t: T2, client: 'acme', kind: 'issue' });
    // Nothing changed: nothing written.
    expect(recordChanges(store, [issue('a', { state: 'overdue' }), issue('c')], ['issue:acme'], T3)).toEqual([]);
    expect(store.events()).toHaveLength(3);
  });

  it('concludes nothing about a scope that was not read', () => {
    recordChanges(store, [issue('a')], ['issue:acme'], T1);
    expect(recordChanges(store, [], [], T2)).toEqual([]);
    // Read again and still there: no reopening either.
    expect(recordChanges(store, [issue('a')], ['issue:acme'], T3)).toEqual([]);
  });

  it('a renamed item is not an event, and its closure uses the new name', () => {
    recordChanges(store, [issue('a')], ['issue:acme'], T1);
    recordChanges(store, [issue('a', { label: 'Renamed' })], ['issue:acme'], T2);
    recordChanges(store, [], ['issue:acme'], T3);
    expect(texts()).toEqual(['Issue no longer open: Renamed']);
  });

  it('follows asks, health verdicts and walls', () => {
    const health = (state: string): Fact => ({
      scope: 'health:job:x',
      id: 'job:x',
      kind: 'health',
      client: null,
      label: 'Job X',
      state,
    });
    const wall = (id: string): Fact => ({ scope: 'wall', id, kind: 'wall', client: null, label: id, state: 'down' });
    const ask: Fact = {
      scope: 'waiting:acme',
      id: 'waiting:w1',
      kind: 'waiting',
      client: 'acme',
      label: 'Sign the SOW',
      state: 'open',
    };
    const scopes = ['health:job:x', 'wall', 'waiting:acme'];
    recordChanges(store, [health('ok'), wall('wall:a')], scopes, T1);
    recordChanges(store, [health('down'), wall('wall:a'), wall('wall:b'), ask], scopes, T2);
    recordChanges(store, [health('ok'), wall('wall:b')], scopes, T3);
    expect(texts().sort()).toEqual([
      'Access wall cleared: wall:a',
      'Job X is not working',
      'Job X is working again',
      'New access wall: wall:b',
      'No longer waiting on you: Sign the SOW',
      'Now waiting on you: Sign the SOW',
    ]);
    expect(store.events().find((e) => e.text.startsWith('New access wall'))).toMatchObject({
      kind: 'health',
      item: 'wall:b',
    });
  });
});

describe('timelineFacts', () => {
  const item = (id: string, kind: InboxItem['kind'], flag?: InboxItem['flag']): InboxItem => ({
    id,
    kind,
    title: id,
    since: null,
    flag,
    actions: [],
  });
  const client = (id: string, over: Partial<HudClient> = {}): HudClient => ({
    id,
    label: id,
    open: 0,
    overdue: 0,
    mine: 0,
    issues: [],
    waiting: [],
    waitingCount: 0,
    asOf: T1,
    cadenceMin: 10,
    source: 'Plane',
    ...over,
  });
  const row = (id: string, over: Partial<HealthRow> = {}): HealthRow => ({
    id,
    group: 'jobs',
    label: id,
    status: 'ok',
    detail: '',
    asOf: T1,
    cadenceMin: 10,
    source: 'test',
    ...over,
  });

  it('only claims a scope whose source was read', () => {
    const clients: HudClients & { waitingUnavailable?: boolean } = {
      snoozed: 0,
      clients: [
        client('acme', { issues: [item('issue:1', 'issue', 'overdue')], waiting: [item('waiting:w', 'waiting')] }),
        client('stale', { unavailable: true, issues: [item('issue:2', 'issue')] }),
        client('unread', { asOf: null }),
        client('no-plane', { source: 'no Plane project' }),
      ],
    };
    const { facts, scopes } = timelineFacts(clients, {
      rows: [
        row('job:a', { status: 'down' }),
        row('job:unread', { unavailable: true }),
        row('wall:a', { group: 'walls', status: 'down' }),
      ],
    });
    expect(scopes).toEqual([
      'issue:acme',
      'waiting:acme',
      'waiting:stale',
      'waiting:unread',
      'waiting:no-plane',
      'health:job:a',
      'wall',
    ]);
    expect(facts.map((f) => [f.id, f.state])).toEqual([
      ['issue:1', 'overdue'],
      ['waiting:w', 'open'],
      ['job:a', 'down'],
      ['wall:a', 'down'],
    ]);
    // An unread ledger says nothing about asks; an unread walls file nothing about walls.
    const blind = timelineFacts(
      { ...clients, waitingUnavailable: true },
      { rows: [row('wall:a', { group: 'walls', unavailable: true })] },
    );
    expect(blind.scopes).toEqual(['issue:acme']);
  });
});

const LOG = (lines: string[]) =>
  [
    '---',
    'type: client-log',
    'client_id: acme',
    '---',
    '',
    '# Acme — Client Log',
    '',
    ...lines.flatMap((line, n) => [
      `## Update Tue Nov 17 · ${n}:00 PM EST · acme-${n}`,
      '',
      '```yaml',
      `entry_id: acme-${n}`,
      `recorded_at: 2026-11-17T${String(10 + n).padStart(2, '0')}:00:00.000Z`,
      'content_hash: abc',
      '```',
      '',
      line,
      '',
      '**Waiting on Brad**',
      '- something',
      '',
    ]),
  ].join('\n');

describe('parseClientLog', () => {
  it('keeps the first entry of each run of one status line', () => {
    const entries = parseClientLog(
      LOG([
        '**MONITOR** — steady.',
        '**MONITOR** — steady.',
        '**RED FLAG** — [payroll](https://x.test/1) open.',
        '**MONITOR** — steady.',
      ]),
    );
    expect(entries).toEqual([
      { t: '2026-11-17T10:00:00.000Z', text: 'MONITOR — steady.' },
      { t: '2026-11-17T12:00:00.000Z', text: 'RED FLAG — payroll open.' },
      { t: '2026-11-17T13:00:00.000Z', text: 'MONITOR — steady.' },
    ]);
    expect(parseClientLog(LOG(['a', 'b', 'c']), 2).map((e) => e.text)).toEqual(['b', 'c']);
    expect(() => parseClientLog('# just a note')).toThrow();
  });
});

describe('collectTimeline', () => {
  it('lists events and status lines for registry clients only', () => {
    const groups = path.join(dir, 'groups');
    const vault = path.join(dir, 'vault');
    fs.mkdirSync(path.join(groups, 'main/scripts/client-dashboard'), { recursive: true });
    fs.writeFileSync(
      path.join(groups, 'main/scripts/client-dashboard/registry.json'),
      JSON.stringify({
        exclusions: { ids: ['hidden-co'] },
        clients: [
          { id: 'acme', label: 'Acme', folder: 'Acme' },
          { id: 'beta', label: 'Beta', folder: '../outside' },
          { id: 'hidden-co', label: 'Hidden Co', folder: 'Hidden' },
        ],
      }),
    );
    for (const folder of ['Acme', 'Hidden']) {
      fs.mkdirSync(path.join(vault, '30-Areas/Clients', folder), { recursive: true });
      fs.writeFileSync(path.join(vault, '30-Areas/Clients', folder, 'Client Log.md'), LOG(['**MONITOR** — steady.']));
    }
    store.record([
      { t: T1, client: 'acme', kind: 'issue', item: 'issue:1', text: 'Issue opened: One' },
      { t: T1, client: 'gone', kind: 'issue', item: 'issue:2', text: 'Issue opened: Two' },
      { t: T2, client: null, kind: 'health', item: 'job:x', text: 'Job X is not working' },
      { t: T2, client: null, kind: 'health', item: 'job:y', text: 'Hidden Co sync is not working' },
      { t: T3, client: 'acme', kind: 'action', item: '', text: 'From the HUD: Marked done: One' },
    ]);
    const timeline = createTimelineCollector()(
      { groupsDir: groups, primary: 'main', vault },
      { store, deadline: Infinity },
    )!;
    expect(timeline.clients).toEqual([
      { id: 'acme', label: 'Acme' },
      { id: 'beta', label: 'Beta' },
    ]);
    expect(timeline.events.map((e) => e.text)).toEqual([
      'From the HUD: Marked done: One',
      'Job X is not working',
      'Issue opened: One',
    ]);
    expect(timeline.events[0].item).toBeUndefined();
    expect(timeline.logs.map((l) => [l.client, l.entries.length])).toEqual([['acme', 1]]);
    // No store: the status lines still show.
    expect(
      createTimelineCollector()({ groupsDir: groups, primary: 'main', vault }, { store: null, deadline: Infinity })!
        .events,
    ).toEqual([]);
  });
});

describe('actions', () => {
  it('put what was done on the timeline, and leave snoozes and refusals off it', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const actions = createHudActions({
      store,
      now: () => new Date(T1),
      editIssue: async () => ({ ok: true, message: 'Marked done: One' }),
    } as unknown as HudActionDeps);
    const actor = { login: null, via: 'loopback' as const };
    await actions['issue.close']({ client: 'acme', id }, actor);
    await actions['issue.close']({ client: 'acme', id: 'nope' }, actor);
    await actions['item.snooze']({ item: `issue:${id}`, hours: '24' }, actor);
    expect(store.events()).toEqual([
      { t: T1, client: 'acme', kind: 'action', item: `issue:${id}`, text: 'From the HUD: Marked done: One' },
    ]);
    expect(store.recentAudit()).toHaveLength(3);
  });
});

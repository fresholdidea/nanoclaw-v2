import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHealthCollector, type HealthInput } from './health.js';
import { latestIngests, parseCollectorStates, parseLaunchctl } from './sources/health.js';
import type { TaskSeries } from './types.js';

const NOW = new Date('2026-11-17T15:00:00Z');
const CURRENT = `---
published_at: 2026-11-17T14:00:00.000Z
valid_until: 2026-11-17T18:30:00.000Z
---
# Client Dashboard

## Brad — my work

My tasks UNKNOWN — Plane failed for 1 of 3 projects (Beta: exit 28)
Checked 9:00 AM EST · Plane UNKNOWN · Calendar OK · Waiting OK

## Acme

Invoice UNKNOWN — ledger unreadable (ENOENT)
Plane OK · Calendar OK · Ledger UNKNOWN · AM OK

## Beta

Tasks UNKNOWN — Plane failed (exit 28)
Invoice UNKNOWN — ledger unreadable (ENOENT)
Plane UNKNOWN · Calendar OK · Ledger UNKNOWN · AM OK

## Hidden Co

Plane UNKNOWN · Calendar UNKNOWN · Ledger UNKNOWN · AM UNKNOWN
`;
const WALLS = `# Walls

## Open

| # | Wall | Since | Blocks | Brad must | Last probe | Last checked |
|---|------|-------|--------|-----------|------------|--------------|
| 1 | Brevo connector never authorized | 2026-08-23 | A milestone | Authorize the connector | 401 | 2026-11-16 |
| 2 | Hidden Co Slack token revoked | 2026-10-01 | Slack reads | Re-issue the token | 401 | 2026-11-16 |
`;
const task = (id: string, over: Partial<TaskSeries> = {}): TaskSeries => ({
  agent_group_id: 'ag-1',
  session_id: 's-1',
  series_id: id,
  status: 'pending',
  schedule: '0 9 * * *',
  runs: 3,
  failed_runs: 0,
  last_run: null,
  next_run: null,
  folder: 'steward',
  ...over,
});

describe('health sources', () => {
  it('takes the latest ingest per client and platform, and the worst account in it', () => {
    const run = (
      client: string,
      platform: string,
      status: string,
      at: string,
      rows = 10,
      errors: string | null = null,
    ) => ({
      client,
      platform,
      status,
      rows,
      errors,
      date_to: '2026-11-17',
      ingested_at: at,
    });
    const runs = latestIngests([
      run('acme', 'google', 'ok', '2026-11-17T12:15:05.253991Z', 100),
      run('acme', 'google', 'error', '2026-11-17T12:15:04.100000Z', 0, 'quota'),
      run('acme', 'meta', 'ok', '2026-11-17T12:15:03Z'),
      run('acme', 'google', 'error', '2026-11-16T12:15:00Z', 0, 'old failure'),
      run('acme', 'meta', 'partial', '2026-11-16T12:15:00Z'),
      run('beta', 'google', 'ok', 'not a time'),
    ]);
    expect(runs.map((r) => [r.client, r.platform, r.status, r.rows, r.errors])).toEqual([
      ['acme', 'google', 'error', 100, 'quota'],
      ['acme', 'meta', 'ok', 10, null],
    ]);
    expect(runs[0].at).toBe('2026-11-17T12:15:05.253Z');
  });

  it('reads the per-source verdicts and their reasons from the client dashboard', () => {
    const s = parseCollectorStates(CURRENT);
    expect(s.asOf).toBe('2026-11-17T14:00:00.000Z');
    const plane = s.sources.find((x) => x.name === 'Plane')!;
    expect(plane.ok).toEqual(['Acme']);
    expect(plane.failed).toEqual(['Brad — my work', 'Beta', 'Hidden Co']);
    expect(s.sources.map((x) => x.name)).toEqual(['Plane', 'Calendar', 'Waiting', 'Ledger', 'AM']);
    expect(s.reasons).toContain('Invoice UNKNOWN — ledger unreadable (ENOENT)');
    expect(() =>
      parseCollectorStates('---\npublished_at: 2026-11-17T14:00:00Z\nvalid_until: 2026-11-17T18:00:00Z\n---\nnothing'),
    ).toThrow();
  });

  it('parses launchctl list', () => {
    const jobs = parseLaunchctl(
      'PID\tStatus\tLabel\n759\t0\tcom.x.running\n-\t1\tcom.x.failed\n-\t0\tcom.x.idle\ngarbage\n',
    );
    expect([...jobs]).toEqual([
      ['com.x.running', { pid: 759, status: 0 }],
      ['com.x.failed', { pid: null, status: 1 }],
      ['com.x.idle', { pid: null, status: 0 }],
    ]);
  });
});

describe('health table', () => {
  let dir: string;
  const input = (over: Partial<HealthInput> = {}): HealthInput => ({
    tasks: null,
    launchd: { asOf: null, jobs: null, labels: [] },
    tracker: null,
    now: NOW,
    deadline: Infinity,
    ...over,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-health-'));
    fs.mkdirSync(path.join(dir, 'groups/main/scripts/client-dashboard'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'groups/steward'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'vault/90-System/Client Dashboard'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'groups/main/scripts/client-dashboard/registry.json'),
      JSON.stringify({ exclusions: { aliases: ['hidden co'] }, clients: [] }),
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = (over = {}) => ({
    groupsDir: path.join(dir, 'groups'),
    primary: 'main',
    steward: 'steward',
    vault: path.join(dir, 'vault'),
    ...over,
  });

  it('has no rows when nothing is configured', () => {
    expect(createHealthCollector()({ groupsDir: path.join(dir, 'groups') }, input()).rows).toEqual([]);
  });

  it('reports each collector source, with excluded clients left out of counts and names', () => {
    fs.writeFileSync(path.join(dir, 'vault/90-System/Client Dashboard/Current.md'), CURRENT);
    const rows = createHealthCollector()(paths(), input()).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['collector:plane'].status).toBe('warn');
    expect(by['collector:plane'].detail).toBe('Could not be read for 2 of 3: Brad — my work, Beta');
    expect(by['collector:plane'].notes).toEqual([
      'My tasks UNKNOWN — Plane failed for 1 of 3 projects (Beta: exit 28)',
      'Tasks UNKNOWN — Plane failed (exit 28)',
    ]);
    expect(by['collector:ledger'].status).toBe('down');
    expect(by['collector:calendar']).toMatchObject({
      status: 'ok',
      detail: 'Read for all 3',
      validUntil: '2026-11-17T18:30:00.000Z',
    });
    expect(JSON.stringify(rows)).not.toMatch(/hidden/i);
    // Problems first.
    expect(rows.map((r) => r.status)).toEqual(
      [...rows.map((r) => r.status)].sort((a, b) => 'dwo'.indexOf(a[0]) - 'dwo'.indexOf(b[0])),
    );
  });

  it('says so when the client dashboard cannot be read', () => {
    fs.writeFileSync(path.join(dir, 'vault/90-System/Client Dashboard/Current.md'), 'not a snapshot');
    const rows = createHealthCollector()(paths(), input()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'collector', status: 'down', asOf: null, unavailable: true });
  });

  it('lists open walls as blocked, without excluded ones', () => {
    fs.writeFileSync(path.join(dir, 'groups/steward/walls.md'), WALLS);
    const rows = createHealthCollector()(paths({ vault: undefined }), input()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'wall:brevo-connector-never-authorized',
      group: 'walls',
      status: 'down',
      detail: 'Since 2026-08-23 · Blocks: A milestone',
      notes: ['To clear it: Authorize the connector'],
      cadenceMin: 10080,
    });
  });

  it('reads the ad ingest log read-only', () => {
    const file = path.join(dir, 'ingest.db');
    const db = new Database(file);
    db.exec(
      'CREATE TABLE ingest_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT, platform TEXT, status TEXT, rows INTEGER, errors TEXT, date_to TEXT, ingested_at TEXT)',
    );
    const add = db.prepare(
      'INSERT INTO ingest_runs (client, platform, status, rows, errors, date_to, ingested_at) VALUES (?,?,?,?,?,?,?)',
    );
    add.run('acme', 'google', 'ok', 1641, null, '2026-11-17', '2026-11-17T12:15:05Z');
    add.run('acme', 'meta', 'error', 0, 'token expired', '2026-11-17', '2026-11-17T12:15:06Z');
    add.run('hidden-co', 'google', 'ok', 5, null, '2026-11-17', '2026-11-17T12:15:07Z');
    db.close();
    const rows = createHealthCollector()(paths({ vault: undefined, steward: undefined, adIngest: file }), input()).rows;
    expect(rows.map((r) => [r.id, r.status, r.detail, r.notes])).toEqual([
      ['ads:acme:meta', 'down', 'Last ingest failed', ['token expired']],
      ['ads:acme:google', 'ok', '1,641 rows through 2026-11-17', undefined],
    ]);
    expect(rows[0].asOf).toBe('2026-11-17T12:15:06.000Z');
    const missing = createHealthCollector()(
      paths({ vault: undefined, steward: undefined, adIngest: file + '.nope' }),
      input(),
    ).rows;
    expect(missing[0]).toMatchObject({ id: 'ads', status: 'down', unavailable: true });
  });

  it('reports watched jobs, the tracker and scheduled tasks', () => {
    const rows = createHealthCollector()(
      paths({ vault: undefined, steward: undefined }),
      input({
        launchd: {
          asOf: '2026-11-17T14:59:00.000Z',
          jobs: parseLaunchctl('759\t0\tcom.x.running\n-\t1\tcom.x.failed\n-\t0\tcom.x.idle\n'),
          labels: ['com.x.running', 'com.x.failed', 'com.x.idle', 'com.x.gone'],
        },
        tracker: {
          configured: true,
          projects: [
            { label: 'Acme', asOf: '2026-11-17T14:58:00.000Z', unavailable: false },
            { label: 'Beta', asOf: '2026-11-17T14:50:00.000Z', unavailable: true },
          ],
        },
        tasks: [task('a'), task('b', { lastLine: 'run failed: timeout' }), task('c', { status: 'paused' })],
        tasksAsOf: '2026-11-17T14:59:30.000Z',
      }),
    ).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['job:com-x-running']).toMatchObject({ status: 'ok', detail: 'Running' });
    expect(by['job:com-x-idle']).toMatchObject({ status: 'ok', detail: 'Last run succeeded' });
    expect(by['job:com-x-failed']).toMatchObject({ status: 'down', detail: 'Last run exited with status 1' });
    expect(by['job:com-x-gone']).toMatchObject({ status: 'down', detail: 'Not loaded.' });
    expect(by.tracker).toMatchObject({
      status: 'warn',
      detail: 'Could not be read for 1 of 2: Beta',
      asOf: '2026-11-17T14:50:00.000Z',
    });
    expect(by.tasks).toMatchObject({
      status: 'warn',
      detail: '3 series · 1 failing · 0 overdue · 1 paused',
      notes: ['steward/b: failing'],
    });
  });

  it('marks jobs unread when launchctl could not be read, and the tracker down when not configured', () => {
    const rows = createHealthCollector()(
      paths({ vault: undefined, steward: undefined }),
      input({ launchd: { asOf: null, jobs: null, labels: ['com.x.a'] }, tracker: { configured: false, projects: [] } }),
    ).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['job:com-x-a']).toMatchObject({ status: 'warn', unavailable: true, asOf: null });
    expect(by.tracker).toMatchObject({ status: 'down', asOf: NOW.toISOString() });
  });
});

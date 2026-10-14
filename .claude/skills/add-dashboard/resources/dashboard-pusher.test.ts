/**
 * The dashboard snapshot carries every group's container config, and the
 * dashboard serves it back as JSON. MCP server env and header values are
 * credentials: the pushed payload keeps each server's keys (the UI lists
 * server names) with `<redacted>` values, placeholders excepted — never the
 * stored values.
 */
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-dashboard-pusher';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-dashboard-pusher/data',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import path from 'path';
import Database from 'better-sqlite3';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { updateAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { OUTBOUND_SCHEMA } from './mailbox/sqlite/schema.js';
import { resetDashboardCaches, startDashboardPusher, stopDashboardPusher } from './dashboard-pusher.js';

const SESSIONS_DIR = path.join(TEST_ROOT, 'data', 'v2-sessions');

/** Write a session outbound.db with the real schema and the given messages_out rows. */
function writeOutboundDb(
  agentGroupId: string,
  sessionId: string,
  rows: Array<{ timestamp: string; channel_type: string; platform_id: string | null }>,
): void {
  const dir = path.join(SESSIONS_DIR, agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'outbound.db'));
  db.exec(OUTBOUND_SCHEMA);
  const insert = db.prepare(
    `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, ?, 'chat', ?, ?, '{}')`,
  );
  rows.forEach((r, i) => insert.run(`m-${sessionId}-${i}`, 2 * i + 1, r.timestamp, r.platform_id, r.channel_type));
  db.close();
}

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600000).toISOString();

interface SnapshotGroup {
  id: string;
  tier: string | null;
  reports_to: string | null;
  role: string | null;
  persona: Record<string, string> | null;
  lastActiveAt: string | null;
  container_config: { mcpServers: unknown };
}

async function pushOnce(): Promise<{ agent_groups: SnapshotGroup[]; a2a_edges: unknown[]; raw: string }> {
  const dash = await startFakeDashboard();
  startDashboardPusher({ port: dash.port, secret: 'test-dashboard-secret' });
  const raw = await dash.ingest;
  await dash.close();
  stopDashboardPusher();
  return { ...(JSON.parse(raw) as { agent_groups: SnapshotGroup[]; a2a_edges: unknown[] }), raw };
}

const SECRET = 'fake-linkedin-client-secret';
const TOKEN = 'fake-docs-bearer-token';
const ARG_TOKEN = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const SERVERS = {
  linkedin: {
    command: 'node',
    args: ['server.js', `--github-token=${ARG_TOKEN}`],
    env: { LINKEDIN_CLIENT_SECRET: SECRET, SERPER_API_KEY: 'onecli-managed' },
  },
  docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
};

interface FakeDashboard {
  port: number;
  /** Raw body of the first snapshot POSTed to /api/ingest. */
  ingest: Promise<string>;
  close: () => Promise<void>;
}

function startFakeDashboard(): Promise<FakeDashboard> {
  let deliver!: (body: string) => void;
  const ingest = new Promise<string>((resolve) => (deliver = resolve));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url === '/api/ingest') deliver(raw);
      res.writeHead(200);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        ingest,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  resetDashboardCaches();
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Ads',
    folder: 'ads',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-1');
  await updateContainerConfigJson('ag-1', 'mcp_servers', SERVERS);
});

afterEach(async () => {
  stopDashboardPusher();
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('dashboard snapshot — MCP secrets', () => {
  it('pushes each server with redacted env, header and credential-arg values', async () => {
    const dash = await startFakeDashboard();
    startDashboardPusher({ port: dash.port, secret: 'test-dashboard-secret' });
    const raw = await dash.ingest;
    await dash.close();

    // Nothing in the payload — any section, any encoding the UI never reads — carries a value.
    for (const value of [SECRET, TOKEN, ARG_TOKEN]) expect(raw).not.toContain(value);

    const hud = JSON.parse(raw).hud;
    expect(hud.cards.map((c: { id: string }) => c.id)).toEqual([
      'receivables',
      'ad_spend',
      'usage',
      'cron',
      'waiting',
      'plane',
      'walls',
    ]);
    expect(hud.cards.find((c: { id: string }) => c.id === 'receivables').value).toBeNull();
    expect(hud.generatedAt).toMatch(/Z$/);
    const groups = JSON.parse(raw).agent_groups as Array<{ id: string; container_config: { mcpServers: unknown } }>;
    expect(groups.find((g) => g.id === 'ag-1')?.container_config.mcpServers).toEqual({
      linkedin: {
        command: 'node',
        args: ['server.js', '<redacted>'],
        env: { LINKEDIN_CLIENT_SECRET: '<redacted>', SERPER_API_KEY: 'onecli-managed' },
      },
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: '<redacted>' } },
    });
  });
});

describe('dashboard snapshot — agent architecture + a2a edges', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-2',
      name: 'Builder',
      folder: 'builder',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig('ag-2');
  });

  it('carries tier, reports_to, role and a parsed persona per group (null when unset)', async () => {
    await updateAgentGroup('ag-2', {
      tier: 'worker',
      reports_to: 'ag-1',
      role: 'Executes build tasks for Zed',
      persona: '{"emoji":"🔧","color":"#1e90ff","initials":"BD"}',
    });

    const { agent_groups } = await pushOnce();
    const unset = agent_groups.find((g) => g.id === 'ag-1')!;
    expect(unset).toMatchObject({ tier: null, reports_to: null, role: null, persona: null, lastActiveAt: null });
    // Existing contract untouched: the redacted container_config is still there.
    expect(unset.container_config.mcpServers).toBeDefined();

    const set = agent_groups.find((g) => g.id === 'ag-2')!;
    expect(set).toMatchObject({
      tier: 'worker',
      reports_to: 'ag-1',
      role: 'Executes build tasks for Zed',
      persona: { emoji: '🔧', color: '#1e90ff', initials: 'BD' },
    });
  });

  it('derives lastActiveAt from the newest messages_out row across a group’s sessions', async () => {
    const newest = hoursAgo(1);
    writeOutboundDb('ag-1', 'sess-a', [
      { timestamp: hoursAgo(5), channel_type: 'telegram', platform_id: '123' },
      { timestamp: newest, channel_type: 'telegram', platform_id: '123' },
    ]);
    writeOutboundDb('ag-1', 'sess-b', [{ timestamp: hoursAgo(3), channel_type: 'telegram', platform_id: '123' }]);

    const { agent_groups } = await pushOnce();
    expect(agent_groups.find((g) => g.id === 'ag-1')!.lastActiveAt).toBe(newest);
    expect(agent_groups.find((g) => g.id === 'ag-2')!.lastActiveAt).toBeNull();
  });

  it('aggregates a2a_edges from agent-channel rows within 7 days and sorts them', async () => {
    const newest = hoursAgo(2);
    const reply = hoursAgo(6);
    writeOutboundDb('ag-1', 'sess-a', [
      { timestamp: hoursAgo(4), channel_type: 'agent', platform_id: 'ag-2' },
      { timestamp: newest, channel_type: 'agent', platform_id: 'ag-2' },
      { timestamp: hoursAgo(24 * 10), channel_type: 'agent', platform_id: 'ag-2' }, // outside the window
      { timestamp: hoursAgo(1), channel_type: 'telegram', platform_id: '123' }, // not a2a
    ]);
    writeOutboundDb('ag-2', 'sess-c', [{ timestamp: reply, channel_type: 'agent', platform_id: 'ag-1' }]);

    const { a2a_edges } = await pushOnce();
    expect(a2a_edges).toEqual([
      { from: 'ag-1', to: 'ag-2', count7d: 2, lastAt: newest },
      { from: 'ag-2', to: 'ag-1', count7d: 1, lastAt: reply },
    ]);
  });

  it('tolerates a corrupt outbound.db and still reports the healthy sessions', async () => {
    writeOutboundDb('ag-1', 'sess-a', [{ timestamp: hoursAgo(2), channel_type: 'agent', platform_id: 'ag-2' }]);
    const badDir = path.join(SESSIONS_DIR, 'ag-2', 'sess-broken');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'outbound.db'), 'definitely not a sqlite file');

    const { agent_groups, a2a_edges } = await pushOnce();
    expect(a2a_edges).toHaveLength(1);
    expect(agent_groups.find((g) => g.id === 'ag-1')!.lastActiveAt).not.toBeNull();
    expect(agent_groups.find((g) => g.id === 'ag-2')!.lastActiveAt).toBeNull();
  });

  it('reuses the per-file cache until the file changes', async () => {
    writeOutboundDb('ag-1', 'sess-a', [{ timestamp: hoursAgo(2), channel_type: 'agent', platform_id: 'ag-2' }]);
    const first = await pushOnce();
    expect((first.a2a_edges[0] as { count7d: number }).count7d).toBe(1);

    // Append a row (mtime/size change) → rescan picks it up.
    const db = new Database(path.join(SESSIONS_DIR, 'ag-1', 'sess-a', 'outbound.db'));
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES ('m-extra', 99, ?, 'chat', 'ag-2', 'agent', '{}')`,
    ).run(hoursAgo(1));
    db.close();
    const second = await pushOnce();
    expect((second.a2a_edges[0] as { count7d: number }).count7d).toBe(2);
  });
});

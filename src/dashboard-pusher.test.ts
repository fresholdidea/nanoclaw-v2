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

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { startDashboardPusher, stopDashboardPusher } from './dashboard-pusher.js';

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

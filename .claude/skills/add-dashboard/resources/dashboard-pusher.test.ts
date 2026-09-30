/**
 * Integration test for the add-dashboard skill's integration point —
 * `startDashboard()`, the single call wired into src/index.ts.
 *
 * Archetype: in-process seam. It drives the *real* entry point against a
 * *real* (in-memory) central DB and a *fake* dashboard HTTP endpoint. The
 * only things stubbed are the external dashboard package (not needed to prove
 * the wiring) and env-file reads (so the test doesn't depend on the real
 * .env). This proves the skill works once applied: with a secret set it
 * collects a DB snapshot and posts it; with no secret it does nothing. The
 * dashboard serves that snapshot back as JSON, so MCP server env and header
 * values must reach it as `<redacted>`, never as the stored credentials.
 *
 * Ships with the add-dashboard skill; apply copies it to src/ alongside the
 * pusher so it runs against the composed project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-dashboard', ASSISTANT_NAME: 'TestBot' };
});
// The dashboard server package isn't needed to prove the integration point.
vi.mock('@nanoco/nanoclaw-dashboard', () => ({ startDashboard: vi.fn() }));
// Don't read the real .env — the test controls config via process.env only.
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

const TEST_DIR = '/tmp/nanoclaw-test-dashboard';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { startDashboard, stopDashboardPusher } from './dashboard-pusher.js';

function now(): string {
  return new Date().toISOString();
}

const MCP_SECRET = 'fake-linkedin-client-secret';
const MCP_TOKEN = 'fake-docs-bearer-token';
const MCP_ARG_TOKEN = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const MCP_SERVERS = {
  linkedin: {
    command: 'node',
    args: ['server.js', `--github-token=${MCP_ARG_TOKEN}`],
    env: { LINKEDIN_CLIENT_SECRET: MCP_SECRET, SERPER_API_KEY: 'onecli-managed' },
  },
  docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
};

interface CapturedPost {
  path: string;
  auth: string | undefined;
  /** The body exactly as sent, for checks that must not depend on its shape. */
  raw: string;
  body: Record<string, unknown>;
}

/** A fake dashboard server that captures the bodies the pusher POSTs. */
function startFakeDashboard(): Promise<{ port: number; posts: CapturedPost[]; close: () => Promise<void> }> {
  const posts: CapturedPost[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave empty */
      }
      posts.push({ path: req.url || '', auth: req.headers.authorization, raw, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, posts, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('add-dashboard integration point (startDashboard)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
  });

  afterEach(async () => {
    stopDashboardPusher();
    await closeDb();
    delete process.env.DASHBOARD_SECRET;
    delete process.env.DASHBOARD_PORT;
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('posts a snapshot of the seeded state when DASHBOARD_SECRET is set', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });

    const dash = await startFakeDashboard();
    process.env.DASHBOARD_SECRET = 'test-secret';
    process.env.DASHBOARD_PORT = String(dash.port);

    await startDashboard();

    await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));

    const ingest = dash.posts.find((p) => p.path === '/api/ingest')!;
    expect(ingest.auth).toBe('Bearer test-secret');
    expect(ingest.body.assistant_name).toBe('TestBot');

    const groups = ingest.body.agent_groups as Array<{ id: string }>;
    expect(groups.map((g) => g.id)).toContain('ag-1');

    for (const key of [
      'timestamp',
      'sessions',
      'channels',
      'users',
      'tokens',
      'context_windows',
      'activity',
      'messages',
    ]) {
      expect(ingest.body).toHaveProperty(key);
    }

    await dash.close();
  });

  it('pushes MCP servers with redacted env, header and credential-arg values', async () => {
    await createAgentGroup({ id: 'ag-1', name: 'Ads', folder: 'ads', agent_provider: null, created_at: now() });
    await ensureContainerConfig('ag-1');
    await updateContainerConfigJson('ag-1', 'mcp_servers', MCP_SERVERS);

    const dash = await startFakeDashboard();
    process.env.DASHBOARD_SECRET = 'test-secret';
    process.env.DASHBOARD_PORT = String(dash.port);

    await startDashboard();
    await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));
    await dash.close();

    const ingest = dash.posts.find((p) => p.path === '/api/ingest')!;
    // Nothing in the payload — any section, any encoding the UI never reads — carries a value.
    for (const value of [MCP_SECRET, MCP_TOKEN, MCP_ARG_TOKEN]) expect(ingest.raw).not.toContain(value);

    const groups = ingest.body.agent_groups as Array<{ id: string; container_config: { mcpServers?: unknown } | null }>;
    expect(groups.find((g) => g.id === 'ag-1')?.container_config?.mcpServers).toEqual({
      linkedin: {
        command: 'node',
        args: ['server.js', '<redacted>'],
        env: { LINKEDIN_CLIENT_SECRET: '<redacted>', SERPER_API_KEY: 'onecli-managed' },
      },
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: '<redacted>' } },
    });
  });

  it('does nothing when DASHBOARD_SECRET is not set', async () => {
    const dash = await startFakeDashboard();
    // no DASHBOARD_SECRET in env, and readEnvFile is stubbed to {}

    await startDashboard();
    await new Promise((r) => setTimeout(r, 100));

    expect(dash.posts).toHaveLength(0);
    await dash.close();
  });
});

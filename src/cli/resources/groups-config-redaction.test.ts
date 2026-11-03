/**
 * MCP server env and header values are credentials. `ncl groups config get`
 * is open to container agents, and a `global`-scope agent can read every
 * group's config — so an agent caller must see the keys with `<redacted>`
 * values (placeholders excepted), never the stored values, or they land in
 * model context and session transcripts. Host operators keep the values.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-cli-config-redaction';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-cli-config-redaction/groups',
  DATA_DIR: '/tmp/nanoclaw-test-cli-config-redaction/data',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { lookup } from '../registry.js';
// Side-effect import: registers the `groups-*` commands.
import './groups.js';

const SECRET = 'fake-linkedin-client-secret';
const TOKEN = 'fake-docs-bearer-token';

const SERVERS = {
  linkedin: {
    command: 'node',
    args: ['server.js'],
    env: { LINKEDIN_CLIENT_SECRET: SECRET, SERPER_API_KEY: 'onecli-managed' },
  },
  docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
};

const REDACTED = {
  linkedin: {
    command: 'node',
    args: ['server.js'],
    env: { LINKEDIN_CLIENT_SECRET: '<redacted>', SERPER_API_KEY: 'onecli-managed' },
  },
  docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: '<redacted>' } },
};

function agent(group: string): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: `sess-${group}`, messagingGroupId: 'mg-1' };
}

async function configGet(id: string, ctx: CallerContext) {
  return dispatch({ id: 'req-1', command: 'groups-config-get', args: { id } }, ctx);
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  for (const id of ['ag-own', 'ag-other', 'ag-global']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(id);
  }
  await updateContainerConfigJson('ag-own', 'mcp_servers', SERVERS);
  await updateContainerConfigJson('ag-other', 'mcp_servers', SERVERS);
  await updateContainerConfigScalars('ag-global', { cli_scope: 'global' });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('ncl groups config get — MCP secrets', () => {
  it('redacts env and header values for an agent reading its own group', async () => {
    const res = await configGet('ag-own', agent('ag-own'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.data as { mcp_servers: unknown }).mcp_servers).toEqual(REDACTED);
    // `human` is rendered from the same data; no channel of the frame may carry a value.
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("redacts another group's values for a global-scope agent", async () => {
    const res = await configGet('ag-other', agent('ag-global'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.data as { mcp_servers: unknown }).mcp_servers).toEqual(REDACTED);
  });

  it('shows the stored values to a host operator', async () => {
    const res = await configGet('ag-own', { caller: 'host' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.data as { mcp_servers: unknown }).mcp_servers).toEqual(SERVERS);
  });
});

// Handler-level: what an approved agent request resolves to, independent of
// the approval hold in front of it.
describe('config verbs that echo servers back to an agent', () => {
  it('config add-mcp-server redacts the returned server map but stores the real value', async () => {
    const data = await lookup('groups-config-add-mcp-server')!.handler(
      { id: 'ag-own', name: 'extra', command: 'npx', env: JSON.stringify({ EXTRA_API_KEY: 'fake-extra-key' }) },
      agent('ag-own'),
    );
    expect(JSON.stringify(data)).not.toContain('fake-extra-key');
    expect(JSON.stringify(data)).not.toContain(SECRET);
    const stored = JSON.parse((await getContainerConfig('ag-own'))!.mcp_servers);
    expect(stored.extra.env.EXTRA_API_KEY).toBe('fake-extra-key');
    expect(stored.linkedin.env.LINKEDIN_CLIENT_SECRET).toBe(SECRET);
  });

  it('config update redacts the returned config', async () => {
    const data = await lookup('groups-config-update')!.handler(
      { id: 'ag-own', model: 'claude-sonnet-5' },
      agent('ag-own'),
    );
    expect((data as { mcp_servers: unknown }).mcp_servers).toEqual(REDACTED);
  });
});

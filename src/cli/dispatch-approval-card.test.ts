/**
 * The `ncl` approval card is posted to the approver's chat (Telegram, Slack)
 * and stays in that platform's history. A held `groups config add-mcp-server`
 * carries credentials in `--env` / `--headers` / `--args`, so the card must
 * render secret-shaped values as the self-mod card's fingerprint placeholder
 * — while the pending_approvals payload keeps them verbatim, because the
 * approved replay applies exactly what was stored.
 *
 * Real central DB and approval primitive; the delivery adapter is a fake that
 * records each card's question text. Every input shape the card renderer must
 * survive is covered in approval-card.test.ts.
 */
import { createHash } from 'node:crypto';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-cli-approval-card';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-cli-approval-card/groups',
  DATA_DIR: '/tmp/nanoclaw-test-cli-approval-card/data',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../db/container-configs.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../db/sessions.js';
import { setDeliveryAdapter } from '../delivery.js';
import { upsertUserDm } from '../modules/permissions/db/user-dms.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { PendingApproval } from '../types.js';
import { dispatch } from './dispatch.js';
import type { CallerContext, RequestFrame } from './frame.js';
// Side-effect import: registers the `groups-*` commands.
import './resources/groups.js';

const AGENT: CallerContext = { caller: 'agent', agentGroupId: 'ag-1', sessionId: 'sess-1', messagingGroupId: 'mg-1' };

const API_KEY = 'fake-extra-api-key-value'; // secret by env KEY (EXTRA_API_KEY)
const ARG_TOKEN = 'ghp_fakefakefake1234'; // secret by VALUE prefix, in args

let cards: string[];

function redactedForm(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<redacted: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${digest}>`;
}

/** Dispatch a held add-mcp-server as the agent; return the delivered card text and the stored row. */
async function holdAddMcpServer(args: Record<string, unknown>): Promise<{ question: string; row: PendingApproval }> {
  const res = await dispatch({ id: 'req-1', command: 'groups-config-add-mcp-server', args }, AGENT);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error.code).toBe('approval-pending');
  const rows = await getPendingApprovalsByAction('cli_command');
  expect(rows).toHaveLength(1);
  expect(cards).toHaveLength(1);
  return { question: cards[0], row: rows[0] };
}

function storedFrame(row: PendingApproval): { frame: RequestFrame; callerContext: CallerContext } {
  return JSON.parse(row.payload) as { frame: RequestFrame; callerContext: CallerContext };
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now });
  await ensureContainerConfig('ag-1');
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now,
    created_at: now,
  });
  // An owner with a cached DM, so the card resolves a delivery target.
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now });
  await grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: 'slack',
    platform_id: 'D-admin-1',
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: 'slack',
    messaging_group_id: 'mg-dm-1',
    resolved_at: now,
  });

  cards = [];
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      cards.push((JSON.parse(content) as { question: string }).question);
      return 'pm-1';
    },
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('ncl approval card — MCP secrets', () => {
  it('redacts --env and --args secrets on the card, keeps them verbatim in the payload, and replays them', async () => {
    const env = JSON.stringify({ EXTRA_API_KEY: API_KEY, LOG_LEVEL: 'debug' });
    const args = JSON.stringify(['-y', 'extra-mcp', '--token', ARG_TOKEN]);

    const { question, row } = await holdAddMcpServer({ name: 'extra', command: 'npx', args, env });

    for (const secret of [API_KEY, ARG_TOKEN]) {
      expect(question).not.toContain(secret);
      expect(question).toContain(redactedForm(secret));
      // The row keeps the card body for the terminal-state edit — same text.
      expect(row.question).not.toContain(secret);
    }
    // The rest of the card stays reviewable.
    expect(question).toContain('ncl groups-config-add-mcp-server');
    expect(question).toContain('--name extra');
    expect(question).toContain('"LOG_LEVEL":"debug"');
    expect(question).toContain('"--token"');

    const { frame, callerContext } = storedFrame(row);
    expect(frame.args.env).toBe(env);
    expect(frame.args.args).toBe(args);

    // The approved replay applies the verbatim values.
    const res = await dispatch(frame, callerContext, { grant: row });
    expect(res.ok).toBe(true);
    const stored = JSON.parse((await getContainerConfig('ag-1'))!.mcp_servers);
    expect(stored.extra.env).toEqual({ EXTRA_API_KEY: API_KEY, LOG_LEVEL: 'debug' });
    expect(stored.extra.args).toEqual(['-y', 'extra-mcp', '--token', ARG_TOKEN]);
  });

  it('redacts credential --headers, hyphenated header names included, and keeps them verbatim in the payload', async () => {
    const bearer = 'Bearer fake-bearer-token-value';
    const xApiKey = 'fake-x-api-key-value';
    const headers = JSON.stringify({ Authorization: bearer, 'X-Api-Key': xApiKey, Accept: 'application/json' });

    const { question, row } = await holdAddMcpServer({ name: 'docs', url: 'https://mcp.example.com/mcp', headers });

    for (const secret of [bearer, xApiKey]) {
      expect(question).not.toContain(secret);
      expect(question).toContain(redactedForm(secret));
      expect(row.question).not.toContain(secret);
    }
    expect(question).toContain('"Accept":"application/json"');
    expect(storedFrame(row).frame.args.headers).toBe(headers);
  });
});

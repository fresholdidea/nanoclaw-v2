/**
 * Thread-scoped wirings (migration 024, `messaging_group_agents.thread_filter`).
 *
 * One chat, two wirings: an unscoped orchestrator and a specialist scoped to
 * a single topic. A message in the specialist's topic must reach ONLY the
 * specialist (the orchestrator stands down); a message anywhere else must
 * reach ONLY the orchestrator. Exercised through the real routeInbound path.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-filter' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getDb } from './db/connection.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-thread-filter';
const CHAT = 'testchat:-100';
const MESH_TOPIC = `${CHAT}:4`;

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function seed(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  for (const [id, folder] of [
    ['ag-zed', 'zed'],
    ['ag-mesh', 'meshberg-am'],
  ]) {
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-ops',
    channel_type: 'testchat',
    platform_id: CHAT,
    instance: 'testchat',
    name: 'Daily Ops',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const base = {
    messaging_group_id: 'mg-ops',
    engage_mode: 'pattern' as const,
    engage_pattern: '.',
    sender_scope: 'all' as const,
    ignored_message_policy: 'drop' as const,
    session_mode: 'per-thread' as const,
    priority: 0,
    threads: 1,
    created_at: now(),
  };
  await createMessagingGroupAgent({ ...base, id: 'w-zed', agent_group_id: 'ag-zed' });
  await createMessagingGroupAgent({ ...base, id: 'w-mesh', agent_group_id: 'ag-mesh', thread_filter: MESH_TOPIC });
}

async function inbound(id: string, threadId: string | null): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: CHAT,
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Brad', senderId: 'U1', text: `msg ${id}` }),
      timestamp: now(),
      isMention: false,
      isGroup: true,
    },
  });
}

async function sessionsByAgent(): Promise<Record<string, string[]>> {
  const rows = await getDb().all<{ agent_group_id: string; thread_id: string | null }>(
    'SELECT agent_group_id, thread_id FROM sessions ORDER BY agent_group_id, thread_id',
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.agent_group_id] ??= []).push(String(r.thread_id));
  return out;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  await seed();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('thread-scoped wirings', () => {
  it('routes the scoped topic to the specialist only', async () => {
    await inbound('m1', MESH_TOPIC);
    expect(await sessionsByAgent()).toEqual({ 'ag-mesh': [MESH_TOPIC] });
  });

  it('routes every other topic, and the top level, to the orchestrator only', async () => {
    await inbound('m2', `${CHAT}:9`);
    await inbound('m3', null);
    expect(await sessionsByAgent()).toEqual({ 'ag-zed': ['null', `${CHAT}:9`] });
  });

  it('honors a multi-topic filter', async () => {
    await getDb().run(
      "UPDATE messaging_group_agents SET thread_filter = ? WHERE id = 'w-mesh'",
      `${MESH_TOPIC},${CHAT}:20`,
    );
    await inbound('m6', `${CHAT}:20`);
    await inbound('m7', `${CHAT}:21`);
    expect(await sessionsByAgent()).toEqual({ 'ag-mesh': [`${CHAT}:20`], 'ag-zed': [`${CHAT}:21`] });
  });

  it('keeps both agents independent across topics in one chat', async () => {
    await inbound('m4', MESH_TOPIC);
    await inbound('m5', `${CHAT}:9`);
    expect(await sessionsByAgent()).toEqual({ 'ag-mesh': [MESH_TOPIC], 'ag-zed': [`${CHAT}:9`] });
  });
});

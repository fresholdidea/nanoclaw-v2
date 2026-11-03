/**
 * Regression test for #2525 — `ncl groups delete` must cascade dependent
 * rows in FK order so the final `DELETE FROM agent_groups` succeeds even
 * when the group has sessions, destinations, approvals, role grants, etc.
 *
 * The bug pre-fix: the generic single-table DELETE handler ran a bare
 * `DELETE FROM agent_groups WHERE id = ?` which always failed with a
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when anything pointed at the group.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch
 * with the host caller — same code path a real approval would take.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockResolvedValue(0),
}));
// The allowlist path is a module-level const in production; route it through a
// getter so the mount tests can point it at a per-test temp file.
const mockState = vi.hoisted(() => ({ allowlistPath: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-groups',
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import { projectDestinationsToSessions } from './destinations.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { validateMount } from '../../modules/mount-security/index.js';
import { configFromDb } from '../../container-config.js';
import type { ContainerConfig } from '../../container-config.js';
// Side-effect import: registers the `groups-*` commands (including delete).
import './groups.js';
// Side-effect import: registers Claude's host contract (the `--speed` vocabulary source).
import '../../provider-contracts/index.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  registerProviderHostContract,
} from '../../provider-contracts/registry.js';

/** A provider whose only speed tier is one Claude never declared. */
const TURBO_PROVIDER = 'turbo-test-provider';
registerProviderHostContract(TURBO_PROVIDER, {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  projectDocument: { fileName: 'AGENTS.md', containerPath: '/workspace/agent/AGENTS.md', mountClass: 'group-state' },
  stateVolumes: [],
  skillBackings: [],
  skillViews: [],
  files: [],
  inference: { speedTiers: ['turbo'] },
});
/** A provider with a host contract but no inference declaration. */
const TIERLESS_PROVIDER = 'tierless-test-provider';
registerProviderHostContract(TIERLESS_PROVIDER, {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  projectDocument: { fileName: 'AGENTS.md', containerPath: '/workspace/agent/AGENTS.md', mountClass: 'group-state' },
  stateVolumes: [],
  skillBackings: [],
  skillViews: [],
  files: [],
});

function now(): string {
  return new Date().toISOString();
}

function errorMessage(res: Awaited<ReturnType<typeof dispatch>>): string | undefined {
  return res.ok ? undefined : res.error.message;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await getDb().get<{ c: number }>(sql, ...params))!.c;
}

async function createGroupWithSession(groupId: string, sessionId: string): Promise<void> {
  await createAgentGroup({ id: groupId, name: groupId, folder: groupId, agent_provider: null, created_at: now() });
  await createSession({
    id: sessionId,
    agent_group_id: groupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
}

describe('groups CLI delete cascades dependent rows (#2525)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = await initTestDb();
    await runMigrations(db);
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('waits for host-side group restarts and returns their resolved count', async () => {
    vi.mocked(restartAgentGroupContainers).mockResolvedValueOnce(3);

    const response = await dispatch(
      { id: 'req-restart', command: 'groups-restart', args: { id: 'ag-restart' } },
      { caller: 'host' },
    );

    expect(response).toEqual({ id: 'req-restart', ok: true, data: { restarted: 3, rebuilt: false } });
  });

  it('deletes a group with sessions, destinations, approvals, members, roles, and wirings', async () => {
    const GID = 'ag-victim';
    const SID = 'sess-victim-1';
    const MGID = 'mg-1';
    const UID = 'tg:42';

    await createAgentGroup({ id: GID, name: 'victim', folder: 'victim', agent_provider: null, created_at: now() });
    await createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const db = getDb();

    // Direct inserts for the dependent tables. Keeps the fixture minimal —
    // we only need rows that establish FK relationships, not full domain
    // entities.
    await db.run(
      `INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`,
      UID,
      now(),
    );
    await db.run(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
      MGID,
      now(),
    );

    await db.run(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'chan', 'channel', ?, ?)`,
      GID,
      MGID,
      now(),
    );

    await db.run(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
      'q-1',
      SID,
      now(),
    );

    await db.run(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
      'pa-1',
      SID,
      now(),
      GID,
    );

    await db.run(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-1', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
      MGID,
      GID,
      UID,
      now(),
    );

    await db.run(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
      MGID,
      GID,
      UID,
      now(),
    );

    await db.run(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
      MGID,
      GID,
      now(),
    );

    await db.run(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
      UID,
      GID,
      now(),
    );

    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
      UID,
      GID,
      now(),
    );

    // Container config row exercises the ON DELETE CASCADE on container_configs.
    await db.run(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      GID,
      now(),
    );

    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: GID } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { deleted: string; removed: Record<string, number> } }).data;
    expect(data.deleted).toBe(GID);
    expect(data.removed).toMatchObject({
      sessions: 1,
      pending_questions: 1,
      pending_approvals: 1,
      agent_destinations_owned: 1,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 1,
      pending_channel_approvals: 1,
      messaging_group_agents: 1,
      agent_group_members: 1,
      user_roles: 1,
      container_configs: 1,
    });

    // The group and every dependent row must be gone.
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM pending_questions WHERE session_id = ?', SID)).toBe(0);
    expect(
      await count('SELECT COUNT(*) AS c FROM pending_approvals WHERE agent_group_id = ? OR session_id = ?', GID, SID),
    ).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM agent_group_members WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);

    // Unrelated tables untouched.
    expect(await count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(await count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('removes polymorphic agent_destinations that point at the deleted group', async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    await createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });

    const db = getDb();

    // B has a destination pointing at A. target_id is polymorphic — no FK
    // constraint enforces it, so without explicit cleanup the row would
    // dangle after A is deleted.
    await db.run(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'sibling', 'agent', ?, ?)`,
      B,
      A,
      now(),
    );

    const resp = await dispatch({ id: 'req-del-a', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_destinations_pointing).toBe(1);

    // A is gone, B remains, and B's stale destination is cleaned up.
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', A)).toBe(0);
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', B)).toBe(1);
    expect(await count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', B)).toBe(0);
  });

  it("clears the host-coordination rows of the group's sessions and leaves another group's alone", async () => {
    const coordinationRows = async (sessionId: string) => ({
      session_claims: await count('SELECT COUNT(*) AS c FROM session_claims WHERE session_id = ?', sessionId),
      delivery_attempts: await count('SELECT COUNT(*) AS c FROM delivery_attempts WHERE session_id = ?', sessionId),
      wake_signals: await count('SELECT COUNT(*) AS c FROM wake_signals WHERE session_id = ?', sessionId),
    });
    const db = getDb();
    // No FK on these tables (migration 024), so nothing stops them outliving their session.
    for (const [groupId, sessionId] of [
      ['ag-victim', 'sess-victim'],
      ['ag-other', 'sess-other'],
    ]) {
      await createGroupWithSession(groupId, sessionId);
      await db.run(
        `INSERT INTO session_claims (session_id, incarnation, updated_at) VALUES (?, 1, ?)`,
        sessionId,
        now(),
      );
      await db.run(
        `INSERT INTO delivery_attempts (message_id, session_id, attempts) VALUES (?, ?, 1)`,
        `out-${sessionId}`,
        sessionId,
      );
      await db.run(
        `INSERT INTO wake_signals (id, session_id, reason, created_at) VALUES (?, ?, 'mail', ?)`,
        `wake-${sessionId}`,
        sessionId,
        now(),
      );
    }

    const resp = await dispatch(
      { id: 'req-del-coord', command: 'groups-delete', args: { id: 'ag-victim' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed).toMatchObject({ sessions: 1, session_claims: 1, delivery_attempts: 1, wake_signals: 1 });
    expect(await coordinationRows('sess-victim')).toEqual({ session_claims: 0, delivery_attempts: 0, wake_signals: 0 });
    expect(await coordinationRows('sess-other')).toEqual({ session_claims: 1, delivery_attempts: 1, wake_signals: 1 });
    expect(await count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', 'ag-other')).toBe(1);
  });

  it("drops the deleted group from a surviving agent's inbound.db destinations", async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    const C = 'ag-c';
    await createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: C, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    await createGroupWithSession(B, 'sess-b');
    for (const [localName, target] of [
      ['to-a', A],
      ['to-c', C],
    ]) {
      await getDb().run(
        `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
         VALUES (?, ?, 'agent', ?, ?)`,
        B,
        localName,
        target,
        now(),
      );
    }
    const projected = () => {
      const inbound = new Database(inboundDbPath(B, 'sess-b'), { readonly: true });
      const names = (
        inbound.prepare('SELECT name FROM destinations ORDER BY name').all() as Array<{ name: string }>
      ).map((row) => row.name);
      inbound.close();
      return names;
    };
    initSessionFolder(B, 'sess-b');
    await projectDestinationsToSessions(B);
    expect(projected()).toEqual(['to-a', 'to-c']);

    const resp = await dispatch({ id: 'req-del-proj', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    expect(projected()).toEqual(['to-c']);
  });

  it('returns a handler error for an unknown group id', async () => {
    const resp = await dispatch(
      { id: 'req-missing', command: 'groups-delete', args: { id: 'ag-does-not-exist' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(/not found/i);
  });
});

describe('groups config (host-only)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
  });
  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('adds a mount idempotently and removes it (host caller)', async () => {
    const GID = 'ag-mount';
    await createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    await ensureContainerConfig(GID);
    // containerPath is relative: the validator rejects absolute paths and
    // mounts every entry under /workspace/extra/, so an absolute fixture here
    // would model a mount that can never take effect.
    const args = { id: GID, host: '/data/.gmail-mcp', container: '.gmail-mcp', ro: true };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse((await getContainerConfig(GID))!.additional_mounts)).toEqual([
      { hostPath: '/data/.gmail-mcp', containerPath: '.gmail-mcp', readonly: true },
    ]);

    // idempotent: a second add does not duplicate
    await dispatch({ id: 'r2', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(JSON.parse((await getContainerConfig(GID))!.additional_mounts)).toHaveLength(1);

    const rm = await dispatch(
      {
        id: 'r3',
        command: 'groups-config-remove-mount',
        args: { id: GID, host: '/data/.gmail-mcp', container: '.gmail-mcp' },
      },
      { caller: 'host' },
    );
    expect(rm.ok).toBe(true);
    expect(JSON.parse((await getContainerConfig(GID))!.additional_mounts)).toEqual([]);
  });

  describe("--speed validates against the tiers the group's provider declares", () => {
    const GID = 'ag-speed';
    const speedOf = async (): Promise<string | null> => (await getContainerConfig(GID))!.speed;
    const setSpeed = (speed: string, extra: Record<string, unknown> = {}) =>
      dispatch(
        { id: `speed-${speed}`, command: 'groups-config-update', args: { id: GID, speed, ...extra } },
        { caller: 'host' },
      );

    beforeEach(async () => {
      await createAgentGroup({ id: GID, name: 's', folder: 's', agent_provider: null, created_at: now() });
      await ensureContainerConfig(GID);
    });

    it('accepts each tier Claude declares for a group on the default provider', async () => {
      for (const speed of ['standard', 'fast']) {
        expect((await setSpeed(speed)).ok).toBe(true);
        expect(await speedOf()).toBe(speed);
      }
    });

    it('rejects an undeclared tier, names the provider and its tiers, and writes nothing', async () => {
      await setSpeed('fast');
      const rejected = await setSpeed('turbo');
      expect(rejected.ok).toBe(false);
      expect(errorMessage(rejected)).toBe(
        '--speed "turbo" is not a speed tier of provider "claude" (declared: standard, fast)',
      );
      expect(await speedOf()).toBe('fast');
    });

    it('clears to NULL on "" for any provider', async () => {
      await setSpeed('fast');
      expect((await setSpeed('')).ok).toBe(true);
      expect(await speedOf()).toBeNull();

      await dispatch(
        { id: 'p', command: 'groups-config-update', args: { id: GID, provider: TIERLESS_PROVIDER } },
        { caller: 'host' },
      );
      expect((await setSpeed('')).ok).toBe(true);
      expect(await speedOf()).toBeNull();
    });

    it('rejects every non-empty value for a provider with no host contract', async () => {
      await dispatch(
        { id: 'p', command: 'groups-config-update', args: { id: GID, provider: 'no-such-provider' } },
        { caller: 'host' },
      );
      for (const speed of ['standard', 'fast', 'turbo']) {
        const rejected = await setSpeed(speed);
        expect(rejected.ok).toBe(false);
        expect(errorMessage(rejected)).toBe(
          'provider "no-such-provider" declares no speed tiers; --speed accepts only "" (clear)',
        );
      }
      expect(await speedOf()).toBeNull();
    });

    it('rejects every non-empty value for a provider whose contract declares no inference', async () => {
      await dispatch(
        { id: 'p', command: 'groups-config-update', args: { id: GID, provider: TIERLESS_PROVIDER } },
        { caller: 'host' },
      );
      const rejected = await setSpeed('fast');
      expect(rejected.ok).toBe(false);
      expect(errorMessage(rejected)).toBe(
        `provider "${TIERLESS_PROVIDER}" declares no speed tiers; --speed accepts only "" (clear)`,
      );
      expect(await speedOf()).toBeNull();
    });

    it('validates --provider X --speed Y against X and passes a provider-specific tier through to container.json', async () => {
      // Claude does not know `turbo`, so the new provider must be the one consulted.
      const switched = await setSpeed('turbo', { provider: TURBO_PROVIDER });
      expect(switched.ok).toBe(true);
      const row = (await getContainerConfig(GID))!;
      expect(row.provider).toBe(TURBO_PROVIDER);
      expect(row.speed).toBe('turbo');

      // Stored → materialized: the tier lands in container.json verbatim, and
      // the legacy `fastMode` mirror is written only for `fast`.
      const group = { id: GID, name: 's', folder: 's', agent_provider: null, created_at: now() };
      const materialized = JSON.parse(JSON.stringify(configFromDb(row, group))) as ContainerConfig;
      expect(materialized.speed).toBe('turbo');
      expect(Object.keys(materialized)).not.toContain('fastMode');

      // And the other direction: switching to Claude in the same command re-validates against Claude.
      const back = await setSpeed('turbo', { provider: 'claude' });
      expect(back.ok).toBe(false);
      expect(errorMessage(back)).toBe(
        '--speed "turbo" is not a speed tier of provider "claude" (declared: standard, fast)',
      );
      expect((await getContainerConfig(GID))!.provider).toBe(TURBO_PROVIDER);
      expect(await speedOf()).toBe('turbo');
    });
  });
});

/**
 * Regression: `add-mount` could not express read-write intent.
 *
 * The validator grants read-write only on an explicit `readonly: false`
 * (mount-security/index.ts) — an omitted key is forced read-only. The handler
 * only ever emitted `readonly: true` (with --ro) or omitted the key, so every
 * mount created through the CLI came out read-only and RW mounts had to be
 * hand-written into `container_configs`. Live symptom: a group with ~/.mnemon
 * mounted could read the store but every write failed with "Read-only file
 * system".
 *
 * These tests run the CLI intent all the way through the validator, because
 * the JSON shape alone is not the contract that broke.
 */
describe('groups config add-mount readonly intent (--ro / --rw)', () => {
  const GID = 'ag-mount-rw';
  let hostRoot: string;
  let seq = 0;

  /** Point the validator at a fresh allowlist granting (or refusing) RW under `hostRoot`. */
  function writeAllowlist(allowReadWrite: boolean): void {
    // A new file per call: the loader caches on path + mtime, and mtime alone
    // is too coarse to distinguish rewrites within a test run.
    const file = path.join(TEST_DIR, `mount-allowlist-${seq++}.json`);
    fs.writeFileSync(file, JSON.stringify({ allowedRoots: [{ path: hostRoot, allowReadWrite }], blockedPatterns: [] }));
    mockState.allowlistPath = file;
  }

  async function addMount(dir: string, extra: Record<string, unknown>): Promise<{ ok: boolean }> {
    fs.mkdirSync(path.join(hostRoot, dir), { recursive: true });
    return dispatch(
      {
        id: `r-${dir}`,
        command: 'groups-config-add-mount',
        args: { id: GID, host: path.join(hostRoot, dir), container: dir, ...extra },
      },
      { caller: 'host' },
    );
  }

  /** The mount as stored, looked up by its container path. */
  async function stored(dir: string): Promise<{ hostPath: string; containerPath: string; readonly?: boolean }> {
    const mounts = JSON.parse((await getContainerConfig(GID))!.additional_mounts) as Array<{
      hostPath: string;
      containerPath: string;
      readonly?: boolean;
    }>;
    const found = mounts.find((m) => m.containerPath === dir);
    if (!found) throw new Error(`no mount stored for ${dir}`);
    return found;
  }

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    hostRoot = path.join(TEST_DIR, 'hostroot');
    fs.mkdirSync(hostRoot, { recursive: true });

    await runMigrations(await initTestDb());
    await createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    await ensureContainerConfig(GID);
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('writes readonly: false for --rw and read-write survives to the validator', async () => {
    writeAllowlist(true);
    expect((await addMount('rw', { rw: true })).ok).toBe(true);

    const mount = await stored('rw');
    expect(mount.readonly).toBe(false);
    const result = validateMount(mount);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('writes readonly: true for --ro', async () => {
    writeAllowlist(true);
    expect((await addMount('ro', { ro: true })).ok).toBe(true);

    const mount = await stored('ro');
    expect(mount.readonly).toBe(true);
    expect(validateMount(mount).effectiveReadonly).toBe(true);
  });

  it('omits the key with no flag, which the validator forces to read-only', async () => {
    // Same allowlist as the --rw case: only the CLI intent differs.
    writeAllowlist(true);
    expect((await addMount('plain', {})).ok).toBe(true);

    const mount = await stored('plain');
    expect(mount).not.toHaveProperty('readonly');
    expect(validateMount(mount).effectiveReadonly).toBe(true);
  });

  it('downgrades --rw to read-only when the allowlist root refuses read-write', async () => {
    writeAllowlist(false);
    expect((await addMount('denied', { rw: true })).ok).toBe(true);

    // The CLI records the intent; the allowlist is what actually decides.
    const mount = await stored('denied');
    expect(mount.readonly).toBe(false);
    const result = validateMount(mount);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('rejects --ro and --rw together instead of silently picking one', async () => {
    writeAllowlist(true);
    const resp = await addMount('both', { ro: true, rw: true });

    expect(resp.ok).toBe(false);
    const err = (resp as { ok: false; error: { code: string; message: string } }).error;
    expect(err.code).toBe('handler-error');
    expect(err.message).toMatch(/mutually exclusive/i);
    expect(JSON.parse((await getContainerConfig(GID))!.additional_mounts)).toEqual([]);
  });

  it('reads --rw false as false rather than as a truthy string', async () => {
    writeAllowlist(true);
    expect((await addMount('explicit-false', { rw: 'false' })).ok).toBe(true);

    expect(await stored('explicit-false')).not.toHaveProperty('readonly');
  });
});

describe('groups update — architecture columns (tier / reports_to / role / persona)', () => {
  const ZED = 'ag-zed';
  const BUILDER = 'ag-builder';

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
    await createAgentGroup({ id: ZED, name: 'Zed', folder: 'zed', agent_provider: null, created_at: now() });
    await createAgentGroup({
      id: BUILDER,
      name: 'Builder',
      folder: 'builder',
      agent_provider: null,
      created_at: now(),
    });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  const update = (id: string, args: Record<string, unknown>) =>
    dispatch({ id: 'req', command: 'groups-update', args: { id, ...args } }, { caller: 'host' });

  it('sets every column, canonicalizes persona, and surfaces them on get/list', async () => {
    const resp = await update(BUILDER, {
      tier: 'worker',
      'reports-to': ZED,
      role: '  Executes build tasks for Zed  ',
      persona: '{"initials":"BD","emoji":"🔧","color":" #1e90ff "}',
    });
    expect(errorMessage(resp)).toBeUndefined();

    const got = await dispatch({ id: 'g', command: 'groups-get', args: { id: BUILDER } }, { caller: 'host' });
    expect(got.ok && got.data).toMatchObject({
      id: BUILDER,
      tier: 'worker',
      reports_to: ZED,
      role: 'Executes build tasks for Zed',
      persona: JSON.stringify({ initials: 'BD', emoji: '🔧', color: '#1e90ff' }),
    });

    const listed = await dispatch({ id: 'l', command: 'groups-list', args: { tier: 'worker' } }, { caller: 'host' });
    expect(listed.ok && (listed.data as Array<{ id: string }>).map((g) => g.id)).toEqual([BUILDER]);
  });

  it('clears each column with ""', async () => {
    expect(
      errorMessage(await update(BUILDER, { tier: 'worker', 'reports-to': ZED, role: 'x', persona: '{}' })),
    ).toBeUndefined();
    const resp = await update(BUILDER, { tier: '', 'reports-to': '', role: '', persona: '' });
    expect(errorMessage(resp)).toBeUndefined();
    expect(resp.ok && resp.data).toMatchObject({ tier: null, reports_to: null, role: null, persona: null });
  });

  it('rejects an unknown tier', async () => {
    expect(errorMessage(await update(BUILDER, { tier: 'boss' }))).toMatch(/tier must be one of: orchestrator/);
  });

  it('rejects reports_to that does not exist, points at itself, or forms a cycle', async () => {
    expect(errorMessage(await update(BUILDER, { 'reports-to': 'ag-nope' }))).toMatch(/agent group not found: ag-nope/);
    expect(errorMessage(await update(BUILDER, { 'reports-to': BUILDER }))).toMatch(/cannot point at the group itself/);

    expect(errorMessage(await update(BUILDER, { 'reports-to': ZED }))).toBeUndefined();
    expect(errorMessage(await update(ZED, { 'reports-to': BUILDER }))).toMatch(/would form a cycle/);
  });

  it('rejects a multi-line role and malformed persona payloads', async () => {
    expect(errorMessage(await update(BUILDER, { role: 'line one\nline two' }))).toMatch(/single line/);
    expect(errorMessage(await update(BUILDER, { persona: 'not json' }))).toMatch(/JSON object/);
    expect(errorMessage(await update(BUILDER, { persona: '["x"]' }))).toMatch(/JSON object/);
    expect(errorMessage(await update(BUILDER, { persona: '{"avatar":"x"}' }))).toMatch(/unknown key "avatar"/);
    expect(errorMessage(await update(BUILDER, { persona: '{"emoji":7}' }))).toMatch(/persona\.emoji must be a string/);
  });

  it('a group-scoped container agent cannot change tier or reports_to', async () => {
    await ensureContainerConfig(BUILDER);
    const resp = await dispatch(
      { id: 'a', command: 'groups-update', args: { tier: 'orchestrator' } },
      { caller: 'agent', sessionId: 'sess-b', agentGroupId: BUILDER, messagingGroupId: 'mg-b' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toMatch(/tier or reports_to/);
    }
  });
});

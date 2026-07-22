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
import { dispatch } from '../dispatch.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { validateMount } from '../../modules/mount-security/index.js';
// Side-effect import: registers the `groups-*` commands (including delete).
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('groups CLI delete cascades dependent rows (#2525)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('deletes a group with sessions, destinations, approvals, members, roles, and wirings', async () => {
    const GID = 'ag-victim';
    const SID = 'sess-victim-1';
    const MGID = 'mg-1';
    const UID = 'tg:42';

    createAgentGroup({ id: GID, name: 'victim', folder: 'victim', agent_provider: null, created_at: now() });
    createSession({
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
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`).run(
      UID,
      now(),
    );
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());

    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'chan', 'channel', ?, ?)`,
    ).run(GID, MGID, now());

    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
    ).run('q-1', SID, now());

    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
    ).run('pa-1', SID, now(), GID);

    db.prepare(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-1', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
    ).run(MGID, GID, now());

    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    ).run(UID, GID, now());

    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    ).run(UID, GID, now());

    // Container config row exercises the ON DELETE CASCADE on container_configs.
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
    ).run(GID, now());

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
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_questions WHERE session_id = ?', SID)).toBe(0);
    expect(
      count('SELECT COUNT(*) AS c FROM pending_approvals WHERE agent_group_id = ? OR session_id = ?', GID, SID),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_group_members WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);

    // Unrelated tables untouched.
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('removes polymorphic agent_destinations that point at the deleted group', async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });

    const db = getDb();

    // B has a destination pointing at A. target_id is polymorphic — no FK
    // constraint enforces it, so without explicit cleanup the row would
    // dangle after A is deleted.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'sibling', 'agent', ?, ?)`,
    ).run(B, A, now());

    const resp = await dispatch({ id: 'req-del-a', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_destinations_pointing).toBe(1);

    // A is gone, B remains, and B's stale destination is cleaned up.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', A)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', B)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', B)).toBe(0);
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

describe('groups config add-mount / remove-mount (host-only)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('adds a mount idempotently and removes it (host caller)', async () => {
    const GID = 'ag-mount';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    // containerPath is relative: the validator rejects absolute paths and
    // mounts every entry under /workspace/extra/, so an absolute fixture here
    // would model a mount that can never take effect.
    const args = { id: GID, host: '/data/.gmail-mcp', container: '.gmail-mcp', ro: true };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([
      { hostPath: '/data/.gmail-mcp', containerPath: '.gmail-mcp', readonly: true },
    ]);

    // idempotent: a second add does not duplicate
    await dispatch({ id: 'r2', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toHaveLength(1);

    const rm = await dispatch(
      {
        id: 'r3',
        command: 'groups-config-remove-mount',
        args: { id: GID, host: '/data/.gmail-mcp', container: '.gmail-mcp' },
      },
      { caller: 'host' },
    );
    expect(rm.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([]);
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
  function stored(dir: string): { hostPath: string; containerPath: string; readonly?: boolean } {
    const mounts = JSON.parse(getContainerConfig(GID)!.additional_mounts) as Array<{
      hostPath: string;
      containerPath: string;
      readonly?: boolean;
    }>;
    const found = mounts.find((m) => m.containerPath === dir);
    if (!found) throw new Error(`no mount stored for ${dir}`);
    return found;
  }

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    hostRoot = path.join(TEST_DIR, 'hostroot');
    fs.mkdirSync(hostRoot, { recursive: true });

    runMigrations(initTestDb());
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('writes readonly: false for --rw and read-write survives to the validator', async () => {
    writeAllowlist(true);
    expect((await addMount('rw', { rw: true })).ok).toBe(true);

    expect(stored('rw').readonly).toBe(false);
    const result = validateMount(stored('rw'));
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('writes readonly: true for --ro', async () => {
    writeAllowlist(true);
    expect((await addMount('ro', { ro: true })).ok).toBe(true);

    expect(stored('ro').readonly).toBe(true);
    expect(validateMount(stored('ro')).effectiveReadonly).toBe(true);
  });

  it('omits the key with no flag, which the validator forces to read-only', async () => {
    // Same allowlist as the --rw case: only the CLI intent differs.
    writeAllowlist(true);
    expect((await addMount('plain', {})).ok).toBe(true);

    expect(stored('plain')).not.toHaveProperty('readonly');
    expect(validateMount(stored('plain')).effectiveReadonly).toBe(true);
  });

  it('downgrades --rw to read-only when the allowlist root refuses read-write', async () => {
    writeAllowlist(false);
    expect((await addMount('denied', { rw: true })).ok).toBe(true);

    // The CLI records the intent; the allowlist is what actually decides.
    expect(stored('denied').readonly).toBe(false);
    const result = validateMount(stored('denied'));
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
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([]);
  });

  it('reads --rw false as false rather than as a truthy string', async () => {
    writeAllowlist(true);
    expect((await addMount('explicit-false', { rw: 'false' })).ok).toBe(true);

    expect(stored('explicit-false')).not.toHaveProperty('readonly');
  });
});

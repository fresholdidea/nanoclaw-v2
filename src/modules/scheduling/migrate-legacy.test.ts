/**
 * Tests for the legacy task-series migration: live (pending/paused) kind='task'
 * rows that predate per-series task sessions live inside ordinary chat/system
 * sessions, where group-scoped `ncl tasks` cannot see them but the recurrence
 * sweep keeps re-arming them. The migration moves each live series into its
 * own `system:tasks:<series>` session and neutralizes the source row.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-migrate-legacy',
    GROUPS_DIR: '/tmp/nanoclaw-test-migrate-legacy/groups',
    TIMEZONE: 'UTC',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-migrate-legacy';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession, findSystemSession, taskThreadId } from '../../db/sessions.js';
import { inboundDbPath, initSessionFolder, outboundDbPath, resolveTaskSession } from '../../session-manager.js';
import { insertTaskRow } from './db.js';
import { migrateLegacyTaskSeries } from './migrate-legacy.js';

function now(): string {
  return new Date().toISOString();
}

function createGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function createChatSession(group: string, id: string): void {
  createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, id);
}

function seedLegacyTask(
  group: string,
  session: string,
  series: string,
  opts: { status?: 'pending' | 'paused'; recurrence?: string | null; id?: string } = {},
): void {
  const db = new Database(inboundDbPath(group, session));
  insertTaskRow(db, {
    id: opts.id ?? series,
    seriesId: series,
    processAfter: '2026-08-01T12:00:00.000Z',
    recurrence: opts.recurrence !== undefined ? opts.recurrence : '0 9 * * *',
    content: JSON.stringify({ prompt: `prompt for ${series}`, script: null, originSessionId: null }),
    status: opts.status ?? 'pending',
  });
  db.close();
}

/** Simulate a container having fired a message during host downtime: the ack
 *  is in outbound.db but the host never synced it back to messages_in. */
function seedUnsyncedAck(group: string, session: string, messageId: string): void {
  const db = new Database(outboundDbPath(group, session));
  db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
    messageId,
    'completed',
    new Date().toISOString(),
  );
  db.close();
}

function liveRows(group: string, session: string): Array<Record<string, unknown>> {
  const db = new Database(inboundDbPath(group, session), { readonly: true });
  const rows = db
    .prepare("SELECT * FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
    .all() as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

describe('migrateLegacyTaskSeries', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createGroup('ag-1');
    createChatSession('ag-1', 'chat-1');
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('moves a live series from a chat session into its own task session', async () => {
    seedLegacyTask('ag-1', 'chat-1', 'legacy-report');

    const result = await migrateLegacyTaskSeries();
    expect(result.migrated).toBe(1);

    // Target session exists with the per-series thread id.
    const target = findSystemSession('ag-1', taskThreadId('legacy-report'));
    expect(target).toBeDefined();
    if (!target) return;

    // The live row moved intact: same series, content, schedule, next run.
    const moved = liveRows('ag-1', target.id);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      series_id: 'legacy-report',
      status: 'pending',
      recurrence: '0 9 * * *',
      process_after: '2026-08-01T12:00:00.000Z',
    });
    expect(JSON.parse(moved[0].content as string).prompt).toBe('prompt for legacy-report');

    // Source row neutralized: no longer live, recurrence cleared so the
    // sweep can never re-arm it in the chat session again.
    expect(liveRows('ag-1', 'chat-1')).toHaveLength(0);
    const srcDb = new Database(inboundDbPath('ag-1', 'chat-1'), { readonly: true });
    const src = srcDb.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'legacy-report'").get() as {
      status: string;
      recurrence: string | null;
    };
    srcDb.close();
    expect(src.status).toBe('cancelled');
    expect(src.recurrence).toBeNull();
  });

  it('preserves paused status through the move', async () => {
    seedLegacyTask('ag-1', 'chat-1', 'paused-series', { status: 'paused' });

    await migrateLegacyTaskSeries();

    const target = findSystemSession('ag-1', taskThreadId('paused-series'));
    expect(target).toBeDefined();
    if (!target) return;
    const moved = liveRows('ag-1', target.id);
    expect(moved).toHaveLength(1);
    expect(moved[0].status).toBe('paused');
  });

  it('is idempotent — a second run migrates nothing', async () => {
    seedLegacyTask('ag-1', 'chat-1', 'legacy-report');

    expect((await migrateLegacyTaskSeries()).migrated).toBe(1);
    expect((await migrateLegacyTaskSeries()).migrated).toBe(0);

    // Still exactly one live row for the series overall.
    const target = findSystemSession('ag-1', taskThreadId('legacy-report'));
    if (!target) throw new Error('target session missing');
    expect(liveRows('ag-1', target.id)).toHaveLength(1);
  });

  it('leaves properly-registered series in task sessions untouched', async () => {
    // A series already living in its own task session must not be re-moved.
    const { session } = resolveTaskSession('ag-1', 'registered-series');
    seedLegacyTask('ag-1', session.id, 'registered-series');

    const result = await migrateLegacyTaskSeries();
    expect(result.migrated).toBe(0);
    expect(liveRows('ag-1', session.id)).toHaveLength(1);
  });

  it('skips a series whose task session already has a DIFFERENT live occurrence, leaving the source alone', async () => {
    const { session } = resolveTaskSession('ag-1', 'clash');
    seedLegacyTask('ag-1', session.id, 'clash', { id: 'clash-rearmed-occurrence' });
    seedLegacyTask('ag-1', 'chat-1', 'clash');

    const result = await migrateLegacyTaskSeries();
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);

    // Source stays live for the operator to resolve manually — no data loss.
    expect(liveRows('ag-1', 'chat-1')).toHaveLength(1);
    expect(liveRows('ag-1', session.id)).toHaveLength(1);
  });

  it('heals an interrupted move: same occurrence id already in the target → source is neutralized', async () => {
    // Simulates a crash after target-insert but before source-neutralize:
    // the exact same row id exists live in the task session.
    seedLegacyTask('ag-1', 'chat-1', 'crashed-move');
    const { session } = resolveTaskSession('ag-1', 'crashed-move');
    seedLegacyTask('ag-1', session.id, 'crashed-move');

    const result = await migrateLegacyTaskSeries();
    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);

    expect(liveRows('ag-1', 'chat-1')).toHaveLength(0);
    expect(liveRows('ag-1', session.id)).toHaveLength(1);
  });

  it('does not re-fire a recurring occurrence that already fired during host downtime', async () => {
    // The container fired the due occurrence and acked it in outbound.db, but
    // the host crashed before syncing — the messages_in row still says
    // 'pending'. The migration must reconcile the ack first: the fired
    // occurrence becomes history, and only a FRESH occurrence (next cron
    // time) moves to the task session.
    seedLegacyTask('ag-1', 'chat-1', 'fired-series', { recurrence: '0 9 * * *' });
    seedUnsyncedAck('ag-1', 'chat-1', 'fired-series');

    await migrateLegacyTaskSeries();

    // Source: fired occurrence is history now, not live.
    const srcDb = new Database(inboundDbPath('ag-1', 'chat-1'), { readonly: true });
    const fired = srcDb.prepare("SELECT status FROM messages_in WHERE id = 'fired-series'").get() as {
      status: string;
    };
    srcDb.close();
    expect(fired.status).toBe('completed');
    expect(liveRows('ag-1', 'chat-1')).toHaveLength(0);

    // Target: exactly one live occurrence, and it is a NEW one due at the
    // next cron time — not the already-fired row re-homed with its past
    // process_after.
    const target = findSystemSession('ag-1', taskThreadId('fired-series'));
    expect(target).toBeDefined();
    if (!target) return;
    const moved = liveRows('ag-1', target.id);
    expect(moved).toHaveLength(1);
    expect(moved[0].id).not.toBe('fired-series');
    expect(moved[0].series_id).toBe('fired-series');
    expect(String(moved[0].process_after) > new Date().toISOString()).toBe(true);
  });

  it('does not move a one-shot that already fired during host downtime', async () => {
    seedLegacyTask('ag-1', 'chat-1', 'fired-oneshot', { recurrence: null });
    seedUnsyncedAck('ag-1', 'chat-1', 'fired-oneshot');

    const result = await migrateLegacyTaskSeries();
    expect(result.migrated).toBe(0);

    const srcDb = new Database(inboundDbPath('ag-1', 'chat-1'), { readonly: true });
    const fired = srcDb.prepare("SELECT status FROM messages_in WHERE id = 'fired-oneshot'").get() as {
      status: string;
    };
    srcDb.close();
    expect(fired.status).toBe('completed');
    // Nothing live to move → no task session should have been created.
    expect(findSystemSession('ag-1', taskThreadId('fired-oneshot'))).toBeUndefined();
  });

  it('leaves completed history rows in the source session', async () => {
    seedLegacyTask('ag-1', 'chat-1', 'legacy-report');
    const db = new Database(inboundDbPath('ag-1', 'chat-1'));
    insertTaskRow(db, {
      id: 'legacy-report-old-run',
      seriesId: 'legacy-report',
      processAfter: '2026-07-01T12:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'prompt for legacy-report' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'legacy-report-old-run'").run();
    db.close();

    await migrateLegacyTaskSeries();

    const srcDb = new Database(inboundDbPath('ag-1', 'chat-1'), { readonly: true });
    const history = srcDb.prepare("SELECT status FROM messages_in WHERE id = 'legacy-report-old-run'").get() as {
      status: string;
    };
    srcDb.close();
    expect(history.status).toBe('completed');
  });
});

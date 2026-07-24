/**
 * Startup migration for legacy task series.
 *
 * Task series created before per-series task sessions existed live inside
 * ordinary chat/system session inbound DBs. There they are invisible to the
 * group-scoped `ncl tasks` commands (which only scan `system:tasks:*`
 * sessions via findTaskSessions), yet the host-sweep recurrence hook keeps
 * re-arming them forever — an unmanageable ghost series. This moves each
 * live (pending/paused) series into its own task session and neutralizes the
 * source row, after which every series is visible and manageable again.
 *
 * Before scanning, each source session is brought up to date exactly as the
 * sweep would: processing_acks are reconciled (an occurrence the container
 * fired during host downtime is history, not a live row — re-homing it would
 * fire it twice), then completed recurring rows are re-armed so the scan
 * moves a FRESH occurrence at its next cron time.
 *
 * Idempotent: a second run finds no live task rows outside task sessions.
 * The move is insert-into-target THEN cancel-source (two DB files — no cross
 * file transaction); a crash between the two leaves the same occurrence id
 * live in both, which the next run detects and heals by neutralizing the
 * source. A DIFFERENT live occurrence of the same series in the target is a
 * genuine conflict — skipped with a warning for the operator to resolve.
 *
 * Runs after cleanupOrphans() (no leftover container can race a due row
 * mid-move) and before delivery polls, host sweep, and CLI server start.
 *
 * Completed/failed/cancelled history rows stay in the source session; run
 * logs (`groups/<folder>/tasks/<series>.md`) are keyed by series id and
 * carry over unchanged.
 */
import fs from 'fs';

import { syncProcessingAcks } from '../../db/session-db.js';
import { getActiveSessions, isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import {
  inboundDbPath,
  openInboundDb,
  openOutboundDb,
  outboundDbPath,
  resolveTaskSession,
  withInboundDb,
} from '../../session-manager.js';
import { insertTaskRow } from './db.js';
import { handleRecurrence } from './recurrence.js';

interface LiveTaskRow {
  id: string;
  series_id: string | null;
  status: 'pending' | 'paused';
  process_after: string | null;
  recurrence: string | null;
  content: string;
}

type InboundDb = ReturnType<typeof openInboundDb>;

/** Reconcile fired-but-unsynced occurrences, then re-arm completed recurring
 *  rows — the same two steps the sweep runs, so the scan below sees exactly
 *  the rows that are genuinely still live. */
async function reconcileSource(inDb: InboundDb, session: Session): Promise<void> {
  if (fs.existsSync(outboundDbPath(session.agent_group_id, session.id))) {
    try {
      const outDb = openOutboundDb(session.agent_group_id, session.id);
      try {
        syncProcessingAcks(inDb, outDb);
      } finally {
        outDb.close();
      }
    } catch (err) {
      log.warn('Legacy task migration: ack reconcile failed, continuing with inbound status as-is', {
        sessionId: session.id,
        err,
      });
    }
  }
  try {
    await handleRecurrence(inDb, session);
  } catch (err) {
    log.warn('Legacy task migration: recurrence re-arm failed, continuing', { sessionId: session.id, err });
  }
}

function neutralizeSource(inDb: InboundDb, rowId: string): void {
  inDb.prepare("UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE id = ?").run(rowId);
}

export async function migrateLegacyTaskSeries(): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;

  for (const session of getActiveSessions()) {
    if (isTaskThread(session.thread_id)) continue;
    if (!fs.existsSync(inboundDbPath(session.agent_group_id, session.id))) continue;

    let inDb: InboundDb;
    try {
      inDb = openInboundDb(session.agent_group_id, session.id);
    } catch (err) {
      log.warn('Legacy task migration: could not open session inbound DB, skipping it', {
        sessionId: session.id,
        err,
      });
      continue;
    }

    try {
      await reconcileSource(inDb, session);

      const rows = inDb
        .prepare(
          `SELECT id, series_id, status, process_after, recurrence, content
             FROM messages_in
            WHERE kind = 'task' AND status IN ('pending', 'paused')`,
        )
        .all() as LiveTaskRow[];

      for (const row of rows) {
        const seriesKey = row.series_id ?? row.id;
        try {
          const { session: target } = resolveTaskSession(session.agent_group_id, seriesKey);
          const outcome = withInboundDb(session.agent_group_id, target.id, (db) => {
            const clash = db
              .prepare(
                `SELECT id FROM messages_in
                  WHERE (series_id = ? OR id = ?) AND kind = 'task' AND status IN ('pending', 'paused')`,
              )
              .get(seriesKey, seriesKey) as { id: string } | undefined;
            // Same occurrence id already live in the target = an interrupted
            // earlier move; just finish it by neutralizing the source below.
            if (clash) return clash.id === row.id ? 'already-moved' : 'conflict';
            insertTaskRow(db, {
              id: row.id,
              seriesId: seriesKey,
              processAfter: row.process_after,
              recurrence: row.recurrence,
              content: row.content,
              status: row.status,
            });
            return 'inserted';
          });

          if (outcome === 'conflict') {
            skipped++;
            log.warn('Legacy task migration: series already live in its task session, left in place', {
              seriesId: seriesKey,
              sourceSessionId: session.id,
              targetSessionId: target.id,
            });
            continue;
          }

          // The target insert is committed; a neutralize failure here must
          // not read as a failed move (retry once, then leave it to the
          // startup heal — the duplicate lives at most until next restart).
          try {
            neutralizeSource(inDb, row.id);
          } catch {
            try {
              neutralizeSource(inDb, row.id);
            } catch (err) {
              log.warn(
                'Legacy task migration: moved to task session but source row not neutralized — heals at next startup',
                { seriesId: seriesKey, sourceSessionId: session.id, targetSessionId: target.id, err },
              );
            }
          }
          migrated++;
          log.info('Legacy task series moved to its own task session', {
            seriesId: seriesKey,
            agentGroupId: session.agent_group_id,
            sourceSessionId: session.id,
            targetSessionId: target.id,
            status: row.status,
          });
        } catch (err) {
          skipped++;
          log.warn('Legacy task migration: series move failed, left in place', {
            seriesId: seriesKey,
            sourceSessionId: session.id,
            err,
          });
        }
      }
    } finally {
      inDb.close();
    }
  }

  if (migrated > 0 || skipped > 0) {
    log.info('Legacy task migration finished', { migrated, skipped });
  }
  return { migrated, skipped };
}

/**
 * The HUD's own small store: an append-only audit of every action taken from
 * the dashboard, and snoozes. Its own file (data/hud.db), outside the central
 * DB and its migrations: nothing else reads it, and losing it loses no state
 * the rest of the host depends on.
 *
 * Every timestamp is passed in as ISO-8601 UTC; no SQL-side clock.
 */
import Database from 'better-sqlite3';

export interface AuditRow {
  t: string;
  action: string;
  args: string;
  actor: string;
  ok: boolean;
  message: string;
}
export interface HudStore {
  audit(row: AuditRow): void;
  recentAudit(limit?: number): AuditRow[];
  snooze(item: string, until: string): void;
  /** Snoozes still in force at `now`; expired ones are dropped. */
  snoozed(now: string): Map<string, string>;
  close(): void;
}

export function openHudStore(file: string): HudStore {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t TEXT NOT NULL,
      action TEXT NOT NULL,
      args TEXT NOT NULL,
      actor TEXT NOT NULL,
      ok INTEGER NOT NULL,
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snooze (
      item TEXT PRIMARY KEY,
      until TEXT NOT NULL
    );
  `);
  const insertAudit = db.prepare('INSERT INTO audit (t, action, args, actor, ok, message) VALUES (?, ?, ?, ?, ?, ?)');
  const selectAudit = db.prepare('SELECT t, action, args, actor, ok, message FROM audit ORDER BY id DESC LIMIT ?');
  const upsertSnooze = db.prepare(
    'INSERT INTO snooze (item, until) VALUES (?, ?) ON CONFLICT(item) DO UPDATE SET until = excluded.until',
  );
  const dropExpired = db.prepare('DELETE FROM snooze WHERE until <= ?');
  const selectSnooze = db.prepare('SELECT item, until FROM snooze');
  return {
    audit(row) {
      insertAudit.run(row.t, row.action, row.args, row.actor, row.ok ? 1 : 0, row.message);
    },
    recentAudit(limit = 50) {
      return (selectAudit.all(limit) as Array<Omit<AuditRow, 'ok'> & { ok: number }>).map((r) => ({
        ...r,
        ok: r.ok === 1,
      }));
    },
    snooze(item, until) {
      upsertSnooze.run(item, until);
    },
    snoozed(now) {
      // ISO-8601 UTC strings of one shape compare correctly as text.
      dropExpired.run(now);
      return new Map((selectSnooze.all() as Array<{ item: string; until: string }>).map((r) => [r.item, r.until]));
    },
    close() {
      db.close();
    },
  };
}

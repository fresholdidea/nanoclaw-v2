/**
 * The HUD's own small store: an append-only audit of every action taken from
 * the dashboard, snoozes, and the timeline (events, and the last-seen facts
 * they are derived from). Its own file (data/hud.db), outside the central
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
/** One line of the timeline. `item` is the id a page anchors on, or empty. */
export interface EventRow {
  t: string;
  client: string | null;
  kind: string;
  item: string;
  text: string;
}
export interface HudStore {
  audit(row: AuditRow): void;
  recentAudit(limit?: number): AuditRow[];
  snooze(item: string, until: string): void;
  /** Snoozes still in force at `now`; expired ones are dropped. */
  snoozed(now: string): Map<string, string>;
  /** Newest first. */
  events(limit?: number): EventRow[];
  /** What the last push showed, by fact key: the baseline the next push is compared with. */
  seen(): Map<string, string>;
  /** Write events and move the baseline in one transaction, so a change is recorded once or not at all. */
  record(events: EventRow[], upserts?: Array<[string, string]>, removals?: string[]): void;
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
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t TEXT NOT NULL,
      client TEXT,
      kind TEXT NOT NULL,
      item TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seen (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insertAudit = db.prepare('INSERT INTO audit (t, action, args, actor, ok, message) VALUES (?, ?, ?, ?, ?, ?)');
  const selectAudit = db.prepare('SELECT t, action, args, actor, ok, message FROM audit ORDER BY id DESC LIMIT ?');
  const upsertSnooze = db.prepare(
    'INSERT INTO snooze (item, until) VALUES (?, ?) ON CONFLICT(item) DO UPDATE SET until = excluded.until',
  );
  const dropExpired = db.prepare('DELETE FROM snooze WHERE until <= ?');
  const selectSnooze = db.prepare('SELECT item, until FROM snooze');
  const insertEvent = db.prepare('INSERT INTO events (t, client, kind, item, text) VALUES (?, ?, ?, ?, ?)');
  const selectEvents = db.prepare('SELECT t, client, kind, item, text FROM events ORDER BY id DESC LIMIT ?');
  // The timeline shows the recent past; the audit table is the permanent record.
  const pruneEvents = db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?');
  const selectSeen = db.prepare('SELECT key, value FROM seen');
  const upsertSeen = db.prepare(
    'INSERT INTO seen (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const deleteSeen = db.prepare('DELETE FROM seen WHERE key = ?');
  const record = db.transaction((events: EventRow[], upserts: Array<[string, string]>, removals: string[]) => {
    for (const e of events) insertEvent.run(e.t, e.client, e.kind, e.item, e.text.slice(0, 500));
    for (const [key, value] of upserts) upsertSeen.run(key, value);
    for (const key of removals) deleteSeen.run(key);
    if (events.length) pruneEvents.run(5000);
  });
  return {
    events(limit = 200) {
      return selectEvents.all(limit) as EventRow[];
    },
    seen() {
      return new Map((selectSeen.all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
    },
    record(events, upserts = [], removals = []) {
      record(events, upserts, removals);
    },
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

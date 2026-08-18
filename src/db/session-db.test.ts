/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  ensureSchema,
  getInboundSourceSessionId,
  migrateMessagesInTable,
  openOutboundDb,
  syncProcessingAcks,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('syncProcessingAcks — script-skip counter', () => {
  function freshPair() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');
    const outPath = path.join(TEST_DIR, 'outbound.db');
    ensureSchema(outPath, 'outbound');
    return { inDb: new Database(DB_PATH), outDb: new Database(outPath) };
  }

  function seedTask(inDb: InstanceType<typeof Database>, id: string, content: Record<string, unknown>) {
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content, series_id)
         VALUES (?, 2, datetime('now'), 'processing', 0, 'task', ?, ?)`,
      )
      .run(id, JSON.stringify(content), id);
  }

  function ack(outDb: InstanceType<typeof Database>, id: string, status: string) {
    outDb
      .prepare(
        "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now'))",
      )
      .run(id, status);
  }

  const status = (inDb: InstanceType<typeof Database>, id: string) =>
    (inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;

  it('script-skip:error ack lands the row as a FAILED run (streak-derivable history)', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'script-skip:error');

    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('failed');
  });

  it('a settled row is terminal — a lingering ack cannot flip failed back to completed', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'script-skip:error');
    syncProcessingAcks(inDb, outDb);

    ack(outDb, 't1', 'completed');
    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('failed');
  });

  it('plain completed ack completes the row as before', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'completed');

    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('completed');
  });
});

describe('openOutboundDb read-only enforcement', () => {
  it('recovers a hot DELETE journal before enforcing query-only access', async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const outDbPath = path.join(TEST_DIR, 'outbound.db');
    ensureSchema(outDbPath, 'outbound');

    const seedDb = new Database(outDbPath);
    const seed = seedDb.prepare('INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, ?, ?)');
    seedDb.transaction(() => {
      for (let i = 0; i < 64; i++) {
        seed.run(
          `baseline-${i}`,
          i * 2 + 1,
          new Date().toISOString(),
          'chat',
          JSON.stringify({ text: `committed-${i}`, padding: 'x'.repeat(8192) }),
        );
      }
    })();
    seedDb.close();

    const childScript = String.raw`
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1]);
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
      db.pragma('cache_size = 4');
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE messages_out SET content = ?')
        .run(JSON.stringify({ text: 'uncommitted', padding: 'y'.repeat(8192) }));
      process.stdout.write('ready\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', childScript, outDbPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child did not create hot journal: ${stderr}`)), 5000);
        child.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.stdout.once('data', (chunk) => {
          clearTimeout(timer);
          if (!String(chunk).includes('ready')) {
            reject(new Error(`unexpected child output: ${String(chunk)} ${stderr}`));
            return;
          }
          resolve();
        });
      });

      expect(fs.existsSync(`${outDbPath}-journal`)).toBe(true);
      const exitPromise = once(child, 'exit');
      child.kill('SIGKILL');
      await exitPromise;

      const hostOutDb = openOutboundDb(outDbPath);
      try {
        const row = hostOutDb.prepare("SELECT content FROM messages_out WHERE id = 'baseline-0'").get() as {
          content: string;
        };
        expect(JSON.parse(row.content)).toEqual({ text: 'committed-0', padding: 'x'.repeat(8192) });

        for (const sql of [
          "INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('new', 3, 'now', 'chat', '{}')",
          "UPDATE messages_out SET content = '{}' WHERE id = 'baseline-0'",
          "DELETE FROM messages_out WHERE id = 'baseline-0'",
        ]) {
          expect(() => hostOutDb.prepare(sql).run()).toThrow(/attempt to write a readonly database/);
        }
      } finally {
        hostOutDb.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exitPromise = once(child, 'exit');
        child.kill('SIGKILL');
        await exitPromise;
      }
    }
  }, 10_000);

  it('allows SELECT queries but rejects mutations with attempt to write a readonly database', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const outDbPath = path.join(TEST_DIR, 'outbound.db');
    ensureSchema(outDbPath, 'outbound');

    const hostOutDb = openOutboundDb(outDbPath);

    // SELECT succeeds
    const rows = hostOutDb.prepare('SELECT * FROM messages_out').all();
    expect(rows).toEqual([]);

    // INSERT fails under PRAGMA query_only = ON
    expect(() => {
      hostOutDb
        .prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('m1', 1, 'now', 'chat', '{}')")
        .run();
    }).toThrow(/attempt to write a readonly database/);

    hostOutDb.close();
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { drainQueue, refreshSnapshot } from './mnemon-sync.js';

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-sync-test-'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('refreshSnapshot', () => {
  it('produces a DELETE-journal copy of a WAL-mode live store', () => {
    const liveDir = path.join(base, 'data', 'default');
    fs.mkdirSync(liveDir, { recursive: true });
    const live = new Database(path.join(liveDir, 'mnemon.db'));
    live.pragma('journal_mode = WAL');
    live.exec('CREATE TABLE insights (id INTEGER PRIMARY KEY, content TEXT)');
    live.exec("INSERT INTO insights (content) VALUES ('hello')");
    live.close();

    refreshSnapshot(base);

    const snapPath = path.join(base, 'snapshot', 'data', 'default', 'mnemon.db');
    const snap = new Database(snapPath, { readonly: true });
    expect(snap.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(snap.prepare('SELECT COUNT(*) AS c FROM insights').get()).toEqual({ c: 1 });
    snap.close();
  });

  it('is a no-op when the live store is missing', () => {
    refreshSnapshot(base);
    expect(fs.existsSync(path.join(base, 'snapshot'))).toBe(false);
  });
});

describe('drainQueue', () => {
  const trueBin = '/usr/bin/true';

  function queueFile(name: string, contents: string): string {
    const dir = path.join(base, 'queue');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, contents);
    return p;
  }

  it('replays allowlisted verbs and removes the file', async () => {
    const p = queueFile('1-1-1.json', JSON.stringify({ ts: 't', argv: ['remember', 'fact', '--imp', '3'] }));
    const replayed = await drainQueue(base, trueBin);
    expect(replayed).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('parks non-allowlisted verbs as .err without replaying', async () => {
    const p = queueFile('2-2-2.json', JSON.stringify({ ts: 't', argv: ['store', 'remove', 'default'] }));
    const replayed = await drainQueue(base, trueBin);
    expect(replayed).toBe(0);
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(`${p}.err`)).toBe(true);
  });

  it('parks unparseable files as .err and ignores dotfile temps', async () => {
    const bad = queueFile('3-3-3.json', 'not json');
    queueFile('.4-4-4.json.tmp', 'partial');
    const replayed = await drainQueue(base, trueBin);
    expect(replayed).toBe(0);
    expect(fs.existsSync(`${bad}.err`)).toBe(true);
    expect(fs.existsSync(path.join(base, 'queue', '.4-4-4.json.tmp'))).toBe(true);
  });
});

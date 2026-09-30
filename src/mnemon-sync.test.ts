import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { drainQueue, refreshSnapshot } from './mnemon-sync.js';

let base: string;
let outside: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-sync-test-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-sync-outside-'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function makeDb(file: string, tables: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  for (const t of tables) db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, content TEXT)`);
  db.exec(`INSERT INTO ${tables[0]} (content) VALUES ('hello')`);
  db.close();
}

const livePath = () => path.join(base, 'data', 'default', 'mnemon.db');
const snapPath = () => path.join(base, 'snapshot', 'data', 'default', 'mnemon.db');

describe('refreshSnapshot', () => {
  it('produces a DELETE-journal copy of a WAL-mode live store', () => {
    makeDb(livePath(), ['insights', 'edges']);

    refreshSnapshot(base);

    const snap = new Database(snapPath(), { readonly: true });
    expect(snap.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(snap.prepare('SELECT COUNT(*) AS c FROM insights').get()).toEqual({ c: 1 });
    snap.close();
    expect(fs.readdirSync(path.dirname(snapPath()))).toEqual(['mnemon.db']);
  });

  it('is a no-op when the live store is missing', () => {
    refreshSnapshot(base);
    expect(fs.existsSync(path.join(base, 'snapshot'))).toBe(false);
  });

  it('refuses a live store that is a symlink to another database', () => {
    const secret = path.join(outside, 'v2.db');
    makeDb(secret, ['insights', 'edges']);
    fs.mkdirSync(path.dirname(livePath()), { recursive: true });
    fs.symlinkSync(secret, livePath());

    refreshSnapshot(base);

    expect(fs.existsSync(snapPath())).toBe(false);
  });

  it('refuses a live store reached through a symlinked data directory', () => {
    makeDb(path.join(outside, 'mnemon.db'), ['insights', 'edges']);
    fs.mkdirSync(path.join(base, 'data'), { recursive: true });
    fs.symlinkSync(outside, path.join(base, 'data', 'default'));

    refreshSnapshot(base);

    expect(fs.existsSync(snapPath())).toBe(false);
  });

  it('refuses a live store that is not a regular file', () => {
    fs.mkdirSync(livePath(), { recursive: true });

    refreshSnapshot(base);

    expect(fs.existsSync(snapPath())).toBe(false);
  });

  it('refuses to publish a copy that lacks the mnemon tables', () => {
    makeDb(livePath(), ['container_configs']);

    refreshSnapshot(base);

    expect(fs.existsSync(snapPath())).toBe(false);
    expect(fs.readdirSync(path.dirname(snapPath()))).toEqual([]);
  });

  it('refuses to write through a symlinked snapshot directory', () => {
    makeDb(livePath(), ['insights', 'edges']);
    fs.mkdirSync(path.join(base, 'snapshot', 'data'), { recursive: true });
    fs.symlinkSync(outside, path.join(base, 'snapshot', 'data', 'default'));

    refreshSnapshot(base);

    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('drainQueue', () => {
  const ID1 = '3671aee0-1111-4222-8333-444455556666';
  const ID2 = '9a0b1c2d-7777-4888-9999-aaaabbbbcccc';
  let bin: string;
  let record: string;

  beforeEach(() => {
    // Fake mnemon: appends each call's argv (unit-separated) as one line.
    record = path.join(outside, 'calls.txt');
    bin = path.join(outside, 'fake-mnemon');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\037' "$@" >> '${record}'\necho >> '${record}'\n`, { mode: 0o755 });
  });

  function calls(): string[][] {
    if (!fs.existsSync(record)) return [];
    return fs
      .readFileSync(record, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\x1f').slice(0, -1));
  }

  function queueDir(): string {
    const dir = path.join(base, 'queue');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function queueFile(name: string, contents: string): string {
    const p = path.join(queueDir(), name);
    fs.writeFileSync(p, contents);
    return p;
  }

  const queued = (argv: unknown) => JSON.stringify({ ts: 't', argv });

  it('replays allowlisted verbs and removes the file', async () => {
    const p = queueFile('1-1-1.json', queued(['remember', 'fact', '--imp', '3']));
    const replayed = await drainQueue(base, bin);
    expect(replayed).toBe(1);
    expect(fs.existsSync(p)).toBe(false);
    expect(calls()).toEqual([['remember', 'fact', '--imp', '3']]);
  });

  it('parks non-allowlisted verbs as .err without replaying', async () => {
    const p = queueFile('2-2-2.json', queued(['store', 'remove', 'default']));
    const replayed = await drainQueue(base, bin);
    expect(replayed).toBe(0);
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(`${p}.err`)).toBe(true);
    expect(calls()).toEqual([]);
  });

  it('parks unparseable files as .err and ignores dotfile temps', async () => {
    const bad = queueFile('3-3-3.json', 'not json');
    queueFile('.4-4-4.json.tmp', 'partial');
    const replayed = await drainQueue(base, bin);
    expect(replayed).toBe(0);
    expect(fs.existsSync(`${bad}.err`)).toBe(true);
    expect(fs.existsSync(path.join(base, 'queue', '.4-4-4.json.tmp'))).toBe(true);
  });

  describe('argv validation', () => {
    const accepted: string[][] = [
      [
        'remember',
        'a fact',
        '--cat',
        'decision',
        '--imp',
        '4',
        '--entities',
        'A,B',
        '--entity-mode',
        'merge',
        '--source',
        'agent',
        '--tags',
        't1',
        '--no-diff',
      ],
      ['link', ID1, ID2],
      ['link', ID1, ID2, '--type', 'causal', '--weight', '0.8', '--meta', '{"reason":"x"}'],
      ['link', ID1, ID2, '--weight', '0', '--type', 'semantic'],
      ['forget', ID1],
    ];

    it.each(accepted.map((argv) => [argv.slice(0, 2).join(' '), argv]))('replays %s', async (_label, argv) => {
      queueFile('5-5-5.json', queued(argv));
      expect(await drainQueue(base, bin)).toBe(1);
      expect(calls()).toEqual([argv]);
    });

    const rejected: Array<[string, unknown]> = [
      ['--data-dir on remember', ['remember', 'x', '--data-dir', '/tmp/evil']],
      ['--data-dir=value form', ['remember', 'x', '--data-dir=/tmp/evil']],
      ['--store on link', ['link', ID1, ID2, '--store', 'evil']],
      ['--store=value form', ['forget', ID1, '--store=evil']],
      ['--readonly', ['remember', 'x', '--readonly']],
      ['--embed-model', ['remember', 'x', '--embed-model', 'evil']],
      ['global flag before the verb', ['--data-dir', '/tmp/evil', 'remember', 'x']],
      ['remember flag outside the allowlist', ['remember', 'x', '--reason', 'y']],
      ['remember allowlisted flag in = form', ['remember', 'x', '--cat=fact']],
      ['remember bad category', ['remember', 'x', '--cat', 'secret']],
      ['remember value flag without a value', ['remember', 'x', '--imp']],
      ['remember -- terminator', ['remember', '--', '--data-dir']],
      ['remember with no content', ['remember', '--cat', 'fact']],
      ['forget with a flag', ['forget', ID1, '--reason', 'y']],
      ['forget with two ids', ['forget', ID1, ID2]],
      ['forget with no id', ['forget']],
      ['link with one id', ['link', ID1]],
      ['link with three ids', ['link', ID1, ID2, ID1]],
      ['link unknown flag', ['link', ID1, ID2, '--force']],
      ['link bad --type', ['link', ID1, ID2, '--type', 'bogus']],
      ['link --weight above 1', ['link', ID1, ID2, '--weight', '2']],
      ['link --weight not a number', ['link', ID1, ID2, '--weight', 'NaN']],
      ['link --weight empty', ['link', ID1, ID2, '--weight', '']],
      ['argv not an array', 'remember x'],
      ['argv with a non-string', ['remember', 1]],
      ['verb inherited from Object.prototype', ['constructor', 'x']],
    ];

    it.each(rejected)('parks %s as .err without replaying', async (_label, argv) => {
      const p = queueFile('6-6-6.json', queued(argv));
      expect(await drainQueue(base, bin)).toBe(0);
      expect(fs.existsSync(`${p}.err`)).toBe(true);
      expect(calls()).toEqual([]);
    });
  });

  describe('untrusted queue entries', () => {
    it('never follows a symlinked queue entry', async () => {
      const target = path.join(outside, 'planted.json');
      fs.writeFileSync(target, queued(['remember', 'from outside']));
      const link = path.join(queueDir(), '7-7-7.json');
      fs.symlinkSync(target, link);

      expect(await drainQueue(base, bin)).toBe(0);

      expect(calls()).toEqual([]);
      expect(fs.lstatSync(`${link}.err`).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(queued(['remember', 'from outside']));
    });

    it('does not block on a FIFO and still drains the rest of the queue', async () => {
      execFileSync('mkfifo', [path.join(queueDir(), '1-fifo.json')]);
      queueFile('2-ok.json', queued(['forget', ID1]));

      expect(await drainQueue(base, bin)).toBe(1);

      expect(calls()).toEqual([['forget', ID1]]);
      expect(fs.lstatSync(path.join(base, 'queue', '1-fifo.json.err')).isFIFO()).toBe(true);
    });

    it('parks a directory named like a queue file', async () => {
      fs.mkdirSync(path.join(queueDir(), '8-8-8.json'));
      expect(await drainQueue(base, bin)).toBe(0);
      expect(fs.statSync(path.join(base, 'queue', '8-8-8.json.err')).isDirectory()).toBe(true);
    });

    it('parks an oversized queue file without replaying it', async () => {
      const p = queueFile('9-9-9.json', queued(['remember', 'x'.repeat(300 * 1024)]));
      expect(await drainQueue(base, bin)).toBe(0);
      expect(fs.existsSync(`${p}.err`)).toBe(true);
      expect(calls()).toEqual([]);
    });

    it('keeps draining when a file cannot be parked', async () => {
      queueFile('1-stuck.json', 'not json');
      fs.mkdirSync(path.join(queueDir(), '1-stuck.json.err', 'occupied'), { recursive: true });
      queueFile('2-ok.json', queued(['forget', ID1]));

      expect(await drainQueue(base, bin)).toBe(1);
      expect(calls()).toEqual([['forget', ID1]]);
    });

    it('refuses to drain a queue directory that is a symlink', async () => {
      const target = path.join(outside, 'settings.json');
      fs.writeFileSync(target, '{"not":"a queue file"}');
      fs.symlinkSync(outside, path.join(base, 'queue'));

      expect(await drainQueue(base, bin)).toBe(0);

      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(`${target}.err`)).toBe(false);
    });
  });
});

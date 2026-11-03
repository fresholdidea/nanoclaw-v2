/**
 * mnemon host sync — bridges agent containers to the shared mnemon store.
 *
 * The live store (~/.mnemon/data/default/mnemon.db) is WAL-mode SQLite, which
 * cannot be opened across the macOS Docker file-sharing mount (WAL needs
 * mmap'd shared memory; opens fail with SQLITE_CANTOPEN). Containers therefore
 * never touch it — the in-container `mnemon` shim (container/mnemon-shim.sh):
 *   - serves reads from <base>/snapshot/, a DELETE-journal copy this module
 *     refreshes with VACUUM INTO;
 *   - queues writes (remember/link/forget argv) as JSON files in <base>/queue/,
 *     which this module replays through the host mnemon CLI.
 *
 * Everything under <base> is treated as container-controlled. Containers mount
 * <base> read-only with only queue/ writable, but a container can plant FIFOs
 * and symlinks in queue/, and could plant them anywhere if that mount ever
 * regressed. So queue files are opened without following links or blocking,
 * queued argv is allowlisted, and the snapshot never reads or writes through
 * a symlink.
 *
 * Runs on an interval from index.ts, same lifecycle as the dashboard pusher.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import Database from 'better-sqlite3';

import { log } from './log.js';

const execFileAsync = promisify(execFile);

const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/** Largest queue file read. The biggest stored memory is under 7 KB. */
const QUEUE_FILE_MAX_BYTES = 256 * 1024;

/** A snapshot copy must have these tables, so no other SQLite DB can be published. */
const SNAPSHOT_REQUIRED_TABLES = ['insights', 'edges'];

/** mnemon's global flags pick the store, data dir, or open mode. Never replayable. */
const GLOBAL_FLAGS = new Set(['--data-dir', '--store', '--readonly', '--embed-model']);

const CATEGORIES = new Set(['preference', 'decision', 'fact', 'insight', 'context', 'general']);
const EDGE_TYPES = new Set(['temporal', 'semantic', 'causal', 'entity']);
const UNIT_INTERVAL = /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/;

interface VerbSpec {
  minPositionals: number;
  maxPositionals: number;
  /** Flags that take the next argv entry as their value, with an optional value check. */
  valueFlags: Map<string, ((value: string) => boolean) | null>;
  booleanFlags: Set<string>;
}

/**
 * Verbs a container may queue for replay, and the flags each accepts. The
 * remember allowlist mirrors container/mnemon-queue.mjs; link's flags are the
 * ones container/skills/mnemon/SKILL.md documents. Anything else parks as .err.
 */
const QUEUE_VERBS = new Map<string, VerbSpec>([
  [
    'remember',
    {
      minPositionals: 1,
      maxPositionals: Infinity,
      valueFlags: new Map<string, ((value: string) => boolean) | null>([
        ['--cat', (v) => CATEGORIES.has(v)],
        ['--entities', null],
        ['--entity-mode', null],
        ['--imp', null],
        ['--source', null],
        ['--tags', null],
      ]),
      booleanFlags: new Set(['--no-diff']),
    },
  ],
  [
    'link',
    {
      minPositionals: 2,
      maxPositionals: 2,
      valueFlags: new Map<string, ((value: string) => boolean) | null>([
        ['--type', (v) => EDGE_TYPES.has(v)],
        ['--weight', (v) => UNIT_INTERVAL.test(v)],
        ['--meta', null],
      ]),
      booleanFlags: new Set(),
    },
  ],
  ['forget', { minPositionals: 1, maxPositionals: 1, valueFlags: new Map(), booleanFlags: new Set() }],
]);

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastSnapshotMs = 0;

/**
 * Queue files already replayed but not removable (a container can make queue/
 * read-only). Keyed by name, inode and mtime so they are never replayed twice.
 */
const replayedNotRemoved = new Set<string>();

function mnemonBase(): string {
  return process.env.MNEMON_DATA_DIR || path.join(os.homedir(), '.mnemon');
}

function findMnemonBin(): string | null {
  if (process.env.MNEMON_BIN && fs.existsSync(process.env.MNEMON_BIN)) {
    return process.env.MNEMON_BIN;
  }
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'mnemon'),
    '/opt/homebrew/bin/mnemon',
    '/usr/local/bin/mnemon',
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Check a queued argv against the allowlist; throws on anything else. Value
 * flags consume the next entry whatever it looks like, exactly as mnemon's
 * flag parser does, and `--flag=value` forms are rejected outright.
 */
export function checkQueuedArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    throw new Error('argv must be a non-empty array of strings');
  }
  const [verb, ...args] = argv as string[];
  const spec = QUEUE_VERBS.get(verb);
  if (!spec) throw new Error(`verb not allowed: ${JSON.stringify(verb)}`);

  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positionals++;
      continue;
    }
    const name = arg.split('=')[0];
    if (GLOBAL_FLAGS.has(name)) throw new Error(`mnemon global flag not allowed: ${name}`);
    if (spec.booleanFlags.has(arg)) continue;
    if (!spec.valueFlags.has(arg)) throw new Error(`unsupported ${verb} flag: ${JSON.stringify(arg)}`);
    if (i + 1 >= args.length) throw new Error(`missing value for ${arg}`);
    const value = args[++i];
    const valid = spec.valueFlags.get(arg);
    if (valid && !valid(value)) throw new Error(`invalid value for ${arg}: ${JSON.stringify(value)}`);
  }
  if (positionals < spec.minPositionals || positionals > spec.maxPositionals) {
    throw new Error(`${verb} got ${positionals} positional argument(s)`);
  }
  return argv as string[];
}

/**
 * Read a container-written queue file. O_NOFOLLOW makes a symlink fail instead
 * of reading a host file, O_NONBLOCK keeps a FIFO from wedging the event loop,
 * and the type and size are checked on the open descriptor, so swapping the
 * entry after a check changes nothing.
 */
function readQueueFile(full: string): { text: string; identity: string } {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(full, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    const buf = Buffer.alloc(QUEUE_FILE_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, n, buf.length - n, n);
      if (read === 0) break;
      n += read;
      if (n === buf.length) throw new Error(`queue file larger than ${QUEUE_FILE_MAX_BYTES} bytes`);
    }
    return { text: buf.toString('utf8', 0, n), identity: `${path.basename(full)}\0${st.ino}\0${st.mtimeMs}` };
  } finally {
    fs.closeSync(fd);
  }
}

/** Rename a queue entry to .err. rename(2) moves a link itself, never its target. */
function park(full: string, file: string): void {
  try {
    fs.renameSync(full, `${full}.err`);
    // eslint-disable-next-line no-catch-all/no-catch-all -- one unparkable entry must not stall the rest of the queue
  } catch (err) {
    log.warn('mnemon-sync: could not park queue file, leaving it in place', { file, err: String(err) });
  }
}

/** Replay queued container writes through the host mnemon CLI. Returns count replayed. */
export async function drainQueue(base: string, bin: string): Promise<number> {
  const queueDir = path.join(base, 'queue');
  let queueStat: fs.Stats;
  try {
    queueStat = fs.lstatSync(queueDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  // lstat: a symlinked queue/ would have us rename and delete files elsewhere.
  if (!queueStat.isDirectory()) {
    log.warn('mnemon-sync: queue is not a real directory, not draining', { queueDir });
    return 0;
  }

  let files: string[];
  try {
    files = fs
      .readdirSync(queueDir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort();
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable queue must not skip the snapshot refresh
  } catch (err) {
    log.warn('mnemon-sync: cannot list queue, not draining', { queueDir, err: String(err) });
    return 0;
  }
  for (const key of replayedNotRemoved) {
    if (!files.includes(key.split('\0')[0])) replayedNotRemoved.delete(key);
  }

  let replayed = 0;
  for (const file of files) {
    const full = path.join(queueDir, file);
    let argv: string[];
    let identity: string;
    try {
      const entry = readQueueFile(full);
      identity = entry.identity;
      if (replayedNotRemoved.has(identity)) continue;
      argv = checkQueuedArgv(JSON.parse(entry.text)?.argv);
      // eslint-disable-next-line no-catch-all/no-catch-all -- container-written input: any failure parks the file
    } catch (err) {
      log.warn('mnemon-sync: bad queue file, parking as .err', { file, err: String(err) });
      park(full, file);
      continue;
    }
    try {
      // execFile with an argv array — no shell, queued strings can't inject.
      await execFileAsync(bin, argv, { timeout: 60_000 });
      replayed++;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a failed replay parks the file, as before
    } catch (err) {
      log.warn('mnemon-sync: replay failed, parking as .err', { file, err: String(err) });
      park(full, file);
      continue;
    }
    try {
      fs.unlinkSync(full);
      // eslint-disable-next-line no-catch-all/no-catch-all -- the write already landed; keep draining
    } catch (err) {
      replayedNotRemoved.add(identity);
      log.warn('mnemon-sync: replayed but could not remove queue file; will not replay it again', {
        file,
        err: String(err),
      });
    }
  }
  if (replayed > 0) log.info('mnemon-sync: replayed queued writes', { replayed });
  return replayed;
}

/** Create each directory under base, refusing any component that is not a real directory. */
function ensureRealDir(base: string, parts: string[]): string | null {
  let dir = base;
  for (const part of parts) {
    dir = path.join(dir, part);
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (!fs.lstatSync(dir).isDirectory()) return null;
  }
  return dir;
}

/** Rebuild the container-readable snapshot as a DELETE-journal copy of the live DB. */
export function refreshSnapshot(base: string): void {
  const src = path.join(base, 'data', 'default', 'mnemon.db');
  let srcStat: fs.Stats;
  try {
    srcStat = fs.lstatSync(src);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  // A symlink anywhere on this path would copy some other SQLite DB into the
  // container-readable snapshot.
  const expected = path.join(fs.realpathSync(base), 'data', 'default', 'mnemon.db');
  if (!srcStat.isFile() || fs.realpathSync(src) !== expected) {
    log.warn('mnemon-sync: live store is not a regular file at its own path, skipping snapshot', { src });
    return;
  }
  const snapDir = ensureRealDir(base, ['snapshot', 'data', 'default']);
  if (!snapDir) {
    log.warn('mnemon-sync: snapshot path contains a non-directory, skipping snapshot', { base });
    return;
  }

  // Build the copy somewhere no container can reach, check it, then move it in.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-snapshot-'));
  try {
    const tmp = path.join(workDir, 'mnemon.db');
    const db = new Database(src, { readonly: true });
    try {
      // VACUUM INTO writes a fresh non-WAL DB.
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    const copy = new Database(tmp, { readonly: true });
    let tables: Set<unknown>;
    try {
      tables = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
    } finally {
      copy.close();
    }
    const missing = SNAPSHOT_REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length > 0) {
      log.warn('mnemon-sync: live store lacks mnemon tables, skipping snapshot', { src, missing });
      return;
    }
    // rename swaps it in atomically and replaces a planted link, not its target.
    fs.renameSync(tmp, path.join(snapDir, 'mnemon.db'));
    lastSnapshotMs = Date.now();
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const base = mnemonBase();
    if (!fs.existsSync(base)) return;
    const bin = findMnemonBin();
    const replayed = bin ? await drainQueue(base, bin) : 0;
    if (replayed > 0 || Date.now() - lastSnapshotMs > SNAPSHOT_MAX_AGE_MS) {
      refreshSnapshot(base);
    }
  } catch (err) {
    log.error('mnemon-sync tick failed', { err });
  } finally {
    running = false;
  }
}

export function startMnemonSync(intervalMs = 60_000): void {
  if (timer) return;
  const base = mnemonBase();
  // Marker dropped when the authoritative store moved to the Mac Mini
  // (2026-08-05): a machine-level launchd agent (mnemon-mini-sync) ships the
  // queue and maintains the snapshot; replaying locally here would write to a
  // dead store and race the shipper. Delete the marker to restore local mode.
  if (fs.existsSync(path.join(base, '.remote-authoritative'))) {
    log.info('mnemon-sync: store is remote-authoritative; local replay/snapshot disabled', { base });
    return;
  }
  if (!fs.existsSync(path.join(base, 'data', 'default', 'mnemon.db'))) {
    log.info('mnemon-sync: no mnemon store found, not starting', { base });
    return;
  }
  if (!findMnemonBin()) {
    log.warn('mnemon-sync: mnemon binary not found on host, not starting');
    return;
  }
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  log.info('mnemon-sync: started', { base, intervalMs });
}

export function stopMnemonSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

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

/** Verbs a container may queue for replay. Anything else is dropped to .err. */
const QUEUE_VERBS = new Set(['remember', 'link', 'forget']);

const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastSnapshotMs = 0;

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

/** Replay queued container writes through the host mnemon CLI. Returns count replayed. */
export async function drainQueue(base: string, bin: string): Promise<number> {
  const queueDir = path.join(base, 'queue');
  if (!fs.existsSync(queueDir)) return 0;

  const files = fs
    .readdirSync(queueDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort();

  let replayed = 0;
  for (const file of files) {
    const full = path.join(queueDir, file);
    let argv: string[];
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      argv = parsed.argv;
      if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string') || !QUEUE_VERBS.has(argv[0])) {
        throw new Error(`invalid queued argv: ${JSON.stringify(argv?.[0])}`);
      }
    } catch (err) {
      log.warn('mnemon-sync: bad queue file, parking as .err', { file, err: String(err) });
      fs.renameSync(full, `${full}.err`);
      continue;
    }
    try {
      // execFile with an argv array — no shell, queued strings can't inject.
      await execFileAsync(bin, argv, { timeout: 60_000 });
      fs.unlinkSync(full);
      replayed++;
    } catch (err) {
      log.warn('mnemon-sync: replay failed, parking as .err', { file, err: String(err) });
      fs.renameSync(full, `${full}.err`);
    }
  }
  if (replayed > 0) log.info('mnemon-sync: replayed queued writes', { replayed });
  return replayed;
}

/** Rebuild the container-readable snapshot as a DELETE-journal copy of the live DB. */
export function refreshSnapshot(base: string): void {
  const src = path.join(base, 'data', 'default', 'mnemon.db');
  if (!fs.existsSync(src)) return;
  const snapDir = path.join(base, 'snapshot', 'data', 'default');
  fs.mkdirSync(snapDir, { recursive: true });
  const tmp = path.join(snapDir, `.mnemon.db.tmp-${process.pid}`);
  fs.rmSync(tmp, { force: true });
  const db = new Database(src, { readonly: true });
  try {
    // VACUUM INTO writes a fresh non-WAL DB; rename swaps it in atomically.
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  fs.renameSync(tmp, path.join(snapDir, 'mnemon.db'));
  lastSnapshotMs = Date.now();
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

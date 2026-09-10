/**
 * Startup log rotation for the launchd-captured host logs.
 *
 * launchd opens `logs/nanoclaw.log` / `logs/nanoclaw.error.log` in append mode
 * and hands the host process the file descriptors, so the host cannot rename
 * them out from under launchd. Copy-then-truncate works with an O_APPEND fd:
 * the copy preserves history, the truncate resets the live file, and the next
 * write lands at the new end. Runs once at startup — the host restarts rarely,
 * so a size threshold here bounds growth without a second timer.
 */
import fs from 'fs';
import path from 'path';

export interface RotateOptions {
  /** Rotate a file once it exceeds this many bytes. */
  maxBytes: number;
  /** Rotated copies to keep per file; older ones are deleted. */
  keep: number;
  now?: Date;
}

export const DEFAULT_ROTATE_OPTIONS: RotateOptions = { maxBytes: 20 * 1024 * 1024, keep: 5 };

function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Rotate one file if it is over the threshold. Returns the rotated copy's path, or null. */
export function rotateLogFile(file: string, opts: RotateOptions = DEFAULT_ROTATE_OPTIONS): string | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (size <= opts.maxBytes) return null;

  const dir = path.dirname(file);
  const base = path.basename(file);
  const copy = path.join(dir, `${base}.${stamp(opts.now ?? new Date())}`);
  fs.copyFileSync(file, copy);
  fs.truncateSync(file, 0);

  // Prune: rotated copies are `<base>.<stamp>`; keep the newest `keep`.
  const rotated = fs
    .readdirSync(dir)
    .filter((e) => e.startsWith(`${base}.`) && /\.\d{8}-\d{6}$/.test(e))
    .sort();
  for (const old of rotated.slice(0, Math.max(0, rotated.length - opts.keep))) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      // Best-effort prune.
    }
  }
  return copy;
}

/** Rotate every host log under `logsDir`. Never throws — logging must not block boot. */
export function rotateHostLogs(logsDir: string, opts: RotateOptions = DEFAULT_ROTATE_OPTIONS): string[] {
  const rotated: string[] = [];
  for (const name of ['nanoclaw.log', 'nanoclaw.error.log']) {
    try {
      const copy = rotateLogFile(path.join(logsDir, name), opts);
      if (copy) rotated.push(copy);
    } catch {
      // Best-effort.
    }
  }
  return rotated;
}

/**
 * Resolve a container path to a host file the caller's container can already
 * see, and copy it into a broker workspace.
 *
 * The rule is "only what the container sees". Three things would break it if
 * the host simply joined a path onto a mount root:
 *
 *   - Masks. An empty directory is mounted over e.g. `obsidian/.obsidian`, so
 *     resolution uses the longest matching mount, exactly as Docker does.
 *   - Symlinks. The agent owns every name under its RW mounts (its group
 *     folder, its session inbox) and can plant a link to `~/.ssh`; a link in
 *     an RO tree points at a host path the container cannot follow either.
 *     Every segment is opened through `AnchoredDir` with O_NOFOLLOW, so any
 *     symlink on the way is refused, including one swapped in mid-request.
 *   - Credentials the container can read (the gws OAuth folder, `.env`
 *     files). Readable by the agent is not the same as fine to send to
 *     Google, so a denylist refuses them before any open.
 */
import fs from 'fs';

import { AnchoredDir } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';

export class BrokerError extends Error {}

export interface MountEntry {
  /** Absolute container path of the mount point, e.g. `/workspace/extra/obsidian`. */
  containerPath: string;
  /** Host directory, operator-owned (a symlink here is followed, as Docker does). */
  hostRoot: string;
  /** Fixed segments below hostRoot that the container path maps to. */
  prefix: string[];
}

export function buildMountTable(
  groupDir: string,
  sessDir: string,
  extras: ReadonlyArray<{ hostPath: string; containerPath: string }>,
): MountEntry[] {
  return [
    { containerPath: '/workspace/agent', hostRoot: groupDir, prefix: [] },
    // /workspace is the session dir; only its inbox (attachments) is a file source.
    { containerPath: '/workspace/inbox', hostRoot: sessDir, prefix: ['inbox'] },
    ...extras.map((m) => ({ containerPath: m.containerPath, hostRoot: m.hostPath, prefix: [] })),
  ];
}

function splitAbsolute(p: string): string[] | null {
  if (!p.startsWith('/') || p.includes('\0') || p.length > 2048) return null;
  const parts = p.split('/').slice(1);
  if (parts.length === 0 || parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return parts;
}

// Directory names that hold credentials or tool state, anywhere in the path.
const DENIED_DIR = /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.gemini|\.codex|\.onecli|gws-config.*)$/i;
// File names that are credentials by convention.
const DENIED_FILE =
  /^(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks))$|(^|[._-])(credentials?|client[_-]?secrets?|secrets?|tokens?|oauth[_-]?creds?)(\.[a-z0-9]+)?$/i;

export function deniedReason(parts: readonly string[]): string | null {
  const dirs = parts.slice(0, -1);
  const file = parts[parts.length - 1];
  const dir = dirs.find((d) => DENIED_DIR.test(d));
  if (dir) return `'${dir}' holds credentials or tool state`;
  if (DENIED_FILE.test(file)) return `'${file}' looks like a credential file`;
  return null;
}

export interface ResolvedFile {
  containerPath: string;
  entry: MountEntry;
  dirSegments: string[];
  fileName: string;
}

export function resolveContainerPath(table: readonly MountEntry[], containerPath: string): ResolvedFile {
  const parts = splitAbsolute(containerPath);
  if (!parts) throw new BrokerError(`${JSON.stringify(containerPath)} is not an absolute, normalized path`);
  if (parts.some((s) => !isSafeAttachmentName(s))) {
    throw new BrokerError(`${JSON.stringify(containerPath)} has an unusable path segment`);
  }

  let best: { entry: MountEntry; depth: number } | null = null;
  for (const entry of table) {
    const mountParts = entry.containerPath.split('/').slice(1);
    if (mountParts.length >= parts.length) continue; // must name something below the mount point
    if (!mountParts.every((s, i) => parts[i] === s)) continue;
    if (!best || mountParts.length > best.depth) best = { entry, depth: mountParts.length };
  }
  if (!best) {
    throw new BrokerError(
      `${containerPath} is outside /workspace/agent, /workspace/inbox and your /workspace/extra mounts`,
    );
  }

  const denied = deniedReason(parts);
  if (denied) throw new BrokerError(`${containerPath} refused: ${denied}`);

  const rel = parts.slice(best.depth);
  return {
    containerPath,
    entry: best.entry,
    dirSegments: [...best.entry.prefix, ...rel.slice(0, -1)],
    fileName: rel[rel.length - 1],
  };
}

function describeOpenError(containerPath: string, err: unknown): BrokerError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return new BrokerError(`${containerPath} does not exist`);
  if (code === 'ELOOP') return new BrokerError(`${containerPath} is a symlink; pass the real path`);
  const message = err instanceof Error ? err.message : String(err);
  if (/not a real directory/.test(message)) {
    return new BrokerError(`${containerPath} goes through a symlinked or non-directory segment; pass the real path`);
  }
  if (/not a regular file/.test(message)) return new BrokerError(`${containerPath} is not a regular file`);
  return new BrokerError(`${containerPath} could not be opened (${code ?? 'error'})`);
}

/**
 * Copy one resolved file into `dst` as `dstName`, refusing anything over
 * `limitBytes`. Returns the bytes copied. The size is checked on the open
 * descriptor and again while streaming, so a file that grows mid-copy is
 * refused rather than truncated.
 */
export function snapshotFile(file: ResolvedFile, dst: AnchoredDir, dstName: string, limitBytes: number): number {
  let src: AnchoredDir | null;
  try {
    src = AnchoredDir.open(file.entry.hostRoot, file.dirSegments);
  } catch (err) {
    throw describeOpenError(file.containerPath, err);
  }
  if (!src) throw new BrokerError(`${file.containerPath} does not exist`);
  try {
    let srcFd: number;
    try {
      srcFd = src.openReadFd(file.fileName);
    } catch (err) {
      throw describeOpenError(file.containerPath, err);
    }
    try {
      const size = fs.fstatSync(srcFd).size;
      if (size > limitBytes) {
        throw new BrokerError(
          `${file.containerPath} is ${size.toLocaleString('en-US')} bytes; the limit left is ${limitBytes.toLocaleString('en-US')}`,
        );
      }
      const dstFd = dst.openNewFd(dstName);
      let total = 0;
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let read: number;
        while ((read = fs.readSync(srcFd, buffer, 0, buffer.length, null)) > 0) {
          total += read;
          if (total > limitBytes) throw new BrokerError(`${file.containerPath} grew past the size limit while copying`);
          for (let written = 0; written < read; ) {
            written += fs.writeSync(dstFd, buffer, written, read - written);
          }
        }
      } finally {
        fs.closeSync(dstFd);
      }
      return total;
    } finally {
      fs.closeSync(srcFd);
    }
  } finally {
    src.close();
  }
}

/** Workspace file name: an index prefix keeps names unique and never special (`AGENTS.md`, `.agents`). */
export function workspaceName(index: number, fileName: string): string {
  const prefix = `${String(index + 1).padStart(2, '0')}-`;
  const clean = fileName.replace(/^\.+/, '_');
  if (Buffer.byteLength(prefix + clean, 'utf8') <= 200) return prefix + clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
  return `${prefix}${Array.from(clean).slice(0, 60).join('')}~${ext}`;
}

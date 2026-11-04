/**
 * Resolve a container path to a host file the caller's container can already
 * see, and copy it into a broker workspace.
 *
 * The rule is "only what the container sees, and never a credential". Things
 * that would break it if the host simply joined a path onto a mount root:
 *
 *   - Masks. An empty directory is mounted over e.g. `obsidian/.obsidian`, so
 *     resolution uses the longest matching mount, exactly as Docker does, on
 *     normalized paths (Docker cleans `obsidian/.obsidian/` too). A configured
 *     mount that fails validation now, such as a mask whose empty dir went
 *     missing, is not silently dropped: everything under it is refused,
 *     because the running container may still have it.
 *   - Symlinks. The agent owns every name under its RW mounts and can plant a
 *     link to `~/.ssh`; a link in an RO tree points at a host path the
 *     container cannot follow either. Every segment is opened through
 *     `AnchoredDir` with O_NOFOLLOW. A mount whose own host path resolves
 *     through a symlink (one an agent could have swapped in through an RW
 *     parent mount) is refused as a whole.
 *   - Credentials the container can read. Readable by the agent is not the
 *     same as fine to send to Google: names, directories (container and host
 *     side) and file contents are checked.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AnchoredDir } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';

export class BrokerError extends Error {}

export interface MountEntry {
  /** Normalized absolute container path of the mount point, e.g. `/workspace/extra/obsidian`. */
  containerPath: string;
  /** Host directory, operator-owned (a symlink here is followed, as Docker does). */
  hostRoot: string;
  /** Fixed segments below hostRoot that the container path maps to. */
  prefix: string[];
  /** Set when nothing under this mount may be read. */
  refuse?: string;
}

/** Docker cleans mount targets; match that so `obsidian/.obsidian/` still masks. */
export function normalizeContainerPath(p: string): string {
  const n = path.posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

function expandHome(p: string): string {
  if (p === '~') return process.env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), p.slice(2));
  return path.resolve(p);
}

export interface ConfiguredMount {
  hostPath: string;
  containerPath?: string;
}

export interface ValidatedMount {
  hostPath: string;
  containerPath: string;
}

/**
 * The caller's mount table: its workspace, its session inbox, the extra
 * mounts that validate now, and refusal entries for configured mounts that
 * do not (or that resolve through a symlink).
 */
export function buildMountTable(
  groupDir: string,
  sessDir: string,
  configured: readonly ConfiguredMount[],
  validated: readonly ValidatedMount[],
): MountEntry[] {
  const extras: MountEntry[] = validated.map((m) => ({
    containerPath: normalizeContainerPath(m.containerPath),
    hostRoot: m.hostPath,
    prefix: [],
  }));
  for (const c of configured) {
    const name = c.containerPath || path.basename(c.hostPath);
    if (!name || name.startsWith('/') || name.split('/').includes('..')) continue;
    const intended = normalizeContainerPath(`/workspace/extra/${name}`);
    const match = extras.find((e) => e.containerPath === intended);
    if (!match) {
      extras.push({ containerPath: intended, hostRoot: '', prefix: [], refuse: 'failed validation on the host' });
    } else if (path.resolve(match.hostRoot) !== expandHome(c.hostPath)) {
      match.refuse = 'resolves through a symlink on the host';
    }
  }
  return [
    { containerPath: '/workspace/agent', hostRoot: groupDir, prefix: [] },
    // /workspace is the session dir; only its inbox (attachments) is a file source.
    { containerPath: '/workspace/inbox', hostRoot: sessDir, prefix: ['inbox'] },
    ...extras,
  ];
}

function splitAbsolute(p: string): string[] | null {
  if (!p.startsWith('/') || p.includes('\0') || p.length > 2048) return null;
  const parts = p.split('/').slice(1);
  if (parts.length === 0 || parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return parts;
}

// Directories that hold credentials or tool state, checked on container and host paths.
const DENIED_DIR =
  /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.gemini|\.codex|\.claude|\.onecli|\.config|\.git|keys|id|gws-config.*)$/i;
const DENIED_DIR_STEM = /(^|[._-])(credentials?|secrets?|tokens?)([._-]|$)/i;
// File names that are credentials by convention, whatever the extension.
const DENIED_FILE =
  /^(\.env(\..*)?|.*\.env|\.envrc|\.netrc|\.npmrc|\.pypirc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|ovpn))$/i;
// Credential stems, refused unless the file is plainly a document.
const DENIED_FILE_STEM =
  /(^|[._-])(credentials?|client[_-]?secrets?|secrets?|tokens?|oauth[_-]?creds?|(sa|service[_-]?account)[_-]?keys?|api[_-]?keys?|passwords?)([._-]|$)/i;
const DOCUMENT_EXT = /\.(md|markdown|csv|tsv|pdf|docx?|html?|rtf|pptx?|xlsx?|odt)$/i;

function deniedDir(segment: string): boolean {
  return DENIED_DIR.test(segment) || DENIED_DIR_STEM.test(segment);
}

export function deniedReason(parts: readonly string[], hostRoot = ''): string | null {
  const dir = [...hostRoot.split('/').filter(Boolean), ...parts.slice(0, -1)].find(deniedDir);
  if (dir) return `'${dir}' holds credentials or tool state`;
  const file = parts[parts.length - 1];
  if (DENIED_FILE.test(file) || (DENIED_FILE_STEM.test(file) && !DOCUMENT_EXT.test(file))) {
    return `'${file}' looks like a credential file`;
  }
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
  if (best.entry.refuse) {
    throw new BrokerError(`${containerPath} is under ${best.entry.containerPath}, which ${best.entry.refuse}`);
  }

  const denied = deniedReason(parts, best.entry.hostRoot);
  if (denied) throw new BrokerError(`${containerPath} refused: ${denied}`);

  const rel = parts.slice(best.depth);
  return {
    containerPath,
    entry: best.entry,
    dirSegments: [...best.entry.prefix, ...rel.slice(0, -1)],
    fileName: rel[rel.length - 1],
  };
}

const SECRET_CONTENT: ReadonlyArray<readonly [string, RegExp]> = [
  ['a private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['an OAuth refresh token', /"refresh_token"\s*:\s*"[^"]{20,}"/],
  ['an OAuth client secret', /"client_secret"\s*:\s*"[^"]{10,}"/],
  ['a Google access token', /\bya29\.[0-9A-Za-z_-]{20,}/],
  ['a Slack token', /\bxox[abposr]-[0-9A-Za-z-]{10,}/],
  ['an Anthropic or OpenAI key', /\bsk-(?:ant|proj)-[0-9A-Za-z_-]{20,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[0-9A-Za-z]{36}\b/],
];

/** The kind of credential `data` contains, or null. Catches a credential copied to an innocent name. */
export function secretInContent(data: Buffer): string | null {
  const text = data.toString('latin1');
  for (const [label, re] of SECRET_CONTENT) if (re.test(text)) return label;
  return null;
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
 * `limitBytes` or carrying a credential. Returns the bytes copied. The size
 * is checked on the open descriptor and again while streaming, so a file that
 * grows mid-copy is refused rather than truncated.
 */
export function snapshotFile(file: ResolvedFile, dst: AnchoredDir, dstName: string, limitBytes: number): number {
  let src: AnchoredDir | null;
  try {
    src = AnchoredDir.open(file.entry.hostRoot, file.dirSegments);
  } catch (err) {
    throw describeOpenError(file.containerPath, err);
  }
  if (!src) throw new BrokerError(`${file.containerPath} does not exist`);
  let total = 0;
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
    } finally {
      fs.closeSync(srcFd);
    }
  } finally {
    src.close();
  }
  const secret = secretInContent(dst.readFile(dstName));
  if (secret) {
    dst.unlink(dstName);
    throw new BrokerError(
      `${file.containerPath} appears to contain ${secret}; the broker never sends credentials to Google`,
    );
  }
  return total;
}

/**
 * Create (or check) a host-private directory: a real directory, not a
 * symlink, owned by this user, mode 0700. Guards a predictable temp root
 * someone else could pre-create.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new BrokerError(`${dir} is not a real directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new BrokerError(`${dir} is owned by another user`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
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

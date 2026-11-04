import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnchoredDir } from '../../anchored-dir.js';
import {
  BrokerError,
  buildMountTable,
  deniedReason,
  ensurePrivateDir,
  resolveContainerPath,
  secretInContent,
  snapshotFile,
  workspaceName,
} from './paths.js';

let root: string;
let groupDir: string;
let sessDir: string;
let vault: string;
let empty: string;
let outside: string;
let dst: AnchoredDir;

function table() {
  return buildMountTable(
    groupDir,
    sessDir,
    [
      { hostPath: vault, containerPath: 'obsidian' },
      { hostPath: empty, containerPath: 'obsidian/.obsidian/' },
    ],
    [
      { hostPath: vault, containerPath: '/workspace/extra/obsidian' },
      // Docker cleans the trailing slash; the broker must match it to keep the mask.
      { hostPath: empty, containerPath: '/workspace/extra/obsidian/.obsidian/' },
    ],
  );
}

function copy(containerPath: string, limit = 1024 * 1024): number {
  const file = resolveContainerPath(table(), containerPath);
  return snapshotFile(file, dst, workspaceName(0, file.fileName), limit);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-paths-')));
  groupDir = path.join(root, 'group');
  sessDir = path.join(root, 'session');
  vault = path.join(root, 'vault');
  empty = path.join(root, 'empty');
  outside = path.join(root, 'outside');
  for (const d of [
    groupDir,
    path.join(sessDir, 'inbox', 'msg-1'),
    path.join(vault, 'notes'),
    path.join(vault, '.obsidian'),
    empty,
    outside,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(groupDir, 'note.md'), 'group note');
  fs.writeFileSync(path.join(sessDir, 'inbox', 'msg-1', 'upload.txt'), 'uploaded');
  fs.writeFileSync(path.join(vault, 'notes', 'a.md'), 'vault note');
  fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.json'), 'masked from the container');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'host-only');
  fs.mkdirSync(path.join(root, 'work'));
  dst = AnchoredDir.open(path.join(root, 'work'), [], false)!;
});

afterEach(() => {
  dst.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveContainerPath', () => {
  it('maps the agent workspace, the session inbox and extra mounts', () => {
    expect(resolveContainerPath(table(), '/workspace/agent/note.md')).toMatchObject({
      dirSegments: [],
      fileName: 'note.md',
    });
    expect(resolveContainerPath(table(), '/workspace/inbox/msg-1/upload.txt')).toMatchObject({
      dirSegments: ['inbox', 'msg-1'],
      fileName: 'upload.txt',
    });
    expect(resolveContainerPath(table(), '/workspace/extra/obsidian/notes/a.md').entry.hostRoot).toBe(vault);
  });

  it('uses the longest mount, so a mask wins over its parent even with a trailing slash', () => {
    expect(resolveContainerPath(table(), '/workspace/extra/obsidian/.obsidian/workspace.json').entry.hostRoot).toBe(
      empty,
    );
  });

  it('refuses everything under a configured mount that no longer validates', () => {
    const t = buildMountTable(
      groupDir,
      sessDir,
      [
        { hostPath: vault, containerPath: 'obsidian' },
        { hostPath: path.join(root, 'gone'), containerPath: 'obsidian/.obsidian' },
      ],
      [{ hostPath: vault, containerPath: '/workspace/extra/obsidian' }],
    );
    expect(() => resolveContainerPath(t, '/workspace/extra/obsidian/.obsidian/plugins/x/data.json')).toThrow(
      /failed validation/,
    );
    expect(resolveContainerPath(t, '/workspace/extra/obsidian/notes/a.md').entry.hostRoot).toBe(vault);
  });

  it('refuses a mount whose host path resolves through a symlink', () => {
    fs.symlinkSync(outside, path.join(vault, 'swapped'));
    const t = buildMountTable(
      groupDir,
      sessDir,
      [{ hostPath: path.join(vault, 'swapped'), containerPath: 'nested' }],
      [{ hostPath: outside, containerPath: '/workspace/extra/nested' }],
    );
    expect(() => resolveContainerPath(t, '/workspace/extra/nested/private.txt')).toThrow(/symlink/);
  });

  it('refuses paths outside every mount, relative or unnormalized paths, and mount points', () => {
    for (const p of [
      '/etc/passwd',
      '/workspace/inbound.db',
      '/workspace/extra/other/x.md',
      'workspace/agent/note.md',
      '/workspace/agent/../../outside/private.txt',
      '/workspace/agent/./note.md',
      '/workspace/agent//note.md',
      '/workspace/agent',
      '/workspace/extra/obsidian',
    ]) {
      expect(() => resolveContainerPath(table(), p), p).toThrow(BrokerError);
    }
  });

  it('refuses credential paths the container can read, by name, directory or host root', () => {
    for (const parts of [
      ['workspace', 'extra', 'gws-config', 'accounts', 'brad.json'],
      ['workspace', 'extra', 'google-ads-tokens', 'oauth.json'],
      ['workspace', 'agent', '.git', 'config'],
      ['workspace', 'agent', '.config', 'gh', 'hosts.yml'],
    ]) {
      expect(deniedReason(parts), parts.join('/')).toMatch(/credentials or tool state/);
    }
    expect(deniedReason(['workspace', 'extra', 'gws', 'accounts', 'x.json'], '/Users/me/.config/gws')).not.toBeNull();
    for (const name of [
      '.env',
      '.env.local',
      'prod.env',
      '.envrc',
      'client_secret.json',
      'client_secret_123-abc.apps.googleusercontent.com.json',
      'credentials.json',
      'credentials.json.tmp',
      'token.json.bak',
      'gcp-sa-key.json',
      'id_ed25519',
      'server.pem',
      'oauth_creds.json',
      'antigravity-oauth-token',
      'secrets.txt',
    ]) {
      expect(deniedReason(['workspace', 'agent', name]), name).not.toBeNull();
    }
    for (const name of [
      'token-economy.md',
      'design-tokens.md',
      'openai-usage-tokens.csv',
      'handling-secrets.md',
      'meeting-notes.md',
      'secretary.md',
      'Q3 credentials review notes.md',
    ]) {
      expect(deniedReason(['workspace', 'agent', name]), name).toBeNull();
    }
  });
});

describe('secretInContent', () => {
  it('spots credentials copied to an innocent name, and leaves prose alone', () => {
    expect(secretInContent(Buffer.from('{"refresh_token": "1//0abcdefghijklmnopqrstuvwxyz"}'))).toMatch(/refresh/);
    expect(secretInContent(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'))).toMatch(/private key/);
    expect(secretInContent(Buffer.from('Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx'))).toMatch(/Google/);
    expect(secretInContent(Buffer.from('We rotated the refresh_token policy and the client_secret docs.'))).toBeNull();
  });
});

describe('snapshotFile', () => {
  it('copies regular files and reports the byte count', () => {
    expect(copy('/workspace/agent/note.md')).toBe('group note'.length);
    expect(fs.readFileSync(path.join(root, 'work', '01-note.md'), 'utf-8')).toBe('group note');
  });

  it('copies from the inbox and RO mounts', () => {
    expect(copy('/workspace/inbox/msg-1/upload.txt')).toBe(8);
  });

  it('treats a masked file as missing, as the container sees it', () => {
    expect(() => copy('/workspace/extra/obsidian/.obsidian/workspace.json')).toThrow(/does not exist/);
  });

  it('refuses a symlinked file planted in the RW workspace', () => {
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(groupDir, 'link.md'));
    expect(() => copy('/workspace/agent/link.md')).toThrow(/symlink/);
  });

  it('refuses a symlinked directory segment', () => {
    fs.symlinkSync(outside, path.join(groupDir, 'escape'));
    expect(() => copy('/workspace/agent/escape/private.txt')).toThrow(/symlink|real path/);
    fs.symlinkSync(outside, path.join(sessDir, 'inbox', 'msg-2'));
    expect(() => copy('/workspace/inbox/msg-2/private.txt')).toThrow(/symlink|real path/);
  });

  it('refuses a file whose contents are a credential, and removes the copy', () => {
    fs.writeFileSync(path.join(groupDir, 'notes-backup.md'), '{"client_secret": "GOCSPX-abcdefghijklmnop"}');
    expect(() => copy('/workspace/agent/notes-backup.md')).toThrow(/credentials to Google/);
    expect(fs.readdirSync(path.join(root, 'work'))).toEqual([]);
  });

  it('refuses missing files, directories and files over the limit', () => {
    expect(() => copy('/workspace/agent/missing.md')).toThrow(/does not exist/);
    fs.mkdirSync(path.join(groupDir, 'dir'));
    expect(() => copy('/workspace/agent/dir')).toThrow(BrokerError);
    expect(() => copy('/workspace/agent/note.md', 4)).toThrow(/limit/);
  });
});

describe('ensurePrivateDir', () => {
  it('creates a 0700 directory and tightens a loose one', () => {
    const dir = path.join(root, 'private');
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a pre-planted symlink', () => {
    const link = path.join(root, 'planted');
    fs.symlinkSync(outside, link);
    expect(() => ensurePrivateDir(link)).toThrow(/not a real directory/);
  });
});

describe('workspaceName', () => {
  it('prefixes an index and neutralizes leading dots', () => {
    expect(workspaceName(0, 'AGENTS.md')).toBe('01-AGENTS.md');
    expect(workspaceName(11, '.agents')).toBe('12-_agents');
    const long = workspaceName(2, `${'x'.repeat(300)}.md`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith('.md')).toBe(true);
  });
});

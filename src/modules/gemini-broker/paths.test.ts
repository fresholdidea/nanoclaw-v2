import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnchoredDir } from '../../anchored-dir.js';
import {
  BrokerError,
  buildMountTable,
  deniedReason,
  resolveContainerPath,
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
  return buildMountTable(groupDir, sessDir, [
    { hostPath: vault, containerPath: '/workspace/extra/obsidian' },
    { hostPath: empty, containerPath: '/workspace/extra/obsidian/.obsidian' },
  ]);
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

  it('uses the longest mount, so a mask wins over its parent', () => {
    expect(resolveContainerPath(table(), '/workspace/extra/obsidian/.obsidian/workspace.json').entry.hostRoot).toBe(
      empty,
    );
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

  it('refuses credential paths the container can read', () => {
    expect(deniedReason(['workspace', 'extra', 'gws-config', 'accounts', 'brad.json'])).toMatch(/credentials/);
    for (const name of [
      '.env',
      '.env.local',
      'client_secret.json',
      'credentials.json',
      'id_ed25519',
      'server.pem',
      'oauth_creds.json',
      'antigravity-oauth-token',
    ]) {
      expect(deniedReason(['workspace', 'agent', name]), name).not.toBeNull();
    }
    for (const name of ['token-economy.md', 'meeting-notes.md', 'secretary.md', 'Q3 credentials review notes.md']) {
      expect(deniedReason(['workspace', 'agent', name]), name).toBeNull();
    }
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

  it('refuses missing files, directories and files over the limit', () => {
    expect(() => copy('/workspace/agent/missing.md')).toThrow(/does not exist/);
    fs.mkdirSync(path.join(groupDir, 'dir'));
    expect(() => copy('/workspace/agent/dir')).toThrow(BrokerError);
    expect(() => copy('/workspace/agent/note.md', 4)).toThrow(/limit/);
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

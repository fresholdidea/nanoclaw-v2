import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCcusageEnvironment, createClaudeUsageView, discoverNanoClawUsagePaths } from './ccusage.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ccusage-test-'));
  roots.push(root);
  return root;
}

describe('discoverNanoClawUsagePaths', () => {
  it('finds Claude, Codex, and OpenCode data in the v2 session layout', () => {
    const root = tempRoot();
    const group = path.join(root, 'ag-one');
    fs.mkdirSync(path.join(group, '.claude-shared', 'projects', '-workspace-agent'), { recursive: true });
    fs.mkdirSync(path.join(group, '.codex-shared', 'sessions', '2026', '08'), { recursive: true });
    fs.mkdirSync(path.join(group, 'sess-one', 'opencode-xdg', 'opencode', 'storage'), { recursive: true });
    fs.mkdirSync(path.join(root, '.not-a-group', '.claude-shared', 'projects'), { recursive: true });

    expect(discoverNanoClawUsagePaths(root)).toEqual({
      claude: [path.join(group, '.claude-shared')],
      codex: [path.join(group, '.codex-shared')],
      opencode: [path.join(group, 'sess-one', 'opencode-xdg', 'opencode')],
      antigravity: [],
    });
  });
});

describe('createClaudeUsageView', () => {
  it('exposes rotated transcripts to ccusage without changing source files', () => {
    const root = tempRoot();
    const projects = path.join(root, 'claude', 'projects', '-workspace-agent');
    fs.mkdirSync(projects, { recursive: true });
    const active = path.join(projects, 'active.jsonl');
    const rotated = path.join(projects, 'old.jsonl.rotated-123');
    fs.writeFileSync(active, '{}\n');
    fs.writeFileSync(rotated, '{}\n');

    const view = createClaudeUsageView([path.join(root, 'claude')]);
    expect(view).not.toBeNull();
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(rotated)).toBe(true);

    const stagedFiles: string[] = [];
    const collect = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else stagedFiles.push(full);
      }
    };
    collect(view!.configDir);
    expect(stagedFiles.some((file) => file.endsWith('active.jsonl'))).toBe(true);
    expect(stagedFiles.some((file) => file.endsWith('old.rotated-123.jsonl'))).toBe(true);
    expect(fs.lstatSync(stagedFiles.find((file) => file.endsWith('active.jsonl'))!).isSymbolicLink()).toBe(false);

    const viewRoot = view!.configDir;
    view!.cleanup();
    expect(fs.existsSync(viewRoot)).toBe(false);
  });

  it('returns null when no transcript files exist', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'claude', 'projects', '-workspace-agent'), { recursive: true });
    expect(createClaudeUsageView([path.join(root, 'claude')])).toBeNull();
  });
});

describe('buildCcusageEnvironment', () => {
  it('preserves host defaults and appends NanoClaw roots', () => {
    const env = buildCcusageEnvironment(
      { HOME: '/home/test' },
      {
        claude: ['/install/data/v2-sessions/ag-1/.claude-shared'],
        codex: ['/install/data/v2-sessions/ag-2/.codex-shared'],
        opencode: ['/install/data/v2-sessions/ag-3/sess-1/opencode-xdg/opencode'],
        antigravity: ['/home/test/.gemini/antigravity-cli'],
      },
    );

    expect(env.CLAUDE_CONFIG_DIR).toBe(
      '/home/test/.config/claude,/home/test/.claude,/install/data/v2-sessions/ag-1/.claude-shared',
    );
    expect(env.CODEX_HOME).toBe('/home/test/.codex,/install/data/v2-sessions/ag-2/.codex-shared');
    expect(env.OPENCODE_DATA_DIR).toBe(
      '/home/test/.local/share/opencode,/install/data/v2-sessions/ag-3/sess-1/opencode-xdg/opencode',
    );
    expect(env.ANTIGRAVITY_DATA_DIR).toBe('/home/test/.gemini/antigravity-cli');
  });

  it('keeps explicitly configured source paths and deduplicates additions', () => {
    const env = buildCcusageEnvironment(
      {
        HOME: '/home/test',
        CLAUDE_CONFIG_DIR: '/custom/claude,/install/data/v2-sessions/ag-1/.claude-shared',
      },
      {
        claude: ['/install/data/v2-sessions/ag-1/.claude-shared', '/install/data/v2-sessions/ag-2/.claude-shared'],
        codex: [],
        opencode: [],
        antigravity: [],
      },
    );

    expect(env.CLAUDE_CONFIG_DIR).toBe(
      '/custom/claude,/install/data/v2-sessions/ag-1/.claude-shared,/install/data/v2-sessions/ag-2/.claude-shared',
    );
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('can isolate NanoClaw paths from host defaults', () => {
    const env = buildCcusageEnvironment(
      {
        HOME: '/home/test',
        CLAUDE_CONFIG_DIR: '/host/claude',
        CODEX_HOME: '/host/codex',
      },
      {
        claude: ['/nanoclaw/claude-view'],
        codex: [],
        opencode: ['/nanoclaw/opencode'],
        antigravity: ['/home/test/.gemini/antigravity-cli'],
      },
      '/tmp/isolated-home',
      false,
    );

    expect(env.HOME).toBe('/home/test');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/nanoclaw/claude-view');
    expect(env.CODEX_HOME).toBe('');
    expect(env.OPENCODE_DATA_DIR).toBe('/nanoclaw/opencode');
    expect(env.ANTIGRAVITY_DATA_DIR).toBe('/home/test/.gemini/antigravity-cli');
  });
});

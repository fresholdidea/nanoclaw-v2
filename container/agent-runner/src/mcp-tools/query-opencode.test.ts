import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

let stubDir: string;
let originalOpencodeBin: string | undefined;
let originalSubqueryRoot: string | undefined;
let originalProvider: string | undefined;
let originalModel: string | undefined;

beforeEach(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-stub-'));
  originalOpencodeBin = process.env.OPENCODE_BIN;
  originalSubqueryRoot = process.env.OPENCODE_SUBQUERY_ROOT;
  originalProvider = process.env.OPENCODE_PROVIDER;
  originalModel = process.env.OPENCODE_MODEL;
  process.env.OPENCODE_SUBQUERY_ROOT = path.join(stubDir, 'subquery');
  fs.mkdirSync(process.env.OPENCODE_SUBQUERY_ROOT, { recursive: true });
  // Enablement env vars — set by the opencode provider contribution in prod.
  process.env.OPENCODE_PROVIDER = 'openrouter';
  process.env.OPENCODE_MODEL = 'openrouter/deepseek/deepseek-v4-flash';
});

afterEach(() => {
  for (const [key, original] of [
    ['OPENCODE_BIN', originalOpencodeBin],
    ['OPENCODE_SUBQUERY_ROOT', originalSubqueryRoot],
    ['OPENCODE_PROVIDER', originalProvider],
    ['OPENCODE_MODEL', originalModel],
  ] as const) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
});

function writeStub(name: string, body: string): string {
  const p = path.join(stubDir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

async function runHandler(args: Record<string, unknown>) {
  const mod = await import('./query-opencode.js');
  return await mod.queryOpencode.handler(args);
}

describe('query_opencode MCP tool', () => {
  test('returns stdout from a successful opencode spawn', async () => {
    process.env.OPENCODE_BIN = writeStub('opencode-success.sh', '#!/bin/sh\necho "PONG from stub"\nexit 0\n');
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('PONG from stub');
  });

  test('returns isError when env vars are missing', async () => {
    delete process.env.OPENCODE_PROVIDER;
    delete process.env.OPENCODE_MODEL;
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/env vars not set|not enabled/);
  });

  test('returns isError when opencode exits non-zero', async () => {
    process.env.OPENCODE_BIN = writeStub('opencode-fail.sh', '#!/bin/sh\necho "broken" >&2\nexit 2\n');
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exited 2/);
    expect(result.content[0].text).toContain('broken');
  });

  test('returns isError when stdout is empty (exit 0)', async () => {
    process.env.OPENCODE_BIN = writeStub('opencode-empty.sh', '#!/bin/sh\nexit 0\n');
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/empty stdout/);
  });

  test('times out and kills a slow opencode', async () => {
    process.env.OPENCODE_BIN = writeStub('opencode-slow.sh', '#!/bin/sh\nsleep 30\necho "should not see this"\n');
    const result = await runHandler({ prompt: 'hello', timeoutMs: 1500 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out/);
  }, 10000);

  test('rejects missing prompt arg', async () => {
    process.env.OPENCODE_BIN = writeStub('opencode-success.sh', '#!/bin/sh\necho ok\n');
    const result = await runHandler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/prompt is required/);
  });

  test('honors model override arg', async () => {
    // Stub echoes the argv so we can assert --model gets the override
    process.env.OPENCODE_BIN = writeStub('opencode-echo.sh', '#!/bin/sh\necho "argv: $@"\nexit 0\n');
    const result = await runHandler({ prompt: 'hello', model: 'openrouter/qwen/qwen3-coder' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('--model openrouter/qwen/qwen3-coder');
  });

  test('injects OPENCODE_CONFIG_CONTENT with provider auth via OneCLI proxy', async () => {
    process.env.OPENCODE_BIN = writeStub(
      'opencode-config-echo.sh',
      '#!/bin/sh\necho "$OPENCODE_CONFIG_CONTENT"\nexit 0\n',
    );
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:54321/proxy';
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBeFalsy();
    const cfg = JSON.parse(result.content[0].text as string);
    expect(cfg.enabled_providers).toEqual(['openrouter']);
    expect(cfg.provider.openrouter.options.baseURL).toBe('http://127.0.0.1:54321/proxy');
    expect(cfg.provider.openrouter.options.apiKey).toBe('placeholder');
    expect(cfg.mcp).toEqual({});
    expect(cfg.instructions).toBeUndefined();
  });

  test('returns isError when bin path is absolute and missing', async () => {
    process.env.OPENCODE_BIN = '/nonexistent/path/to/opencode';
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/binary not found/);
  });

  test('cleans up the per-call cwd after success', async () => {
    process.env.OPENCODE_BIN = writeStub('opencode-cwd.sh', '#!/bin/sh\necho "in $PWD"\nexit 0\n');
    const subqueryRoot = process.env.OPENCODE_SUBQUERY_ROOT!;
    await runHandler({ prompt: 'hello' });
    const remaining = fs.readdirSync(subqueryRoot);
    expect(remaining).toEqual([]);
  });
});

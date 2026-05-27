import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stub binary directory — recreated per test
let stubDir: string;
let originalAgyBin: string | undefined;
let originalSubqueryRoot: string | undefined;

beforeEach(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stub-'));
  originalAgyBin = process.env.AGY_BIN;
  // Override the SUBQUERY_ROOT path via env so the tool writes to a host-writable dir
  // (the default '/workspace/agent/.agy-subquery' won't exist in test envs).
  originalSubqueryRoot = process.env.AGY_SUBQUERY_ROOT;
  process.env.AGY_SUBQUERY_ROOT = path.join(stubDir, 'subquery');
  fs.mkdirSync(process.env.AGY_SUBQUERY_ROOT, { recursive: true });
});

afterEach(() => {
  if (originalAgyBin === undefined) delete process.env.AGY_BIN;
  else process.env.AGY_BIN = originalAgyBin;
  if (originalSubqueryRoot === undefined) delete process.env.AGY_SUBQUERY_ROOT;
  else process.env.AGY_SUBQUERY_ROOT = originalSubqueryRoot;
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
});

function writeStub(name: string, body: string): string {
  const p = path.join(stubDir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

async function runHandler(args: Record<string, unknown>) {
  // query-agy reads AGY_BIN / AGY_SUBQUERY_ROOT lazily inside the handler,
  // so a single import (cached) picks up per-test env overrides correctly.
  const mod = await import('./query-agy.js');
  return await mod.queryAgy.handler(args);
}

describe('query_agy MCP tool', () => {
  test('returns stdout from a successful agy spawn', async () => {
    process.env.AGY_BIN = writeStub('agy-success.sh', '#!/bin/sh\necho "PONG from stub"\nexit 0\n');
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('PONG from stub');
  });

  test('returns isError when agy binary is missing', async () => {
    process.env.AGY_BIN = '/nonexistent/path/to/agy';
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/binary not found|not enabled/);
  });

  test('returns isError when agy exits non-zero', async () => {
    process.env.AGY_BIN = writeStub('agy-fail.sh', '#!/bin/sh\necho "broken" >&2\nexit 2\n');
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exited 2/);
    expect(result.content[0].text).toContain('broken');
  });

  test('returns isError when stdout is empty (exit 0)', async () => {
    process.env.AGY_BIN = writeStub('agy-empty.sh', '#!/bin/sh\nexit 0\n');
    const result = await runHandler({ prompt: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/empty stdout/);
  });

  test('times out and kills a slow agy', async () => {
    process.env.AGY_BIN = writeStub('agy-slow.sh', '#!/bin/sh\nsleep 30\necho "should not see this"\n');
    const result = await runHandler({ prompt: 'hello', timeoutMs: 1500 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out/);
  }, 10000);

  test('rejects missing prompt arg', async () => {
    process.env.AGY_BIN = writeStub('agy-success.sh', '#!/bin/sh\necho ok\n');
    const result = await runHandler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/prompt is required/);
  });
});

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../container/mnemon-queue.mjs');
const dirs: string[] = [];

function makeQueueDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-queue-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('container mnemon queue writer', () => {
  it('rejects unsupported remember flags instead of creating a replay file', () => {
    const queueDir = makeQueueDir();

    const result = spawnSync(
      process.execPath,
      [script, queueDir, 'remember', 'an SEO research result', '--category', 'context'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported flag: --category');
    expect(fs.readdirSync(queueDir)).toEqual([]);
  });

  it('rejects invalid remember categories instead of creating a replay file', () => {
    const queueDir = makeQueueDir();

    const result = spawnSync(
      process.execPath,
      [script, queueDir, 'remember', 'an agent-supervision lesson', '--cat', 'methodology/agent-supervision'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid category "methodology/agent-supervision"');
    expect(fs.readdirSync(queueDir)).toEqual([]);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateHostLogs, rotateLogFile } from './log-rotate.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-logrotate-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('rotateLogFile', () => {
  it('leaves a file under the threshold alone', () => {
    const f = path.join(dir, 'nanoclaw.log');
    fs.writeFileSync(f, 'small');
    expect(rotateLogFile(f, { maxBytes: 100, keep: 2 })).toBeNull();
    expect(fs.readFileSync(f, 'utf-8')).toBe('small');
  });

  it('copies then truncates a file over the threshold, keeping the inode', () => {
    const f = path.join(dir, 'nanoclaw.log');
    fs.writeFileSync(f, 'x'.repeat(200));
    const inoBefore = fs.statSync(f).ino;
    const copy = rotateLogFile(f, { maxBytes: 100, keep: 2, now: new Date(2026, 8, 10, 11, 22, 33) });
    expect(copy).toBe(path.join(dir, 'nanoclaw.log.20260910-112233'));
    expect(fs.readFileSync(copy!, 'utf-8')).toBe('x'.repeat(200));
    expect(fs.statSync(f).size).toBe(0);
    expect(fs.statSync(f).ino).toBe(inoBefore);
  });

  it('prunes rotated copies beyond keep, oldest first', () => {
    const f = path.join(dir, 'nanoclaw.log');
    for (const s of ['20260101-000000', '20260201-000000', '20260301-000000']) {
      fs.writeFileSync(`${f}.${s}`, 'old');
    }
    fs.writeFileSync(f, 'x'.repeat(200));
    rotateLogFile(f, { maxBytes: 100, keep: 2, now: new Date(2026, 8, 10, 0, 0, 0) });
    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual(['nanoclaw.log', 'nanoclaw.log.20260301-000000', 'nanoclaw.log.20260910-000000']);
  });

  it('returns null for a missing file', () => {
    expect(rotateLogFile(path.join(dir, 'nope.log'), { maxBytes: 1, keep: 1 })).toBeNull();
  });
});

describe('rotateHostLogs', () => {
  it('rotates both host logs and reports the copies', () => {
    fs.writeFileSync(path.join(dir, 'nanoclaw.log'), 'x'.repeat(50));
    fs.writeFileSync(path.join(dir, 'nanoclaw.error.log'), 'y'.repeat(50));
    const rotated = rotateHostLogs(dir, { maxBytes: 10, keep: 3, now: new Date(2026, 0, 1, 0, 0, 0) });
    expect(rotated.map((p) => path.basename(p))).toEqual([
      'nanoclaw.log.20260101-000000',
      'nanoclaw.error.log.20260101-000000',
    ]);
  });
});

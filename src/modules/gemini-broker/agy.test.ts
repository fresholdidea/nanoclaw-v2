import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseAgyOutput, prepareBrokerHome, pruneConversations, runAgy } from './agy.js';
import { type BrokerConfig, loadBrokerConfig } from './config.js';
import { BrokerError } from './paths.js';

let root: string;
let cfg: BrokerConfig;

function fakeAgy(body: string): string {
  const bin = path.join(root, 'fake-agy');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-agy-')));
  const stateDir = path.join(root, 'state');
  fs.writeFileSync(path.join(root, 'token'), 'fake-token');
  cfg = {
    ...loadBrokerConfig({ GEMINI_BROKER_SOURCE_TOKEN: path.join(root, 'token') }),
    stateDir,
    homeDir: path.join(stateDir, 'home'),
    timeoutSec: 30,
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('prepareBrokerHome', () => {
  it('writes deny-all rules and copies the token with tight modes', () => {
    prepareBrokerHome(cfg);
    const dir = path.join(cfg.homeDir, '.gemini', 'antigravity-cli');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
    expect(settings.permissions.deny).toEqual([
      'command(*)',
      'mcp(*)',
      'read_url(*)',
      'execute_url(*)',
      'write_file(*)',
    ]);
    expect(fs.readFileSync(path.join(dir, 'antigravity-oauth-token'), 'utf-8')).toBe('fake-token');
    expect(fs.statSync(path.join(dir, 'antigravity-oauth-token')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(cfg.homeDir).mode & 0o777).toBe(0o700);
  });

  it('keeps a refreshed copy until the source sign-in is newer', () => {
    prepareBrokerHome(cfg);
    const copy = path.join(cfg.homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.writeFileSync(copy, 'refreshed-by-agy');
    prepareBrokerHome(cfg);
    expect(fs.readFileSync(copy, 'utf-8')).toBe('refreshed-by-agy');
    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(root, 'token'), 'new-sign-in');
    fs.utimesSync(path.join(root, 'token'), later, later);
    prepareBrokerHome(cfg);
    expect(fs.readFileSync(copy, 'utf-8')).toBe('new-sign-in');
  });

  it('explains a missing sign-in', () => {
    fs.rmSync(path.join(root, 'token'));
    expect(() => prepareBrokerHome(cfg)).toThrow(/not signed in/);
  });
});

describe('parseAgyOutput', () => {
  it('reads response, usage and denied actions', () => {
    const r = parseAgyOutput(
      JSON.stringify({
        conversation_id: 'c1',
        status: 'SUCCESS',
        response: 'hi',
        duration_seconds: 2.5,
        usage: { input_tokens: 100, output_tokens: 7, thinking_tokens: 3 },
        denied_actions: [{ action: 'read_file' }],
      }),
    );
    expect(r).toEqual({
      status: 'SUCCESS',
      response: 'hi',
      conversationId: 'c1',
      inputTokens: 100,
      outputTokens: 10,
      durationSec: 2.5,
      deniedActions: ['read_file'],
    });
  });

  it('rejects non-JSON output', () => {
    expect(() => parseAgyOutput('Opening authentication page')).toThrow(BrokerError);
  });
});

describe('runAgy', () => {
  it('runs with the isolated HOME, a bare env, the sandbox and the model', async () => {
    const log = path.join(root, 'argv.log');
    cfg.agyBin = fakeAgy(
      `printf '%s\\n' "HOME=$HOME" "PWD=$PWD" "SECRET=$ANTHROPIC_API_KEY" "$@" > '${log}'\necho '{"status":"SUCCESS","response":"ok","usage":{"input_tokens":5}}'`,
    );
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';
    try {
      const work = fs.mkdtempSync(path.join(root, 'work-'));
      const result = await runAgy(cfg, { cwd: work, prompt: 'Question?', model: 'gemini-3.8-flash-high' });
      expect(result.response).toBe('ok');
      const lines = fs.readFileSync(log, 'utf-8').split('\n');
      expect(lines).toContain(`HOME=${cfg.homeDir}`);
      expect(lines).toContain(`PWD=${work}`);
      expect(lines).toContain('SECRET=');
      expect(lines).toEqual(
        expect.arrayContaining([
          '-p',
          'Question?',
          '--sandbox',
          '--disable-slash-commands',
          '--model',
          'gemini-3.8-flash-high',
        ]),
      );
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('turns a sign-in prompt into an actionable error', async () => {
    cfg.agyBin = fakeAgy(`echo 'Please sign in to continue' >&2\nexit 1`);
    await expect(runAgy(cfg, { cwd: root, prompt: 'q', model: 'm' })).rejects.toThrow(/sign-in has expired/);
  });

  it('reports a missing binary', async () => {
    cfg.agyBin = path.join(root, 'nope');
    await expect(runAgy(cfg, { cwd: root, prompt: 'q', model: 'm' })).rejects.toThrow(/not installed/);
  });

  it('kills the child on abort', async () => {
    cfg.agyBin = fakeAgy('sleep 30');
    const controller = new AbortController();
    const run = runAgy(cfg, { cwd: root, prompt: 'q', model: 'm', signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toThrow(/shut down/);
  });
});

describe('pruneConversations', () => {
  it('removes this run and anything older than a day, keeps the rest', () => {
    const conv = path.join(cfg.homeDir, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(conv, { recursive: true });
    for (const n of ['c1.db', 'c2.db', 'old.db']) fs.writeFileSync(path.join(conv, n), 'x');
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(conv, 'old.db'), old, old);
    pruneConversations(cfg, 'c1');
    expect(fs.readdirSync(conv)).toEqual(['c2.db']);
  });
});

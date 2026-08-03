import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareCodexAuthOverride } from './container-runner.js';

const CODEX_AUTH_TARGET = '/home/node/.codex/auth.json';
const OTHER_AUTH_TARGET = '/home/node/.config/example/auth.json';
const testRoots: string[] = [];

function makeTestRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-auth-'));
  testRoots.push(root);
  return root;
}

function writeStub(root: string, name = 'onecli-stub-auth.json'): string {
  const stubPath = path.join(root, name);
  fs.writeFileSync(stubPath, '{"auth_mode":"onecli-managed"}', { mode: 0o600 });
  return stubPath;
}

function rwOverrideSpec(args: string[]): string {
  const suffix = `:${CODEX_AUTH_TARGET}:rw`;
  const spec = args.find((arg) => arg.endsWith(suffix));
  if (!spec) throw new Error('test expected Codex auth override');
  return spec;
}

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('prepareCodexAuthOverride', () => {
  it('overrides only the exact Codex auth target and seeds the OneCLI stub', () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const originalMount = `${sharedStub}:${CODEX_AUTH_TARGET}:ro`;
    const args = ['run', '-v', originalMount];

    const result = prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'));

    expect(result).not.toBeNull();
    expect(fs.readFileSync(result!.authFilePath, 'utf8')).toBe(fs.readFileSync(sharedStub, 'utf8'));
    expect(args).toContain(originalMount);
    expect(rwOverrideSpec(args)).toBe(`${result!.authFilePath}:${CODEX_AUTH_TARGET}:rw`);
  });

  it('leaves non-Codex providers unchanged', () => {
    const root = makeTestRoot();
    const args = ['run', '-v', `${writeStub(root)}:${CODEX_AUTH_TARGET}:ro`];
    const before = [...args];
    const privateRoot = path.join(root, 'private');

    expect(prepareCodexAuthOverride(args, 'claude', privateRoot)).toBeNull();
    expect(args).toEqual(before);
    expect(fs.existsSync(privateRoot)).toBe(false);
  });

  it('does not alter unrelated credential stubs', () => {
    const root = makeTestRoot();
    const codexStub = writeStub(root);
    const otherStub = writeStub(root, 'onecli-stub-other.json');
    const unrelatedMount = `${otherStub}:${OTHER_AUTH_TARGET}:ro`;
    const similarlyNamedMount = `${otherStub}:${CODEX_AUTH_TARGET}.backup:ro`;
    const args = ['run', '-v', unrelatedMount, '-v', similarlyNamedMount, '-v', `${codexStub}:${CODEX_AUTH_TARGET}:ro`];

    prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'));

    expect(args.filter((arg) => arg === unrelatedMount)).toHaveLength(1);
    expect(args.filter((arg) => arg === similarlyNamedMount)).toHaveLength(1);
    expect(args.some((arg) => arg.endsWith(`:${OTHER_AUTH_TARGET}:rw`))).toBe(false);
  });

  it('creates an isolated path for every container preparation', () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const privateRoot = path.join(root, 'private');
    const firstArgs = ['run', '-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`];
    const secondArgs = ['run', '-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`];

    const first = prepareCodexAuthOverride(firstArgs, 'codex', privateRoot)!;
    const second = prepareCodexAuthOverride(secondArgs, 'codex', privateRoot)!;

    expect(first.authFilePath).not.toBe(second.authFilePath);
    expect(first.cleanupDir).not.toBe(second.cleanupDir);
    expect(fs.existsSync(first.authFilePath)).toBe(true);
    expect(fs.existsSync(second.authFilePath)).toBe(true);
  });

  it('sets the private auth file mode to 0600', () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const args = ['run', '-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`];

    const result = prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'))!;

    expect(fs.statSync(result.authFilePath).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['missing', ['run']],
    ['not read-only', ['run', '-v', `/tmp/stub:${CODEX_AUTH_TARGET}:rw`]],
    ['empty host path', ['run', '-v', `:${CODEX_AUTH_TARGET}:ro`]],
  ])('fails closed for a %s expected OneCLI mount', (_case, args) => {
    const root = makeTestRoot();
    expect(() => prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'))).toThrow(
      /Codex (spawn requires|OneCLI stub mount)/,
    );
  });

  it('fails closed when the expected OneCLI mount source is unavailable', () => {
    const root = makeTestRoot();
    const args = ['run', '-v', `${path.join(root, 'missing.json')}:${CODEX_AUTH_TARGET}:ro`];

    expect(() => prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'))).toThrow(
      /Codex OneCLI stub .* is unavailable/,
    );
  });

  it('fails closed when the private per-container location cannot be prepared', () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const blockedRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedRoot, 'blocked');
    const args = ['run', '-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`];

    expect(() => prepareCodexAuthOverride(args, 'codex', blockedRoot)).toThrow(
      /Could not prepare private writable Codex auth file/,
    );
  });

  it("appends the writable override after OneCLI's read-only mount", () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const readOnlyMount = `${sharedStub}:${CODEX_AUTH_TARGET}:ro`;
    const args = ['run', '-v', readOnlyMount, '--network', 'example'];

    prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'));

    expect(args.indexOf(rwOverrideSpec(args))).toBeGreaterThan(args.indexOf(readOnlyMount));
  });
});

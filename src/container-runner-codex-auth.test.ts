import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyOneCLIContainerConfigWithCodexAuth, prepareCodexAuthOverride } from './container-runner.js';

const CODEX_AUTH_TARGET = '/home/node/.codex/auth.json';
const CODEX_AUTH_STAGING_TARGET = '/tmp/onecli-codex-auth-stub.json';
const OTHER_AUTH_TARGET = '/home/node/.config/example/auth.json';
const ONECLI_ARGS_START = 1;
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

function volumeSpecsForTarget(args: string[], target: string): string[] {
  const targetMarker = `:${target}`;
  const specs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-v' || typeof args[i + 1] !== 'string') continue;
    const spec = args[i + 1];
    const targetIndex = spec.lastIndexOf(targetMarker);
    const remainder = targetIndex >= 0 ? spec.slice(targetIndex + targetMarker.length) : null;
    if (remainder === '' || (remainder?.startsWith(':') && !remainder.slice(1).includes(':'))) specs.push(spec);
  }
  return specs;
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

    const result = prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'), ONECLI_ARGS_START);

    expect(result).not.toBeNull();
    expect(fs.readFileSync(result!.authFilePath, 'utf8')).toBe(fs.readFileSync(sharedStub, 'utf8'));
    expect(args).not.toContain(originalMount);
    expect(args).toContain(`${sharedStub}:${CODEX_AUTH_STAGING_TARGET}:ro`);
    expect(rwOverrideSpec(args)).toBe(`${result!.authFilePath}:${CODEX_AUTH_TARGET}:rw`);
    expect(volumeSpecsForTarget(args, CODEX_AUTH_TARGET)).toEqual([`${result!.authFilePath}:${CODEX_AUTH_TARGET}:rw`]);
    expect(volumeSpecsForTarget(args, CODEX_AUTH_STAGING_TARGET)).toEqual([
      `${sharedStub}:${CODEX_AUTH_STAGING_TARGET}:ro`,
    ]);
  });

  it('leaves non-Codex providers unchanged', () => {
    const root = makeTestRoot();
    const args = ['run', '-v', `${writeStub(root)}:${CODEX_AUTH_TARGET}:ro`];
    const before = [...args];
    const privateRoot = path.join(root, 'private');

    expect(prepareCodexAuthOverride(args, 'claude', privateRoot, ONECLI_ARGS_START)).toBeNull();
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

    prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'), ONECLI_ARGS_START);

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

    const first = prepareCodexAuthOverride(firstArgs, 'codex', privateRoot, ONECLI_ARGS_START)!;
    const second = prepareCodexAuthOverride(secondArgs, 'codex', privateRoot, ONECLI_ARGS_START)!;

    expect(first.authFilePath).not.toBe(second.authFilePath);
    expect(first.cleanupDir).not.toBe(second.cleanupDir);
    expect(fs.existsSync(first.authFilePath)).toBe(true);
    expect(fs.existsSync(second.authFilePath)).toBe(true);
  });

  it('sets the private auth file mode to 0600', () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const args = ['run', '-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`];

    const result = prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'), ONECLI_ARGS_START)!;

    expect(fs.statSync(result.authFilePath).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['missing', ['run']],
    ['not read-only', ['run', '-v', `/tmp/stub:${CODEX_AUTH_TARGET}:rw`]],
    ['empty host path', ['run', '-v', `:${CODEX_AUTH_TARGET}:ro`]],
  ])('fails closed for a %s expected OneCLI mount', (_case, args) => {
    const root = makeTestRoot();
    expect(() => prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'), ONECLI_ARGS_START)).toThrow(
      /Codex (spawn requires|OneCLI stub mount)/,
    );
  });

  it('fails closed when the expected OneCLI mount source is unavailable', () => {
    const root = makeTestRoot();
    const args = ['run', '-v', `${path.join(root, 'missing.json')}:${CODEX_AUTH_TARGET}:ro`];

    expect(() => prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'), ONECLI_ARGS_START)).toThrow(
      /Codex OneCLI stub .* is unavailable/,
    );
  });

  it('fails closed when the private per-container location cannot be prepared', () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const blockedRoot = path.join(root, 'not-a-directory');
    fs.writeFileSync(blockedRoot, 'blocked');
    const args = ['run', '-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`];

    expect(() => prepareCodexAuthOverride(args, 'codex', blockedRoot, ONECLI_ARGS_START)).toThrow(
      /Could not prepare private writable Codex auth file/,
    );
  });

  it("appends the writable override after OneCLI's read-only mount", () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const readOnlyMount = `${sharedStub}:${CODEX_AUTH_TARGET}:ro`;
    const args = ['run', '-v', readOnlyMount, '--network', 'example'];

    prepareCodexAuthOverride(args, 'codex', path.join(root, 'private'), ONECLI_ARGS_START);

    const stagingMount = `${sharedStub}:${CODEX_AUTH_STAGING_TARGET}:ro`;
    expect(args).not.toContain(readOnlyMount);
    expect(args.indexOf(rwOverrideSpec(args))).toBeGreaterThan(args.indexOf(stagingMount));
  });

  it('emits production Docker args with one exact auth target and a distinct read-only staging target', async () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const args = ['run', '--rm'];

    const result = await applyOneCLIContainerConfigWithCodexAuth(
      args,
      'codex',
      path.join(root, 'private'),
      async () => {
        args.push('-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`);
        return true;
      },
    );

    expect(volumeSpecsForTarget(args, CODEX_AUTH_TARGET)).toEqual([
      `${result.authOverride!.authFilePath}:${CODEX_AUTH_TARGET}:rw`,
    ]);
    expect(volumeSpecsForTarget(args, CODEX_AUTH_STAGING_TARGET)).toEqual([
      `${sharedStub}:${CODEX_AUTH_STAGING_TARGET}:ro`,
    ]);
    expect(fs.statSync(result.authOverride!.authFilePath).mode & 0o777).toBe(0o600);
  });

  it('rejects an exact-target mount that existed before OneCLI applied its config', async () => {
    const root = makeTestRoot();
    const preexistingStub = writeStub(root, 'preexisting-auth.json');
    const args = ['run', '-v', `${preexistingStub}:${CODEX_AUTH_TARGET}:ro`];

    await expect(
      applyOneCLIContainerConfigWithCodexAuth(args, 'codex', path.join(root, 'private'), async () => true),
    ).rejects.toThrow(/was mounted before OneCLI applied its config/);
  });

  it('serializes genuinely interleaved Codex applies through each private copy', async () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const firstArgs = ['run'];
    const secondArgs = ['run'];
    let releaseFirst!: () => void;
    const firstMayReturn = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWrote!: () => void;
    const firstHasWritten = new Promise<void>((resolve) => {
      firstWrote = resolve;
    });
    let secondEntered = false;

    const firstPromise = applyOneCLIContainerConfigWithCodexAuth(
      firstArgs,
      'codex',
      path.join(root, 'private'),
      async () => {
        fs.writeFileSync(sharedStub, '{"spawn":"first"}', { mode: 0o600 });
        firstArgs.push('-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`);
        firstWrote();
        await firstMayReturn;
        return true;
      },
    );

    await firstHasWritten;
    const secondPromise = applyOneCLIContainerConfigWithCodexAuth(
      secondArgs,
      'codex',
      path.join(root, 'private'),
      async () => {
        secondEntered = true;
        fs.writeFileSync(sharedStub, '{"spawn":"second"}', { mode: 0o600 });
        secondArgs.push('-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`);
        return true;
      },
    );

    await Promise.resolve();
    expect(secondEntered).toBe(false);
    releaseFirst();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(fs.readFileSync(first.authOverride!.authFilePath, 'utf8')).toBe('{"spawn":"first"}');
    expect(fs.readFileSync(second.authOverride!.authFilePath, 'utf8')).toBe('{"spawn":"second"}');
    expect(first.authOverride!.authFilePath).not.toBe(second.authOverride!.authFilePath);
  });

  it('keeps a non-Codex apply from overwriting the shared source before the Codex copy', async () => {
    const root = makeTestRoot();
    const sharedStub = writeStub(root);
    const codexArgs = ['run'];
    const otherArgs = ['run'];
    let releaseCodex!: () => void;
    const codexMayReturn = new Promise<void>((resolve) => {
      releaseCodex = resolve;
    });
    let codexWrote!: () => void;
    const codexHasWritten = new Promise<void>((resolve) => {
      codexWrote = resolve;
    });
    let otherEntered = false;

    const codexPromise = applyOneCLIContainerConfigWithCodexAuth(
      codexArgs,
      'codex',
      path.join(root, 'private'),
      async () => {
        fs.writeFileSync(sharedStub, '{"provider":"codex"}', { mode: 0o600 });
        codexArgs.push('-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`);
        codexWrote();
        await codexMayReturn;
        return true;
      },
    );

    await codexHasWritten;
    const otherPromise = applyOneCLIContainerConfigWithCodexAuth(
      otherArgs,
      'claude',
      path.join(root, 'private'),
      async () => {
        otherEntered = true;
        fs.writeFileSync(sharedStub, '{"provider":"claude"}', { mode: 0o600 });
        otherArgs.push('-v', `${sharedStub}:${CODEX_AUTH_TARGET}:ro`);
        return true;
      },
    );

    await Promise.resolve();
    expect(otherEntered).toBe(false);
    releaseCodex();

    const [codex, other] = await Promise.all([codexPromise, otherPromise]);
    expect(fs.readFileSync(codex.authOverride!.authFilePath, 'utf8')).toBe('{"provider":"codex"}');
    expect(other.authOverride).toBeNull();
    expect(otherEntered).toBe(true);
  });
});

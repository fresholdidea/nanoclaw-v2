/**
 * Host-side ccusage integration.
 *
 * NanoClaw deliberately keeps provider state in per-agent-group/session
 * directories instead of the host user's default CLI directories. This
 * launcher tells ccusage about those directories while retaining ccusage's
 * normal host-wide sources.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

export interface NanoClawUsagePaths {
  claude: string[];
  codex: string[];
  opencode: string[];
  /** Agy mounts the host's Antigravity state into every enabled container. */
  antigravity: string[];
}

export interface ClaudeUsageView {
  configDir: string;
  cleanup: () => void;
}

const SOURCE_ENV = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  opencode: 'OPENCODE_DATA_DIR',
  antigravity: 'ANTIGRAVITY_DATA_DIR',
} as const;

const SOURCE_DEFAULTS = {
  claude: (home: string) => [path.join(home, '.config', 'claude'), path.join(home, '.claude')],
  codex: (home: string) => [path.join(home, '.codex')],
  opencode: (home: string) => [path.join(home, '.local', 'share', 'opencode')],
  antigravity: (home: string) => [path.join(home, '.gemini', 'antigravity-cli')],
} as const;

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function addUnique(target: string[], candidate: string): void {
  if (!target.includes(candidate)) target.push(candidate);
}

/**
 * Find provider data roots in NanoClaw's on-disk session layout.
 *
 * The returned paths are intentionally provider-native roots:
 * - Claude: `.claude-shared/` (contains `projects/`)
 * - Codex: `.codex-shared/` (contains `sessions/`)
 * - OpenCode: `opencode-xdg/opencode/` (contains `storage/`)
 */
export function discoverNanoClawUsagePaths(sessionsRoot: string): NanoClawUsagePaths {
  const result: NanoClawUsagePaths = { claude: [], codex: [], opencode: [], antigravity: [] };
  if (!isDirectory(sessionsRoot)) return result;

  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return result;
    throw error;
  }

  for (const group of groups) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue;
    const groupRoot = path.join(sessionsRoot, group.name);

    const claudeRoot = path.join(groupRoot, '.claude-shared');
    if (isDirectory(path.join(claudeRoot, 'projects'))) addUnique(result.claude, claudeRoot);

    const codexRoot = path.join(groupRoot, '.codex-shared');
    if (isDirectory(path.join(codexRoot, 'sessions'))) addUnique(result.codex, codexRoot);

    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(groupRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const session of sessionEntries) {
      if (!session.isDirectory() || session.name.startsWith('.')) continue;
      const opencodeRoot = path.join(groupRoot, session.name, 'opencode-xdg', 'opencode');
      if (isDirectory(path.join(opencodeRoot, 'storage'))) addUnique(result.opencode, opencodeRoot);
    }
  }

  return result;
}

function walkFiles(root: string, visit: (file: string, relative: string) => void, relativeRoot = root): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const relative = path.relative(relativeRoot, file);
    if (entry.isDirectory()) walkFiles(file, visit, relativeRoot);
    else if (entry.isFile()) visit(file, relative);
  }
}

/**
 * Build a temporary Claude config root containing links to active and rotated
 * NanoClaw transcripts. ccusage intentionally reads `.jsonl` files; Claude's
 * transcript rotation historically renamed old files to `.jsonl.rotated-*`,
 * so the view gives those files a `.jsonl` filename without modifying the
 * source data. Native ccusage builds do not follow symlinks, so regular files
 * are hard-linked into the temporary view instead.
 */
export function createClaudeUsageView(
  claudeRoots: string[],
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ccusage-')),
): ClaudeUsageView | null {
  const projectsDir = path.join(tempRoot, 'projects');
  let linkedFiles = 0;

  try {
    fs.mkdirSync(projectsDir, { recursive: true });
    for (const [rootIndex, claudeRoot] of claudeRoots.entries()) {
      const sourceProjects = path.join(claudeRoot, 'projects');
      if (!isDirectory(sourceProjects)) continue;

      walkFiles(sourceProjects, (sourceFile, relative) => {
        if (!relative.endsWith('.jsonl') && !relative.includes('.jsonl.rotated-')) return;
        const projectName = `nanoclaw-${rootIndex}-${relative.split(path.sep)[0] || 'project'}`;
        const relativeFile = relative.split(path.sep).slice(1).join(path.sep) || path.basename(relative);
        const destination = path.join(
          projectsDir,
          projectName,
          relativeFile.replace(/\.jsonl\.rotated-/, '.rotated-') +
            (relative.includes('.jsonl.rotated-') ? '.jsonl' : ''),
        );
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        try {
          try {
            fs.linkSync(sourceFile, destination);
          } catch (error) {
            // The temporary directory can be on another filesystem (notably
            // in containers). A private copy is safe as a fallback and keeps
            // the source transcript untouched.
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            fs.copyFileSync(sourceFile, destination);
          }
          linkedFiles += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      });
    }

    if (linkedFiles === 0) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return null;
    }

    return {
      configDir: tempRoot,
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function splitConfiguredPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeConfiguredPaths(current: string | undefined, defaults: string[], additions: string[]): string[] {
  const merged: string[] = [];
  const configured = current === undefined ? defaults : splitConfiguredPaths(current);
  for (const candidate of [...configured, ...additions]) addUnique(merged, candidate);
  return merged;
}

/**
 * Add NanoClaw's provider roots to ccusage's source environment variables.
 * Existing values are preserved; when unset, ccusage's documented defaults
 * are retained explicitly because setting an env var would otherwise replace
 * its normal host-wide discovery.
 */
export function buildCcusageEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  usagePaths: NanoClawUsagePaths,
  home = baseEnv.HOME || os.homedir(),
  includeHostDefaults = true,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const sources = [
    ['claude', usagePaths.claude],
    ['codex', usagePaths.codex],
    ['opencode', usagePaths.opencode],
    ['antigravity', usagePaths.antigravity],
  ] as const;

  for (const [source, additions] of sources) {
    const key = SOURCE_ENV[source];
    if (!includeHostDefaults) {
      env[key] = additions.join(',');
      continue;
    }
    if (additions.length === 0) continue;
    env[key] = mergeConfiguredPaths(baseEnv[key], SOURCE_DEFAULTS[source](home), additions).join(',');
  }

  return env;
}

function resolveCcusageBinary(projectRoot: string): string {
  const explicit = process.env.CCUSAGE_BIN?.trim();
  if (explicit) return explicit;

  const wrapperPath = path.resolve(projectRoot, 'bin', 'ccusage');
  let wrapperRealPath: string | null = null;
  try {
    wrapperRealPath = fs.realpathSync(wrapperPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, process.platform === 'win32' ? 'ccusage.exe' : 'ccusage');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const candidateRealPath = fs.realpathSync(candidate);
      if (path.resolve(candidate) === wrapperPath || candidateRealPath === wrapperRealPath) continue;
      return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }

  throw new Error('ccusage was not found on PATH. Install ccusage or set CCUSAGE_BIN to its executable path.');
}

function runCcusage(args: string[], projectRoot: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCcusageBinary(projectRoot), args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

export async function main(
  argv = process.argv.slice(2),
  projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
): Promise<number> {
  const nanoClawOnly = argv[0] === 'nanoclaw';
  const ccusageArgs = nanoClawOnly ? argv.slice(1) : argv;
  const sessionsRoot = path.join(projectRoot, 'data', 'v2-sessions');
  const usagePaths = discoverNanoClawUsagePaths(sessionsRoot);
  const hostAgyRoot = path.join(os.homedir(), '.gemini', 'antigravity-cli');
  if (isDirectory(hostAgyRoot)) usagePaths.antigravity.push(hostAgyRoot);
  const claudeView = createClaudeUsageView(usagePaths.claude);
  const envUsagePaths = claudeView ? { ...usagePaths, claude: [claudeView.configDir] } : usagePaths;
  const isolatedHome = nanoClawOnly ? fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ccusage-home-')) : null;
  const baseEnv = isolatedHome ? { ...process.env, HOME: isolatedHome } : process.env;
  const env = buildCcusageEnvironment(baseEnv, envUsagePaths, isolatedHome || baseEnv.HOME, !nanoClawOnly);

  try {
    return await runCcusage(ccusageArgs, projectRoot, env);
  } finally {
    claudeView?.cleanup();
    if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`nanoclaw ccusage: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

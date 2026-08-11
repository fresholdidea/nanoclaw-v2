/**
 * Mount smoke test.
 *
 * Tier 1 (config): resolve each group's additional_mounts through the real
 *   validateAdditionalMounts, so allowlist rejections and the silent
 *   omitted-`readonly`/RW-downgrade traps surface as explicit RO.
 * Tier 2 (container, --probe): spin the group's real image with the real
 *   `-v` args and `--user` mapping and actually attempt a write. Catches
 *   `:ro` bugs, host file ownership, and Docker file-sharing failures that
 *   config inspection cannot see.
 *
 * Usage:
 *   pnpm exec tsx scripts/smoke-mounts.ts                 # all groups, config only
 *   pnpm exec tsx scripts/smoke-mounts.ts --probe         # + container write probe
 *   pnpm exec tsx scripts/smoke-mounts.ts --group <id> --probe
 *
 * Exit code is non-zero if any mount's real behavior disagrees with its
 * configured intent, so this can gate a deploy.
 */
import { execFileSync } from 'node:child_process';

import { CONTAINER_IMAGE } from '../src/config.js';
import { getContainerConfig } from '../src/db/container-configs.js';
import { initDb, getDb } from '../src/db/connection.js';
import { CONTAINER_RUNTIME_BIN, readonlyMountArgs } from '../src/container-runtime.js';
import { validateAdditionalMounts } from '../src/modules/mount-security/index.js';

const PROBE = process.argv.includes('--probe');
const groupArg = process.argv.indexOf('--group');
const onlyGroup = groupArg !== -1 ? process.argv[groupArg + 1] : null;
// Same fallback the runner uses at container-runner.ts:569 — the slug-based
// default, never the stale legacy `nanoclaw-agent:latest`.
const DEFAULT_IMAGE = CONTAINER_IMAGE;

initDb('data/v2.db');

type Row = { id: string; name: string };
const groups = (
  getDb()
    .prepare(`SELECT id, name FROM agent_groups ${onlyGroup ? 'WHERE id = ?' : ''} ORDER BY name`)
    .all(...(onlyGroup ? [onlyGroup] : [])) as Row[]
);

/** The runner stores additional_mounts as raw JSON text, not a parsed array. */
function readMounts(groupId: string): { mounts: unknown[]; imageTag: string } {
  const cfg = getContainerConfig(groupId) as any;
  const raw = cfg?.additional_mounts ?? [];
  const mounts = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { mounts: Array.isArray(mounts) ? mounts : [], imageTag: cfg?.imageTag ?? DEFAULT_IMAGE };
}

/**
 * Attempt a real write at each container path. Bypasses the image entrypoint,
 * which otherwise swallows the command. Emits `<path>\t<OK|DENIED>` per mount.
 */
function probe(imageTag: string, resolved: { hostPath: string; containerPath: string; readonly: boolean }[]) {
  const args = ['run', '--rm', '--entrypoint', 'sh'];
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid != null && uid !== 0 && uid !== 1000) args.push('--user', `${uid}:${gid}`, '-e', 'HOME=/home/node');
  for (const m of resolved) {
    if (m.readonly) args.push(...readonlyMountArgs(m.hostPath, m.containerPath));
    else args.push('-v', `${m.hostPath}:${m.containerPath}`);
  }
  // A probe file is created and removed inside the mount; name is unique per run.
  const script = resolved
    .map(
      (m) =>
        `p="${m.containerPath}/.nc-mount-probe.$$"; ` +
        `if [ -d "${m.containerPath}" ] && touch "$p" 2>/dev/null; ` +
        `then echo "${m.containerPath}\tOK"; rm -f "$p"; ` +
        `else echo "${m.containerPath}\tDENIED"; fi`,
    )
    .join('; ');
  args.push(imageTag, '-c', script);

  const out = execFileSync(CONTAINER_RUNTIME_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const seen = new Map<string, string>();
  for (const line of out.trim().split('\n')) {
    const [p, verdict] = line.split('\t');
    if (p && verdict) seen.set(p.trim(), verdict.trim());
  }
  return seen;
}

let failures = 0;
let checked = 0;

for (const g of groups) {
  const { mounts, imageTag } = readMounts(g.id);
  if (mounts.length === 0) continue;

  const resolved = validateAdditionalMounts(mounts) as {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }[];

  // A mount present in config but absent from the resolved set was rejected
  // outright (missing path, or outside every allowed root).
  const dropped = mounts.filter(
    (m: any) => !resolved.some((r) => r.containerPath.endsWith('/' + m.containerPath)),
  );

  console.log(`\n=== ${g.name}  (${g.id})  image=${imageTag}`);
  for (const d of dropped as any[]) {
    console.log(`  DROPPED  ${d.hostPath} -> ${d.containerPath}  (rejected by allowlist)`);
    failures++;
  }

  let probed: Map<string, string> | null = null;
  if (PROBE && resolved.length > 0) {
    try {
      probed = probe(imageTag, resolved);
    } catch (err: any) {
      console.log(`  PROBE FAILED: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
      failures++;
    }
  }

  for (const m of resolved) {
    checked++;
    const intent = m.readonly ? 'RO' : 'RW';
    if (!probed) {
      console.log(`  ${intent}       ${m.containerPath}  <- ${m.hostPath}`);
      continue;
    }
    const verdict = probed.get(m.containerPath) ?? 'MISSING';
    const writable = verdict === 'OK';
    const agrees = writable === !m.readonly;
    if (!agrees) failures++;
    console.log(
      `  ${agrees ? 'PASS' : 'FAIL'} ${intent}  ${m.containerPath}  ` +
        `(write ${verdict})  <- ${m.hostPath}`,
    );
  }
}

console.log(
  `\n${checked} mount(s) checked${PROBE ? ' with container write probe' : ' (config only; pass --probe for a real write test)'}. ` +
    `${failures} problem(s).`,
);
process.exit(failures > 0 ? 1 : 0);

#!/usr/bin/env tsx
/**
 * Rebuild one or more per-agent-group container images.
 *
 * Use when the base image (nanoclaw-agent:latest) has gained a runtime dep
 * (e.g. a new SDK in container/agent-runner/package.json) that pre-existing
 * per-agent images don't have baked into node_modules. The system has no
 * automatic drift detection between agent-runner package.json and per-agent
 * image contents — this script is the manual reconciler.
 *
 * The actual rebuild reuses buildAgentGroupImage() in container-runner.ts —
 * the same path src/modules/self-mod/apply.ts hits after install_packages.
 *
 * Usage:
 *   pnpm exec tsx scripts/rebuild-agent-image.ts <agentGroupId> [...]
 *   pnpm exec tsx scripts/rebuild-agent-image.ts --all-customized
 *
 * --all-customized walks groups/<folder>/container.json and rebuilds every
 * group whose imageTag is not the default base tag.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { readContainerConfig, writeContainerConfig } from '../src/container-config.js';
import { buildAgentGroupImage } from '../src/container-runner.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from '../src/container-runtime.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';

function imageCreatedAt(tag: string): string {
  try {
    return execSync(`${CONTAINER_RUNTIME_BIN} inspect --format '{{.Created}}' ${tag}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '(no such image)';
  }
}

function imageHas(tag: string, relPath: string): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} run --rm --entrypoint /bin/sh ${tag} -c 'test -e ${relPath}'`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function stopGroupContainers(folder: string): string[] {
  const stopped: string[] = [];
  try {
    const names = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter "name=nanoclaw-v2-${folder}-" --format "{{.Names}}"`,
      { encoding: 'utf-8' },
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of names) {
      try {
        stopContainer(name);
        stopped.push(name);
      } catch (err) {
        console.error(`  warn: failed to stop ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    /* no running containers — fine */
  }
  return stopped;
}

function resolveIds(args: string[]): string[] {
  if (args.includes('--all-customized')) {
    const ids: string[] = [];
    for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(GROUPS_DIR, entry.name, 'container.json');
      if (!fs.existsSync(cfgPath)) continue;
      let cfg: { imageTag?: string; agentGroupId?: string };
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      } catch {
        continue;
      }
      if (cfg.imageTag && cfg.imageTag !== CONTAINER_IMAGE && cfg.agentGroupId) {
        ids.push(cfg.agentGroupId);
      }
    }
    return ids;
  }
  return args.filter((a) => !a.startsWith('--'));
}

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  const ids = resolveIds(process.argv.slice(2));
  if (ids.length === 0) {
    console.error('Usage: tsx scripts/rebuild-agent-image.ts <agentGroupId> [...] | --all-customized');
    process.exit(1);
  }

  const results: { id: string; folder: string; ok: boolean; before: string; after: string; err?: string }[] = [];

  for (const id of ids) {
    const group = getAgentGroup(id);
    if (!group) {
      results.push({ id, folder: '?', ok: false, before: '-', after: '-', err: 'agent group not found' });
      continue;
    }
    const cfg = readContainerConfig(group.folder);
    const tag = cfg.imageTag || CONTAINER_IMAGE;
    const before = imageCreatedAt(tag);

    console.log(`\n=== ${group.name} (${id}) — folder=${group.folder} ===`);
    console.log(`  current tag: ${tag}`);
    console.log(`  built:       ${before}`);

    const stopped = stopGroupContainers(group.folder);
    if (stopped.length > 0) console.log(`  stopped containers: ${stopped.join(', ')}`);

    // No packages → per-agent image adds nothing over base. Reset imageTag
    // to base so the next session uses :latest directly. buildAgentGroupImage
    // would throw 'No packages to install' here.
    const hasPackages = cfg.packages.apt.length > 0 || cfg.packages.npm.length > 0;
    if (!hasPackages) {
      console.log(`  no apt/npm packages — resetting imageTag to ${CONTAINER_IMAGE}`);
      cfg.imageTag = CONTAINER_IMAGE;
      writeContainerConfig(group.folder, cfg);
      const after = imageCreatedAt(CONTAINER_IMAGE);
      const hasOpencode = imageHas(CONTAINER_IMAGE, '/app/node_modules/@opencode-ai/sdk');
      console.log(`  now using:   ${CONTAINER_IMAGE}`);
      console.log(`  built:       ${after}`);
      console.log(`  @opencode-ai/sdk present: ${hasOpencode ? 'yes' : 'NO'}`);
      results.push({ id, folder: group.folder, ok: true, before, after });
      continue;
    }

    try {
      await buildAgentGroupImage(id);
      const after = imageCreatedAt(tag);
      const hasOpencode = imageHas(tag, '/app/node_modules/@opencode-ai/sdk');
      console.log(`  rebuilt:     ${after}`);
      console.log(`  @opencode-ai/sdk present: ${hasOpencode ? 'yes' : 'NO'}`);
      results.push({ id, folder: group.folder, ok: true, before, after });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}`);
      results.push({ id, folder: group.folder, ok: false, before, after: '-', err: msg });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    const status = r.ok ? 'OK ' : 'ERR';
    console.log(`  ${status}  ${r.id}  (${r.folder})  ${r.ok ? r.after : r.err}`);
  }

  const anyFail = results.some((r) => !r.ok);
  process.exit(anyFail ? 1 : 0);
}

await main();

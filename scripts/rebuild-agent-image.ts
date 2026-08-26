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

import { CONTAINER_IMAGE, DATA_DIR, INSTALL_SLUG } from '../src/config.js';
import { configFromDb } from '../src/container-config.js';
import { buildAgentGroupImage } from '../src/container-runner.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  getContainerConfig,
  getAllContainerConfigs,
  updateContainerConfigScalars,
} from '../src/db/container-configs.js';
import { getSessionDriver } from '../src/drivers/index.js';

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

async function stopGroupContainers(agentGroupId: string): Promise<string[]> {
  const stopped: string[] = [];
  try {
    const snapshots = await getSessionDriver().listSessions(INSTALL_SLUG);
    for (const { handle } of snapshots.filter(({ handle }) => handle.key.agentGroupId === agentGroupId)) {
      try {
        await handle.stop('operator-image-rebuild');
        stopped.push(handle.name);
      } catch (err) {
        console.error(`  warn: failed to stop ${handle.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    /* no running containers — fine */
  }
  return stopped;
}

async function resolveIds(args: string[]): Promise<string[]> {
  if (args.includes('--all-customized')) {
    const configs = await getAllContainerConfigs();
    return configs.filter((c) => c.image_tag && c.image_tag !== CONTAINER_IMAGE).map((c) => c.agent_group_id);
  }
  return args.filter((a) => !a.startsWith('--'));
}

async function main(): Promise<void> {
  await initDb(path.join(DATA_DIR, 'v2.db'), { role: 'tool' });
  const ids = await resolveIds(process.argv.slice(2));
  if (ids.length === 0) {
    console.error('Usage: tsx scripts/rebuild-agent-image.ts <agentGroupId> [...] | --all-customized');
    process.exit(1);
  }

  const results: { id: string; folder: string; ok: boolean; before: string; after: string; err?: string }[] = [];

  for (const id of ids) {
    const group = await getAgentGroup(id);
    if (!group) {
      results.push({ id, folder: '?', ok: false, before: '-', after: '-', err: 'agent group not found' });
      continue;
    }
    const row = await getContainerConfig(id);
    if (!row) {
      results.push({ id, folder: group.folder, ok: false, before: '-', after: '-', err: 'container config not found' });
      continue;
    }
    const cfg = configFromDb(row, group);
    const tag = cfg.imageTag || CONTAINER_IMAGE;
    const before = imageCreatedAt(tag);

    console.log(`\n=== ${group.name} (${id}) — folder=${group.folder} ===`);
    console.log(`  current tag: ${tag}`);
    console.log(`  built:       ${before}`);

    const stopped = await stopGroupContainers(id);
    if (stopped.length > 0) console.log(`  stopped containers: ${stopped.join(', ')}`);

    // No packages → per-agent image adds nothing over base. Reset imageTag
    // to base so the next session uses :latest directly. buildAgentGroupImage
    // would throw 'No packages to install' here.
    const hasPackages = cfg.packages.apt.length > 0 || cfg.packages.npm.length > 0;
    if (!hasPackages) {
      console.log(`  no apt/npm packages — resetting imageTag to ${CONTAINER_IMAGE}`);
      await updateContainerConfigScalars(id, { image_tag: null });
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

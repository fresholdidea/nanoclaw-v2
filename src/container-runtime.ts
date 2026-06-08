/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Two passes:
 *   1. Containers labelled `nanoclaw-install=<our-slug>` — definitely ours.
 *   2. Containers named `nanoclaw-v2-*` with NO `nanoclaw-install` label —
 *      pre-fix zombies from before the label-stamping code shipped. A peer
 *      install's containers carry a DIFFERENT slug, not an absent label, so
 *      this pass cannot misfire across installs. Remove this pass once it has
 *      been in the tree long enough that no unlabelled zombies remain on
 *      anyone's machine.
 *
 * Stamp side: container-runner.ts adds `--label CONTAINER_INSTALL_LABEL` on
 * every spawn — pass 1 is the steady-state path.
 */
export function cleanupOrphans(): void {
  const reap = (name: string): void => {
    try {
      stopContainer(name);
    } catch {
      /* already stopped */
    }
  };

  try {
    const labelled = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const name of labelled) reap(name);
    if (labelled.length > 0) {
      log.info('Stopped orphaned containers (label match)', { count: labelled.length, names: labelled });
    }
  } catch (err) {
    log.warn('Failed to clean up labelled orphan containers', { err });
  }

  try {
    const unlabelled = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=^nanoclaw-v2- --format '{{.Names}}\t{{.Label "nanoclaw-install"}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([, label]) => !label) // only unlabelled ones
      .map(([name]) => name);
    for (const name of unlabelled) reap(name);
    if (unlabelled.length > 0) {
      log.info('Stopped orphaned containers (pre-label-fix migration)', {
        count: unlabelled.length,
        names: unlabelled,
      });
    }
  } catch (err) {
    log.warn('Failed to clean up unlabelled pre-fix orphan containers', { err });
  }
}

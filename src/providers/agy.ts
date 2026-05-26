/**
 * Host-side container config for the `agy` provider.
 *
 * Agy reads OAuth credentials from `~/.gemini/oauth_creds.json` and writes
 * CLI data (cache, brain, mcp_config) under `~/.gemini/antigravity-cli/`.
 * The desktop app uses `~/.gemini/antigravity/` — we mount the parent so
 * both are available, but only the `-cli` paths matter to the provider.
 *
 * The Linux binary is bind-mounted because we don't bake agy into the image —
 * users who never enable agy shouldn't carry the binary in their image.
 *
 * Real secrets never enter the container in env vars; the OAuth token file
 * is the auth surface, mounted from the host.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

// Candidate paths for the Linux agy binary, in priority order.
// The binary inside the tarball is named `antigravity`, not `agy`.
// `/add-agy` installs to `antigravity-linux-<arch>`. Override via AGY_LINUX_BIN.
const DEFAULT_AGY_LINUX_BIN_CANDIDATES = [
  path.join(os.homedir(), '.local/bin/antigravity-linux-arm64'),
  path.join(os.homedir(), '.local/bin/antigravity-linux-amd64'),
];
const DEFAULT_GEMINI_DIR = path.join(os.homedir(), '.gemini');

function resolveAgyBin(envOverride?: string): string | null {
  if (envOverride) return fs.existsSync(envOverride) ? envOverride : null;
  for (const candidate of DEFAULT_AGY_LINUX_BIN_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

registerProviderContainerConfig('agy', (ctx) => {
  const agyBin = resolveAgyBin(ctx.hostEnv.AGY_LINUX_BIN);
  const geminiDir = ctx.hostEnv.AGY_GEMINI_DIR || DEFAULT_GEMINI_DIR;

  if (!agyBin) {
    throw new Error(
      `agy provider: Linux binary not found. Tried: ${DEFAULT_AGY_LINUX_BIN_CANDIDATES.join(', ')}. ` +
        `Set AGY_LINUX_BIN in the host env or download per docs/superpowers/specs/2026-05-25-agy-provider-design.md.`,
    );
  }
  if (!fs.existsSync(geminiDir)) {
    throw new Error(
      `agy provider: ${geminiDir} not found. Run \`agy\` on the host once to initialize and complete Google OAuth.`,
    );
  }

  return {
    mounts: [
      { hostPath: agyBin, containerPath: '/usr/local/bin/agy', readonly: true },
      { hostPath: geminiDir, containerPath: '/home/node/.gemini', readonly: false },
    ],
    env: {
      AGY_BIN: '/usr/local/bin/agy',
      AGY_CLI_DATA_DIR: '/home/node/.gemini/antigravity-cli',
      AGY_MCP_CONFIG_PATH: '/home/node/.gemini/antigravity-cli/mcp_config.json',
      AGY_LAST_CONVS_PATH: '/home/node/.gemini/antigravity-cli/cache/last_conversations.json',
    },
  };
});

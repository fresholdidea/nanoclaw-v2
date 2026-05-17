/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const OPENCODE_ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
] as const;

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  // The host doesn't auto-load .env into process.env (see src/env.ts), so we
  // read OPENCODE_* + ANTHROPIC_BASE_URL explicitly here. process.env still
  // wins if a value is also exported there (launchd plist, shell, etc.).
  const fileEnv = readEnvFile([...OPENCODE_ENV_KEYS]);
  for (const key of OPENCODE_ENV_KEYS) {
    const value = ctx.hostEnv[key] ?? fileEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});

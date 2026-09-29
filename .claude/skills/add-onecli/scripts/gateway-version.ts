/**
 * Never downgrade the OneCLI gateway (fork-local guard; setup.ts only calls it
 * from the ONECLI_GATEWAY_VERSION initializer).
 *
 * The skill's versions.json "onecli-gateway" pin is what a fresh install gets,
 * but ~/.onecli/.env may already record a newer ONECLI_VERSION — a gateway
 * upgraded out of band per docs/onecli-upgrades.md. setup.ts re-runs the
 * upstream installer whenever its reuse probe fails (e.g. the gateway was down
 * at that moment), and must then reinstall that version rather than the older
 * pin: OneCLI 1.41.0–1.43.0 cannot refresh ChatGPT/Codex OAuth credentials.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from '../../../../src/log.js';

// The value ends up in `image: ghcr.io/onecli/onecli:${ONECLI_VERSION}` and in
// the installer's shell command, so only a plain image tag is passed through.
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export interface GatewayVersionChoice {
  version: string;
  notice?: { level: 'info' | 'warn'; message: string };
}

/** Numeric MAJOR.MINOR.PATCH order (leading "v" allowed); null for "latest", partial, or pre-release tags. */
export function compareGatewayVersions(a: string, b: string): number | null {
  const x = RELEASE.exec(a);
  const y = RELEASE.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** A value as docker compose reads it: surrounding quotes removed, an unquoted ` # comment` dropped. */
function composeValue(raw: string): string {
  const value = raw.trim();
  const quoted = /^(['"])(.*?)\1/.exec(value);
  return (quoted ? quoted[2] : value.replace(/\s#.*$/, '')).trim();
}

/**
 * The gateway version a fresh install may use. `existing` is the raw
 * ONECLI_VERSION from ~/.onecli/.env ('' when unset; undefined when there is
 * no such file). The pin wins only over an older or equal release; a newer
 * one — or a tag that can't be compared, like "latest" — is kept, because
 * replacing it with the pin could be a downgrade.
 */
export function effectiveGatewayVersion(pin: string, existing: string | undefined): GatewayVersionChoice {
  if (existing === undefined) return { version: pin };
  // Unset or empty means the compose file's `${ONECLI_VERSION:-latest}` default.
  const current = composeValue(existing) || 'latest';
  if (!IMAGE_TAG.test(current)) {
    return {
      version: pin,
      notice: { level: 'warn', message: `Ignoring unusable ONECLI_VERSION in ~/.onecli/.env; using the ${pin} pin.` },
    };
  }
  const order = compareGatewayVersions(current, pin);
  if (order !== null && order <= 0) return { version: pin };
  const why = order === null ? `not comparable with the ${pin} pin` : `newer than the ${pin} pin`;
  return {
    version: current,
    notice: {
      level: order === null ? 'warn' : 'info',
      message: `Keeping OneCLI gateway ${current} from ~/.onecli/.env (${why}); setup never downgrades it.`,
    },
  };
}

/** Raw ONECLI_VERSION as compose reads the env file (last definition wins): '' if unset, undefined if no file. */
export function readOnecliEnvVersion(envFile = path.join(os.homedir(), '.onecli', '.env')): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf8');
  } catch {
    return undefined;
  }
  return [...content.matchAll(/^[ \t]*(?:export[ \t]+)?ONECLI_VERSION[ \t]*=(.*)$/gm)].at(-1)?.[1] ?? '';
}

/** effectiveGatewayVersion() for this host, logging whenever the result departs from the pin. */
export function gatewayVersionForInstall(pin: string, envFile?: string): string {
  const choice = effectiveGatewayVersion(pin, readOnecliEnvVersion(envFile));
  if (choice.notice) log[choice.notice.level](choice.notice.message);
  return choice.version;
}

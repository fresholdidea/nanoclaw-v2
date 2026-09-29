import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../../../src/log.js';
import {
  compareGatewayVersions,
  effectiveGatewayVersion,
  gatewayVersionForInstall,
  readOnecliEnvVersion,
} from './gateway-version.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A stand-in for ~/.onecli/.env; without content the file does not exist. */
function envFile(content?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-gateway-version-'));
  roots.push(root);
  const file = path.join(root, '.env');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

describe('OneCLI gateway never-downgrade guard', () => {
  it('orders exact releases numerically and declines to order anything else', () => {
    expect(compareGatewayVersions('1.45.0', '1.41.0')).toBe(1);
    expect(compareGatewayVersions('1.9.0', '1.41.0')).toBe(-1);
    expect(compareGatewayVersions('v1.41.0', '1.41.0')).toBe(0);
    for (const tag of ['latest', '1.45', '1.46.0-rc.1', '']) expect(compareGatewayVersions(tag, '1.41.0')).toBeNull();
  });

  it('uses the pin on a fresh machine and over an older or equal release', () => {
    for (const existing of [undefined, '1.36.0', '1.41.0', 'v1.41.0']) {
      expect(effectiveGatewayVersion('1.41.0', existing)).toEqual({ version: '1.41.0' });
    }
  });

  it('keeps a newer gateway instead of downgrading it to the pin', () => {
    expect(effectiveGatewayVersion('1.41.0', '1.45.0')).toEqual({
      version: '1.45.0',
      notice: { level: 'info', message: expect.stringContaining('never downgrades') },
    });
    expect(effectiveGatewayVersion('1.41.0', '"1.43.1" # upgraded for Codex').version).toBe('1.43.1');
    expect(effectiveGatewayVersion('1.41.0', '1.45.0 # upgraded').version).toBe('1.45.0');
  });

  it('keeps a tag it cannot order, including the unset compose default', () => {
    for (const tag of ['latest', '1.45', '1.46.0-rc.1']) {
      expect(effectiveGatewayVersion('1.41.0', tag)).toMatchObject({ version: tag, notice: { level: 'warn' } });
    }
    expect(effectiveGatewayVersion('1.41.0', '')).toMatchObject({ version: 'latest', notice: { level: 'warn' } });
  });

  it('never hands an unusable value to the installer shell', () => {
    expect(effectiveGatewayVersion('1.41.0', '1.45.0; rm -rf ~')).toMatchObject({
      version: '1.41.0',
      notice: { level: 'warn' },
    });
  });

  it('reads ONECLI_VERSION the way compose does', () => {
    expect(readOnecliEnvVersion(envFile())).toBeUndefined();
    expect(readOnecliEnvVersion(envFile('ONECLI_BIND_HOST=127.0.0.1\n'))).toBe('');
    const env = '# ONECLI_VERSION=9.9.9\nONECLI_VERSION=1.41.0\nexport ONECLI_VERSION=1.45.0\n';
    expect(readOnecliEnvVersion(envFile(env))).toBe('1.45.0');
  });

  it('reports when setup keeps a newer gateway and stays quiet otherwise', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    expect(gatewayVersionForInstall('1.41.0', envFile('ONECLI_VERSION=1.45.0\n'))).toBe('1.45.0');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Keeping OneCLI gateway 1.45.0'));
    expect(gatewayVersionForInstall('1.41.0', envFile())).toBe('1.41.0');
    expect(info).toHaveBeenCalledTimes(1);
  });

  // Tripwire: fails if an upstream merge rewires setup.ts around the guard.
  it('is the only way setup.ts reads the gateway pin, for both the installer and ~/.onecli/.env', () => {
    const setup = fs.readFileSync(new URL('./setup.ts', import.meta.url), 'utf8');
    expect(setup.split("pins['onecli-gateway']")).toHaveLength(2);
    expect(setup).toContain("const ONECLI_GATEWAY_VERSION = gatewayVersionForInstall(pins['onecli-gateway']);");
    expect(setup).toContain('export ONECLI_VERSION=${ONECLI_GATEWAY_VERSION} && curl');
    expect(setup).toContain("writeEnvVar('ONECLI_VERSION', ONECLI_GATEWAY_VERSION, onecliEnv)");
  });
});

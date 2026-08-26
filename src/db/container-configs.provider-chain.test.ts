/**
 * provider_chain column on container_configs (migration 021).
 *
 * Verifies that:
 *   1. provider_chain round-trips: a string[] set via updateContainerConfig
 *      is stored as a JSON string and returned as-is by getContainerConfig.
 *   2. Passing null clears the column back to NULL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfig } from './container-configs.js';

async function makeGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

describe('provider_chain column', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('round-trips a provider chain', async () => {
    await makeGroup('ag-test');
    await ensureContainerConfig('ag-test');
    await updateContainerConfig('ag-test', { providerChain: ['claude', 'codex', 'opencode'] });
    expect((await getContainerConfig('ag-test'))?.provider_chain).toBe(JSON.stringify(['claude', 'codex', 'opencode']));
  });

  it('stores null when chain is cleared', async () => {
    await makeGroup('ag-clear');
    await ensureContainerConfig('ag-clear');
    await updateContainerConfig('ag-clear', { providerChain: ['claude', 'codex'] });
    await updateContainerConfig('ag-clear', { providerChain: null });
    expect((await getContainerConfig('ag-clear'))?.provider_chain).toBeNull();
  });

  it('leaves provider_chain untouched when updates object is empty', async () => {
    await makeGroup('ag-noop');
    await ensureContainerConfig('ag-noop');
    await updateContainerConfig('ag-noop', { providerChain: ['claude'] });
    await updateContainerConfig('ag-noop', {});
    expect((await getContainerConfig('ag-noop'))?.provider_chain).toBe(JSON.stringify(['claude']));
  });
});

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

function makeGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

describe('provider_chain column', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('round-trips a provider chain', () => {
    makeGroup('ag-test');
    ensureContainerConfig('ag-test');
    updateContainerConfig('ag-test', { providerChain: ['claude', 'codex', 'opencode'] });
    expect(getContainerConfig('ag-test')?.provider_chain).toBe(JSON.stringify(['claude', 'codex', 'opencode']));
  });

  it('stores null when chain is cleared', () => {
    makeGroup('ag-clear');
    ensureContainerConfig('ag-clear');
    updateContainerConfig('ag-clear', { providerChain: ['claude', 'codex'] });
    updateContainerConfig('ag-clear', { providerChain: null });
    expect(getContainerConfig('ag-clear')?.provider_chain).toBeNull();
  });

  it('leaves provider_chain untouched when updates object is empty', () => {
    makeGroup('ag-noop');
    ensureContainerConfig('ag-noop');
    updateContainerConfig('ag-noop', { providerChain: ['claude'] });
    updateContainerConfig('ag-noop', {});
    expect(getContainerConfig('ag-noop')?.provider_chain).toBe(JSON.stringify(['claude']));
  });
});

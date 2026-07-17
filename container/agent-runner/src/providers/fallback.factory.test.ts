import { test, expect } from 'bun:test';
// Register mock provider so createProvider('mock') works without real SDK deps.
import './mock.js';
import { buildProvider } from './build-provider.js';
import type { RunnerConfig } from '../config.js';

const base: RunnerConfig = {
  provider: 'mock', assistantName: '', groupName: '', agentGroupId: '',
  maxMessagesPerPrompt: 10, mcpServers: {},
};

test('single provider when no chain', () => {
  const p = buildProvider({ ...base }, {});
  expect(p.constructor.name).not.toBe('FallbackProvider');
});

test('FallbackProvider when chain length > 1', () => {
  const p = buildProvider({ ...base, providerChain: ['mock', 'mock', 'mock'] }, {});
  expect(p.constructor.name).toBe('FallbackProvider');
});

import { describe, it, expect } from 'vitest';
import { resolveProviderChain, DEFAULT_PROVIDER_CHAIN } from './container-config.js';

describe('resolveProviderChain', () => {
  it('claude with no override → default chain', () => {
    expect(resolveProviderChain('claude', null)).toEqual(DEFAULT_PROVIDER_CHAIN);
  });
  it('non-claude with no override → single provider', () => {
    expect(resolveProviderChain('opencode', null)).toEqual(['opencode']);
  });
  it('explicit override used verbatim', () => {
    expect(resolveProviderChain('claude', JSON.stringify(['claude', 'opencode']))).toEqual(['claude', 'opencode']);
  });
  it('opt out via single-element chain', () => {
    expect(resolveProviderChain('claude', JSON.stringify(['claude']))).toEqual(['claude']);
  });
  it('primary mismatch is corrected by prepending', () => {
    expect(resolveProviderChain('claude', JSON.stringify(['codex', 'opencode']))).toEqual([
      'claude',
      'codex',
      'opencode',
    ]);
  });
  it('undefined provider defaults to claude chain', () => {
    expect(resolveProviderChain(undefined, null)).toEqual(DEFAULT_PROVIDER_CHAIN);
  });
});

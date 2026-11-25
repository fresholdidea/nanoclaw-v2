import { describe, expect, it } from 'vitest';

import { parseStoredProviderChain, resolveProviderChain, resolveProviderFallbacks } from './provider-chain.js';

describe('resolveProviderChain', () => {
  it('defaults Codex groups to a Claude fallback', () => {
    expect(resolveProviderChain('codex', null)).toEqual(['codex', 'claude']);
    expect(resolveProviderFallbacks('codex', undefined)).toEqual(['claude']);
  });

  it('gives other providers no fallback by default', () => {
    expect(resolveProviderChain('claude', null)).toEqual(['claude']);
    expect(resolveProviderChain('opencode', null)).toEqual(['opencode']);
  });

  it('honors an explicit chain and the no-fallback opt-out', () => {
    expect(resolveProviderChain('codex', '["codex","claude"]')).toEqual(['codex', 'claude']);
    expect(resolveProviderChain('codex', '["codex"]')).toEqual(['codex']);
    expect(resolveProviderChain('claude', '["claude","codex"]')).toEqual(['claude', 'codex']);
  });

  it('ignores a stored chain written for another provider (pre-rebuild rows)', () => {
    // repo-librarian and meetings still hold this on the live DB, with provider codex.
    expect(resolveProviderChain('codex', '["claude","codex","opencode"]')).toEqual(['codex', 'claude']);
  });

  it('ignores malformed values and de-duplicates', () => {
    expect(resolveProviderChain('codex', 'not json')).toEqual(['codex', 'claude']);
    expect(resolveProviderChain('codex', '[1,2]')).toEqual(['codex', 'claude']);
    expect(resolveProviderChain('codex', '["codex","claude","claude","codex"]')).toEqual(['codex', 'claude']);
  });

  it('drops fallbacks this host does not know', () => {
    expect(resolveProviderChain('codex', '["codex","opencode","claude"]', { known: ['codex', 'claude'] })).toEqual([
      'codex',
      'claude',
    ]);
  });

  it('normalizes case', () => {
    expect(resolveProviderChain('Codex', '["CODEX","Claude"]')).toEqual(['codex', 'claude']);
    expect(parseStoredProviderChain('[" Codex "]')).toEqual(['codex']);
  });
});

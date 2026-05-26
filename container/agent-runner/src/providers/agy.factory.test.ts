import { describe, expect, test } from 'bun:test';

describe('AgyProvider', () => {
  test('registers itself when imported', async () => {
    await import('./agy.js');
    const { getProviderFactory, listProviderNames } = await import('./provider-registry.js');
    expect(listProviderNames()).toContain('agy');
    const factory = getProviderFactory('agy');
    const instance = factory({});
    expect(instance.supportsNativeSlashCommands).toBe(false);
  });

  test('isSessionInvalid matches the agy-not-found error text', async () => {
    await import('./agy.js');
    const { getProviderFactory } = await import('./provider-registry.js');
    const provider = getProviderFactory('agy')({});
    // Exact warning agy emits on stdout for a missing --conversation id
    // (verified in spike Task 1.3 step 3). NOTE: agy exits 0 in this case
    // and silently falls through to a fresh conversation — the provider
    // scans stdout for this warning mid-stream and throws an error whose
    // message matches the regex so the agent-runner clears continuation.
    const NOT_FOUND_MSG = 'Warning: conversation "abc-123" not found.';
    expect(provider.isSessionInvalid(new Error(NOT_FOUND_MSG))).toBe(true);
    expect(provider.isSessionInvalid(new Error('something else entirely'))).toBe(false);
  });
});

import { describe, expect, it } from 'bun:test';

import { CodexProvider } from './codex.js';

describe('CodexProvider', () => {
  it('rejects unsupported reasoning effort values', () => {
    expect(() => new CodexProvider({ effort: 'ultra' })).toThrow(/Unsupported Codex reasoning effort/);
  });

  it('accepts max, the top of the GPT-5.6 effort ladder', () => {
    expect(new CodexProvider({ effort: 'max' })).toBeInstanceOf(CodexProvider);
  });

  it('normalizes supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'HIGH' })).toBeInstanceOf(CodexProvider);
  });

  it('accepts supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'xhigh' })).toBeInstanceOf(CodexProvider);
  });

  it('requires the shared memory hook before starting a query', () => {
    expect(() => new CodexProvider({}).query({ prompt: 'hello', cwd: '/workspace/agent' })).toThrow(/not registered/);
  });
});

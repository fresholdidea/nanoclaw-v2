import { describe, expect, test } from 'bun:test';
import { mcpServersToAgyConfig } from './mcp-to-agy.js';

describe('mcpServersToAgyConfig', () => {
  test('returns empty object when no servers configured', () => {
    expect(mcpServersToAgyConfig(undefined)).toEqual({});
  });

  test('maps a stdio server', () => {
    const result = mcpServersToAgyConfig({
      slack: {
        command: '/usr/local/bin/slack-mcp',
        args: ['--mode', 'http'],
        env: { TOKEN: 'placeholder' },
      },
    });
    expect(result).toEqual({
      slack: {
        command: '/usr/local/bin/slack-mcp',
        args: ['--mode', 'http'],
        env: { TOKEN: 'placeholder' },
      },
    });
  });

  test('maps an http server', () => {
    const result = mcpServersToAgyConfig({
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Key': 'abc' },
      },
    });
    expect(result).toEqual({
      remote: {
        httpUrl: 'https://example.com/mcp',
        headers: { 'X-Key': 'abc' },
      },
    });
  });

  test('omits env field when empty', () => {
    const result = mcpServersToAgyConfig({
      bare: { command: 'echo', args: [], env: {} },
    });
    expect(result.bare).toEqual({ command: 'echo', args: [] });
  });
});

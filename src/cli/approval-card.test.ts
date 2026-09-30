/**
 * The approval card renders before any handler validates the request, so
 * every shape an agent can send — argv strings, `--stdin-json` structures,
 * an inline `--flag=value`, malformed JSON — must render without a
 * secret-shaped value and without throwing. The card-vs-stored-payload
 * contract, end to end, is in dispatch-approval-card.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { renderCardArgs } from './approval-card.js';

const API_KEY = 'fake-extra-api-key-value';
const GH_TOKEN = 'ghp_fakefakefake1234';

function redactedForm(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<redacted: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${digest}>`;
}

describe('renderCardArgs', () => {
  it('redacts secret-shaped env entries and args elements, keeping the rest reviewable', () => {
    const card = renderCardArgs({
      name: 'extra',
      command: 'npx',
      args: JSON.stringify(['-y', 'extra-mcp', '--token', GH_TOKEN]),
      env: JSON.stringify({ EXTRA_API_KEY: API_KEY, NODE_OPTIONS: '--require /x.js' }),
    });

    expect(card).toBe(
      `--name extra --command npx --args ["-y","extra-mcp","--token","${redactedForm(GH_TOKEN)}"] ` +
        `--env {"EXTRA_API_KEY":"${redactedForm(API_KEY)}","NODE_OPTIONS":"--require /x.js"}`,
    );
  });

  it('redacts credential headers, hyphenated names included', () => {
    const headers = { Authorization: 'Bearer fake-bearer', 'X-Api-Key': 'fake-x-api-key', Accept: 'application/json' };

    expect(renderCardArgs({ headers: JSON.stringify(headers) })).toBe(
      `--headers {"Authorization":"${redactedForm('Bearer fake-bearer')}",` +
        `"X-Api-Key":"${redactedForm('fake-x-api-key')}","Accept":"application/json"}`,
    );
  });

  it('hides a flag name that carries its own value (the parsers keep `--env={…}` as one key)', () => {
    const inline = `env={"EXTRA_API_KEY":"${API_KEY}"}`;

    expect(renderCardArgs({ name: 'extra', [inline]: true })).toBe(`--name extra --${redactedForm(inline)} true`);
  });

  it('redacts a secret-named or secret-shaped value on any flag', () => {
    // `--args --token ghp_…` (args not given as JSON) parses as `args: true` plus a `token` flag.
    const card = renderCardArgs({ args: true, token: GH_TOKEN, 'api-key': 'plain-value', note: GH_TOKEN, id: 'ag-1' });

    expect(card).toBe(
      `--args true --token ${redactedForm(GH_TOKEN)} --api-key ${redactedForm('plain-value')} ` +
        `--note ${redactedForm(GH_TOKEN)} --id ag-1`,
    );
  });

  it('shows the URL origin but redacts secret path segments and query values', () => {
    // `api_key=` is refused on replay, but the card renders before that check.
    const url = `https://mcp.example.com/s/${GH_TOKEN}/mcp?config=sk-live-abc123&api_key=plain&debug=1`;

    expect(renderCardArgs({ url })).toBe(
      `--url https://mcp.example.com/s/${redactedForm(GH_TOKEN)}/mcp` +
        `?config=${redactedForm('sk-live-abc123')}&api_key=${redactedForm('plain')}&debug=1`,
    );
  });

  it('drops URL credentials and fragments, and hides a URL that is not HTTP(S) whole', () => {
    const notHttp = `data:text/plain,${GH_TOKEN}`;
    const unparseable = `not a url ${GH_TOKEN}`;

    expect(renderCardArgs({ url: 'https://user:hunter2@mcp.example.com/mcp#frag' })).toBe(
      '--url https://mcp.example.com/mcp',
    );
    expect(renderCardArgs({ url: notHttp })).toBe(`--url ${redactedForm(notHttp)}`);
    expect(renderCardArgs({ url: unparseable })).toBe(`--url ${redactedForm(unparseable)}`);
  });

  it('hides structured (--stdin-json) values whole — the handlers only decode strings', () => {
    expect(() => renderCardArgs({ name: { toString: 1 } })).not.toThrow();
    expect(
      renderCardArgs({ env: { EXTRA_API_KEY: API_KEY }, args: ['--token', GH_TOKEN], name: { toString: 1 } }),
    ).toBe('--env <redacted> --args <redacted> --name <redacted>');
  });

  it('hides JSON of the wrong shape whole, without re-serializing it', () => {
    const nested = JSON.stringify({ A: { token: GH_TOKEN } });
    const mixedArgs = JSON.stringify(['ok', 1]);
    const unparseable = `{"EXTRA_API_KEY": "${API_KEY}"`;
    // JSON.parse accepts this depth; JSON.stringify throws RangeError on it.
    const deep = `{"A":${'['.repeat(10_000)}${']'.repeat(10_000)}}`;

    expect(renderCardArgs({ env: nested })).toBe(`--env ${redactedForm(nested)}`);
    expect(renderCardArgs({ args: mixedArgs })).toBe(`--args ${redactedForm(mixedArgs)}`);
    expect(renderCardArgs({ env: unparseable })).toBe(`--env ${redactedForm(unparseable)}`);
    expect(() => renderCardArgs({ env: deep })).not.toThrow();
    expect(renderCardArgs({ env: deep })).toBe(`--env ${redactedForm(deep)}`);
  });

  it('renders booleans, numbers and null as they are', () => {
    expect(renderCardArgs({ rw: true, 'max-messages-per-prompt': 5, timezone: null })).toBe(
      '--rw true --max-messages-per-prompt 5 --timezone null',
    );
  });
});

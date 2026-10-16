import { createTelegramAdapter, TelegramFormatConverter } from '@chat-adapter/telegram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isParseEntitiesError, toPlainTextMessage, withPlainTextFallback } from './telegram-plain-fallback.js';

// Zed → Brad, 2026-10-16 (msg-1792159525974-zh474f, msg-1792160273417-56n1a0).
// Both were dropped after 3 attempts: "Can't find end of Italic entity at byte
// offset 1088" and "Can't find end of a URL at byte offset 766".
const CUBBY_DOCS_READY =
  'All three Cubby docs are ready in brad@demandgenguy.com. None are shared with Forrest yet.\n\n' +
  '• *Design brief:* https://docs.google.com/document/d/1La7MHzTdRJMGOiYbjLjsHJQgJyqXBedCLp4k0yXlGos/edit\n' +
  '• *Search ad copy:* https://docs.google.com/document/d/1XSY9x6axG5ekxsif-5vm5_ZMp-VPyUzs7UCSg8ceAxk/edit\n' +
  '• *Landing page requirements:* https://docs.google.com/document/d/1Rg6ss3xtpQByMG2kHOTdH6FDP_fF5BeRS878uTKU_yQ/edit\n\n' +
  'Before they go out:\n' +
  '• *Budget:* the copy doc says month 1 media is just under $4,000. Forrest asked to "start with a 10K budget for the first 90 days". Which one should the doc use?\n' +
  '• *[inferred] lines:* these aren\'t on the Cubby site, e.g. "US-based support", "cloud/PMS" and the 12-18% revenue figure. Cubby needs to sign off on them.\n' +
  '• *Page owners:* most landing pages have no owner yet. The LP doc asks Forrest to name them.\n\n' +
  "Say the word and I'll share them with Forrest.";

const CUBBY_DOCS_WHERE =
  'They\'re in the root of My Drive on brad@demandgenguy.com, created at 9:32 today. Search "Draft V1":\n' +
  '• Cubby Retargeting Statics - Design Brief (Draft V1): https://docs.google.com/document/d/1La7MHzTdRJMGOiYbjLjsHJQgJyqXBedCLp4k0yXlGos/edit\n' +
  '• Cubby Search Ad Copy - Brand and Category (Draft V1): https://docs.google.com/document/d/1XSY9x6axG5ekxsif-5vm5_ZMp-VPyUzs7UCSg8ceAxk/edit\n' +
  '• Cubby Landing Pages - Requests and Requirements (Draft V1): https://docs.google.com/document/d/1Rg6ss3xtpQByMG2kHOTdH6FDP_fF5BeRS878uTKU_yQ/edit\n\n' +
  "All three are written and humanized. Before they go to Forrest, they need your review and a budget answer: the copy doc says month 1 is just under $4K, but Forrest said $10K for the first 90 days. They aren't shared with him yet.\n\n" +
  'Want me to move them into your "Cubby Storage" folder? I\'d keep them out of "Cubby <> Demand Gen Guy Collab", because that folder would share them with Cubby.';

type Sent = { method: string; body: Record<string, unknown> };

let sent: Sent[];
let respond: (method: string, body: Record<string, unknown>) => { status: number; json: unknown };

beforeEach(() => {
  sent = [];
  respond = () => ({
    status: 200,
    json: { ok: true, result: { message_id: 1, date: 0, chat: { id: 42, type: 'private' } } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      const method = url.split('/').pop()!;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      sent.push({ method, body });
      const r = respond(method, body);
      return new Response(JSON.stringify(r.json), { status: r.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function adapter() {
  return createTelegramAdapter({ botToken: '123:abc', mode: 'polling' });
}

/**
 * The subset of Telegram's MarkdownV2 parser these failures hit: every link
 * URL `(...)` must close, and `_` / `*` entity markers outside URLs must pair.
 */
function markdownV2Problems(text: string): string[] {
  const problems: string[] = [];
  const open: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === ']' && text[i + 1] === '(') {
      const end = text.indexOf(')', i + 2);
      if (end === -1) problems.push(`unclosed URL at ${i + 2}`);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '_' || c === '*') {
      if (open.at(-1) === c) open.pop();
      else open.push(c);
    }
  }
  if (open.length) problems.push(`unclosed entities: ${open.join('')}`);
  return problems;
}

describe('Telegram MarkdownV2 delivery of URLs with underscores', () => {
  for (const [name, body, lastUrl] of [
    ['italic labels + doc links', CUBBY_DOCS_READY, 'FDP_fF5BeRS878uTKU_yQ/edit)'],
    ['doc links only', CUBBY_DOCS_WHERE, 'FDP_fF5BeRS878uTKU_yQ/edit)'],
  ] as const) {
    it(`sends the whole converted message untruncated (${name})`, async () => {
      await adapter().postMessage('telegram:42', { markdown: body });

      expect(sent).toHaveLength(1);
      const { text, parse_mode } = sent[0].body as { text: string; parse_mode: string };
      expect(parse_mode).toBe('MarkdownV2');
      expect(text).toBe(new TelegramFormatConverter().fromMarkdown(body));
      expect(text).toContain(lastUrl);
      expect(text.endsWith('Forrest\\.') || text.endsWith('Cubby\\.')).toBe(true);
      expect(markdownV2Problems(text)).toEqual([]);
    });
  }
});

describe('withPlainTextFallback', () => {
  const PARSE_ERROR = {
    status: 400,
    json: {
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities: Can't find end of a URL at byte offset 766",
    },
  };

  it('resends once as plain text when Telegram rejects the entities', async () => {
    respond = (_m, body) =>
      body.parse_mode === 'MarkdownV2'
        ? PARSE_ERROR
        : { status: 200, json: { ok: true, result: { message_id: 7, date: 0, chat: { id: 42, type: 'private' } } } };

    const result = await withPlainTextFallback(adapter()).postMessage('telegram:42', { markdown: CUBBY_DOCS_READY });

    expect(sent).toHaveLength(2);
    expect(sent[1].body.parse_mode).toBeUndefined();
    const plain = sent[1].body.text as string;
    expect(plain).toContain('Design brief:');
    expect(plain).toContain('https://docs.google.com/document/d/1Rg6ss3xtpQByMG2kHOTdH6FDP_fF5BeRS878uTKU_yQ/edit');
    expect(plain).not.toContain('\\');
    expect(result.id).toBe('42:7');
  });

  it('retries edits as plain text too', async () => {
    respond = (_m, body) =>
      body.parse_mode === 'MarkdownV2'
        ? PARSE_ERROR
        : { status: 200, json: { ok: true, result: { message_id: 9, date: 0, chat: { id: 42, type: 'private' } } } };

    await withPlainTextFallback(adapter()).editMessage('telegram:42', '42:9', { markdown: '*hi* there' });

    expect(sent.map((s) => s.method)).toEqual(['editMessageText', 'editMessageText']);
    expect(sent[1].body.parse_mode).toBeUndefined();
    expect(sent[1].body.text).toBe('hi there');
  });

  it('does not retry other errors', async () => {
    respond = () => ({ status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });

    await expect(withPlainTextFallback(adapter()).postMessage('telegram:42', { markdown: 'hi' })).rejects.toThrow(
      'chat not found',
    );
    expect(sent).toHaveLength(1);
  });

  it('rethrows when the plain resend also fails', async () => {
    respond = () => PARSE_ERROR;

    await expect(withPlainTextFallback(adapter()).postMessage('telegram:42', { markdown: 'hi' })).rejects.toThrow(
      "can't parse entities",
    );
    expect(sent).toHaveLength(2);
  });

  it('only builds a plain twin for markdown/ast messages', () => {
    expect(toPlainTextMessage('hi')).toBeNull();
    expect(toPlainTextMessage({ raw: 'hi' })).toBeNull();
    expect(toPlainTextMessage({ markdown: '**hi** _there_' })).toEqual({ raw: 'hi there' });
    expect(isParseEntitiesError(new Error("Bad Request: can't parse entities: x"))).toBe(true);
    expect(isParseEntitiesError(new Error('Bad Request: chat not found'))).toBe(false);
  });
});

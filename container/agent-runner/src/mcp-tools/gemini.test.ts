import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { askGemini } from './gemini.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('ask_gemini', () => {
  it('queues a research request with no files and returns at once', async () => {
    const result = await askGemini.handler({ prompt: '  Who regulates bookkeeping apps?  ', label: 'regs' });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toMatch(/^Gemini request gem-req-\S+ queued with no files/);
    const [row] = getUndeliveredMessages();
    expect(row.kind).toBe('system');
    expect(JSON.parse(row.content)).toMatchObject({
      action: 'gemini_request',
      prompt: 'Who regulates bookkeeping apps?',
      files: [],
      effort: 'high',
      label: 'regs',
    });
  });

  it('refuses bad input before writing anything', async () => {
    for (const args of [
      {},
      { prompt: '   ' },
      { prompt: 'x'.repeat(12_001) },
      { prompt: 'q', files: 'nope' },
      { prompt: 'q', files: ['/etc/passwd'] },
      { prompt: 'q', files: ['/workspace/agent/../../etc/passwd'] },
      { prompt: 'q', files: ['/workspace/agent/definitely-missing.md'] },
      { prompt: 'q', files: Array.from({ length: 21 }, (_, i) => `/workspace/agent/${i}.md`) },
      { prompt: 'q', effort: 'max' },
    ]) {
      const result = await askGemini.handler(args as Record<string, unknown>);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

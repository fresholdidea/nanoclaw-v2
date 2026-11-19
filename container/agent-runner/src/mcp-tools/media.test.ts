import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { transcribeMedia } from './media.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('transcribe_media', () => {
  it('queues a media request and returns at once', async () => {
    const result = await transcribeMedia.handler({
      url: ' https://www.instagram.com/reel/Df5WjOEvT5l/?avpt=Y2Fmc3htZDZqczJu ',
      label: 'dakota',
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toMatch(/^Media request med-req-\S+ queued for www\.instagram\.com/);
    const [row] = getUndeliveredMessages();
    expect(row.kind).toBe('system');
    expect(JSON.parse(row.content)).toMatchObject({
      action: 'media_request',
      url: 'https://www.instagram.com/reel/Df5WjOEvT5l/?avpt=Y2Fmc3htZDZqczJu',
      label: 'dakota',
    });
  });

  it('refuses bad input before writing anything', async () => {
    for (const args of [
      {},
      { url: '  ' },
      { url: 'https://example.com/a.mp4' },
      { url: 'http://[bad' },
      { url: 'x'.repeat(3000) },
    ]) {
      const result = await transcribeMedia.handler(args as Record<string, unknown>);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

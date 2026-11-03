import { describe, expect, it } from 'vitest';
import { codeWrapUnlinkableUrls, isUnlinkableUrl } from './telegram-unlinkable-urls.js';

describe('isUnlinkableUrl', () => {
  it('flags loopback, private, and bare-hostname URLs', () => {
    for (const u of [
      'http://127.0.0.1:10254/p/x',
      'http://localhost:3100/dashboard',
      'https://10.0.0.5/',
      'http://192.168.1.20:8080/a',
      'http://172.16.4.4/',
      'http://onecli/',
      'http://mac-mini.local:10254/',
    ]) {
      expect(isUnlinkableUrl(u), u).toBe(true);
    }
  });

  it('leaves public URLs alone', () => {
    for (const u of ['https://example.com/a?b=c', 'http://api.airtable.com/v0', 'https://172.300.1.1/']) {
      expect(isUnlinkableUrl(u), u).toBe(false);
    }
  });
});

describe('codeWrapUnlinkableUrls', () => {
  it('wraps the OneCLI connect link that Telegram rejected', () => {
    const url =
      'http://127.0.0.1:10254/p/2cbaeb93-8888-469f-abbd-f2a75c596ce2/connections?connect=linkedin&source=agent&agent_name=cache-am';
    expect(codeWrapUnlinkableUrls(`Connect here: ${url}\n\n**Decision 7**`)).toBe(
      `Connect here: \`${url}\`\n\n**Decision 7**`,
    );
  });

  it('keeps trailing punctuation outside the code span', () => {
    expect(codeWrapUnlinkableUrls('Open http://localhost:3100/dashboard.')).toBe(
      'Open `http://localhost:3100/dashboard`.',
    );
  });

  it('does not touch public URLs, markdown links, or existing code', () => {
    const s = 'See https://example.com/x and [t](http://127.0.0.1:1/y) and `http://127.0.0.1:2/z`';
    expect(codeWrapUnlinkableUrls(s)).toBe(s);
  });

  it('leaves fenced blocks untouched', () => {
    const s = 'a\n```\nhttp://127.0.0.1:1/in-fence\n```\nhttp://127.0.0.1:1/out';
    expect(codeWrapUnlinkableUrls(s)).toBe('a\n```\nhttp://127.0.0.1:1/in-fence\n```\n`http://127.0.0.1:1/out`');
  });

  it('is a no-op without URLs', () => {
    expect(codeWrapUnlinkableUrls('plain text')).toBe('plain text');
    expect(codeWrapUnlinkableUrls('')).toBe('');
  });
});

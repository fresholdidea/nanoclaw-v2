import { describe, expect, it } from 'vitest';

import { defuse, oneLine, transcriptText } from './document.js';
import { friendlyDownloadError, metaFromInfo } from './pipeline.js';
import { cacheKey, MediaUrlError, parseMediaUrl } from './url.js';

describe('parseMediaUrl', () => {
  it.each([
    [
      'https://www.instagram.com/reel/Df5WjOEvT5l/?avpt=Y2Fmc3htZDZqczJu',
      'instagram',
      'Df5WjOEvT5l',
      'https://www.instagram.com/reel/Df5WjOEvT5l/',
    ],
    ['instagram.com/reels/Df5WjOEvT5l', 'instagram', 'Df5WjOEvT5l', 'https://www.instagram.com/reel/Df5WjOEvT5l/'],
    [
      'https://www.instagram.com/p/C1abcDEF23/?igsh=xyz',
      'instagram',
      'C1abcDEF23',
      'https://www.instagram.com/p/C1abcDEF23/',
    ],
    [
      'https://www.instagram.com/dakota.hermes/reel/Df5WjOEvT5l/',
      'instagram',
      'Df5WjOEvT5l',
      'https://www.instagram.com/reel/Df5WjOEvT5l/',
    ],
    [
      'https://www.linkedin.com/posts/jane-doe_ads-testing-activity-7508146479996280833-AbCd?utm_source=share',
      'linkedin',
      '7508146479996280833',
      'https://www.linkedin.com/posts/jane-doe_ads-testing-activity-7508146479996280833-AbCd/',
    ],
    [
      'https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7508146479996280833/',
      'linkedin',
      '7508146479996280833',
      'https://www.linkedin.com/feed/update/urn:li:activity:7508146479996280833/',
    ],
    [
      'https://www.linkedin.com/safety/go?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ%3Fsi%3Dabc',
      'youtube',
      'dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ],
    [
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=30s',
      'youtube',
      'dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    [
      'https://www.tiktok.com/@some.one/video/7301234567890123456?lang=en',
      'tiktok',
      '7301234567890123456',
      'https://www.tiktok.com/@some.one/video/7301234567890123456',
    ],
    [
      'https://twitter.com/someone/status/1790000000000000000/video/1',
      'x',
      '1790000000000000000',
      'https://x.com/someone/status/1790000000000000000',
    ],
  ])('%s', (raw, platform, id, url) => {
    expect(parseMediaUrl(raw)).toMatchObject({ platform, id, url });
  });

  it.each([
    'https://example.com/video.mp4',
    'http://192.168.0.103:8123/api',
    'file:///etc/passwd',
    'https://www.instagram.com/dakota.hermes/',
    'https://www.instagram.com/stories/someone/123/',
    'https://www.linkedin.com/in/jane-doe/',
    'https://www.youtube.com/playlist?list=PL123',
    'https://user:pw@www.instagram.com/reel/Df5WjOEvT5l/',
    'https://www.instagram.com:8443/reel/Df5WjOEvT5l/',
    'https://www.linkedin.com/safety/go?url=https%3A%2F%2Fexample.com%2F',
    'https://evilinstagram.com/reel/Df5WjOEvT5l/',
    'not a url at all',
    'https://www.linkedin.com/feed/update/urn%E0%A4%A',
    'https://www.linkedin.com/posts/a/b-7508146479996280833-AbCd',
  ])('refuses %s', (raw) => {
    expect(() => parseMediaUrl(raw)).toThrow(MediaUrlError);
  });

  it('only ever names platform extractors, never the generic one', () => {
    const t = parseMediaUrl('https://www.instagram.com/reel/Df5WjOEvT5l/');
    expect(t.extractors).toEqual(['Instagram']);
    expect(cacheKey(t)).toBe('instagram-Df5WjOEvT5l');
  });
});

describe('document helpers', () => {
  it('defuses Templater openers and every DataviewJS form', () => {
    const out = defuse('a <% tp.system %> b <%* x %>\n```dataviewjs\nrequire("x")\n```\n`$= dv.pages()` `= this.x`');
    expect(out).not.toContain('<%');
    expect(out).not.toContain('`');
  });

  it('flattens metadata to one line', () => {
    expect(oneLine('Real\r\nName\u2028- Source: x\u0007`$= 1`')).toBe('Real Name - Source: x ˋ$= 1ˋ');
  });

  it('stamps the transcript about every 30 seconds', () => {
    const text = transcriptText({
      index: 1,
      durationSec: 70,
      noAudio: false,
      segments: [
        { start: 0, text: 'one' },
        { start: 10, text: 'two' },
        { start: 31, text: 'three' },
        { start: 65, text: 'four' },
      ],
    });
    expect(text).toBe('[0:00] one\ntwo\n[0:31] three\n[1:05] four');
  });

  it('says so when there is no audio or no speech', () => {
    expect(transcriptText({ index: 1, durationSec: 5, noAudio: true, segments: [] })).toMatch(/no audio track/);
    expect(transcriptText({ index: 1, durationSec: 5, noAudio: false, segments: [] })).toMatch(/no speech/);
  });

  it('reads yt-dlp metadata and errors', () => {
    expect(metaFromInfo({ uploader: 'Dakota Hermes', channel: 'dakota.hermes', timestamp: 1795033460 })).toMatchObject({
      uploader: 'Dakota Hermes',
      channel: 'dakota.hermes',
      published: '2026-11-18T20:24:20.000Z',
    });
    expect(metaFromInfo({ upload_date: '20261118' }).published).toBe('2026-11-18');
    expect(friendlyDownloadError('ERROR: [Instagram] C1abc: There is no video in this post')).toMatch(
      /no video or audio/,
    );
    expect(
      friendlyDownloadError(
        'ERROR: [Instagram] C1abc: Requested content is not available, rate-limit reached or login required',
      ),
    ).toMatch(/refused an anonymous download/);
  });
});

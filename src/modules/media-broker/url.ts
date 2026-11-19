/**
 * Which URLs the media broker will hand to yt-dlp, and in what form.
 *
 * Only a post on a known platform passes. The host runs yt-dlp on its own
 * network (the LAN, Home Assistant, local services), so an arbitrary URL
 * would let any agent make the host fetch anything; yt-dlp's generic
 * extractor is never enabled. The canonical URL drops tracking parameters
 * (`igsh`, `avpt`, `utm_*`), and the platform id keys the transcript cache.
 */
export type MediaPlatform = 'instagram' | 'linkedin' | 'youtube' | 'tiktok' | 'x';

export interface MediaTarget {
  platform: MediaPlatform;
  /** The post's id on its platform (Instagram shortcode, LinkedIn activity id, YouTube video id...). */
  id: string;
  /** What yt-dlp is given: scheme, host and path only, plus `v=` for YouTube. */
  url: string;
  /** yt-dlp extractor names for `--use-extractors`; the generic extractor is never among them. */
  extractors: string[];
}

export class MediaUrlError extends Error {}

const EXTRACTORS: Record<MediaPlatform, string[]> = {
  instagram: ['Instagram'],
  linkedin: ['LinkedIn'],
  youtube: ['youtube'],
  tiktok: ['TikTok'],
  x: ['twitter'],
};

export const SUPPORTED_PLATFORMS = 'Instagram (reel, post, tv), LinkedIn (post), YouTube, TikTok (video), X (status)';

function target(platform: MediaPlatform, id: string, url: string): MediaTarget {
  return { platform, id, url, extractors: EXTRACTORS[platform] };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new MediaUrlError('the URL has a malformed escape');
  }
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^(www|m|mobile)\./, '');
}

export function parseMediaUrl(raw: string, depth = 0): MediaTarget {
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new MediaUrlError('not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new MediaUrlError('only http(s) URLs are supported');
  if (u.username || u.password || u.port) throw new MediaUrlError('URLs with credentials or a port are not supported');
  const host = bareHost(u.hostname);
  const path = u.pathname;

  if (host === 'instagram.com') {
    const m = path.match(/^\/(?:[A-Za-z0-9._]+\/)?(p|tv|reels?)\/([A-Za-z0-9_-]{5,64})\/?$/);
    if (!m) throw new MediaUrlError('only Instagram reel, post or tv links are supported, not profiles or stories');
    const kind = m[1] === 'reels' ? 'reel' : m[1];
    return target('instagram', m[2], `https://www.instagram.com/${kind}/${m[2]}/`);
  }

  if (host === 'linkedin.com') {
    // In-app copies wrap the real link in LinkedIn's outbound redirect.
    if (path.replace(/\/$/, '') === '/safety/go') {
      const inner = u.searchParams.get('url');
      if (!inner || depth > 0) throw new MediaUrlError('LinkedIn redirect without a target');
      return parseMediaUrl(inner, depth + 1);
    }
    const post = path.match(/^\/posts\/([\w%.-]+-(\d{6,25})-[A-Za-z0-9]{4})\/?$/);
    if (post) return target('linkedin', post[2], `https://www.linkedin.com/posts/${post[1]}/`);
    const feed = safeDecode(path).match(/^\/feed\/update\/urn:li:activity:(\d{6,25})\/?$/);
    if (feed) return target('linkedin', feed[1], `https://www.linkedin.com/feed/update/urn:li:activity:${feed[1]}/`);
    throw new MediaUrlError(
      'only LinkedIn post links (linkedin.com/posts/… or feed/update/urn:li:activity:…) are supported',
    );
  }

  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    let id: string | null = null;
    if (host === 'youtu.be') id = path.slice(1).split('/')[0] || null;
    else if (path === '/watch') id = u.searchParams.get('v');
    else id = path.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1] ?? null;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id))
      throw new MediaUrlError('only single YouTube video links are supported');
    return target('youtube', id, `https://www.youtube.com/watch?v=${id}`);
  }

  if (host === 'tiktok.com') {
    const m = path.match(/^\/@([A-Za-z0-9._-]{1,64})\/video\/(\d{6,25})\/?$/);
    if (!m) throw new MediaUrlError('only full TikTok video links (tiktok.com/@user/video/…) are supported');
    return target('tiktok', m[2], `https://www.tiktok.com/@${m[1]}/video/${m[2]}`);
  }

  if (host === 'x.com' || host === 'twitter.com') {
    const m = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{6,25})(?:\/video\/\d)?\/?$/);
    if (!m) throw new MediaUrlError('only X post links (x.com/<user>/status/…) are supported');
    return target('x', m[2], `https://x.com/${m[1]}/status/${m[2]}`);
  }

  throw new MediaUrlError(`${host} is not a supported platform; supported: ${SUPPORTED_PLATFORMS}`);
}

/** File-name-safe cache key, e.g. `instagram-Df5WjOEvT5l`. */
export function cacheKey(t: MediaTarget): string {
  return `${t.platform}-${t.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

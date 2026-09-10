/**
 * Telegram rejects messages whose link target it cannot resolve as a URL —
 * loopback and private hosts included — with "Bad Request: can't parse
 * entities: Can't find end of a URL". The Chat SDK Telegram adapter autolinks
 * bare URLs, so an agent pasting a OneCLI connect link (`http://127.0.0.1:10254/...`)
 * gets its whole reply dropped after retries.
 *
 * Wrap such URLs in inline code before the adapter sees them. Code spans are
 * rendered verbatim and never autolinked, so the text survives and the user
 * can still copy it.
 */

const UNLINKABLE_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[^/]+\.local|[^/.]+)(?::\d+)?$/i;

// A bare URL: scheme, then everything up to whitespace or a closing bracket.
// Trailing sentence punctuation is left outside the match.
const BARE_URL = /(?<!\]\()\bhttps?:\/\/[^\s<>()\[\]`]+?(?=[.,;:!?]*(?:[\s<>()\[\]`]|$))/g;

// Code spans and fences are left untouched.
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

export function isUnlinkableUrl(url: string): boolean {
  const m = url.match(/^https?:\/\/([^/?#]+)/i);
  return m !== null && UNLINKABLE_HOST.test(m[1]);
}

export function codeWrapUnlinkableUrls(text: string): string {
  if (!text || !/https?:\/\//i.test(text)) return text;
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(CODE)) {
    parts.push(wrapOutsideCode(text.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index! + m[0].length;
  }
  parts.push(wrapOutsideCode(text.slice(last)));
  return parts.join('');
}

function wrapOutsideCode(segment: string): string {
  return segment.replace(BARE_URL, (url) => (isUnlinkableUrl(url) ? `\`${url}\`` : url));
}

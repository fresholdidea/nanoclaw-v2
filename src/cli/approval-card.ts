/**
 * A held command's flags as the ncl approval card shows them.
 *
 * The card is posted to the approver's chat and stays in that platform's
 * history, so a secret-shaped value renders as the self-mod card's
 * `<redacted: N bytes, sha256 …>` placeholder — the same policy and helpers,
 * so non-secret values stay visible for review. The approval payload is built
 * from the untouched args: the approved replay applies the verbatim values.
 *
 * The hold runs before any handler validates the request, so every shape an
 * agent can send has to render safely. Input a handler would not decode is
 * hidden whole rather than guessed at.
 */
import { REDACTED_VALUE } from '../container-config.js';
import { displayMcpUrl, isSecretEntry, redactSecret, SECRET_VALUE_RE } from '../modules/self-mod/request.js';

/** A plain flag name. The argv parsers don't split `--env={…}`: it arrives as one key carrying its value. */
const FLAG_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Flags a handler decodes with JSON.parse (`groups config add-mcp-server`):
 * a record of strings, or a list of strings. Matched on every held command —
 * no other command uses these names, and redaction fails safe.
 */
const JSON_RECORD_FLAGS = new Set(['env', 'headers']);
const JSON_LIST_FLAGS = new Set(['args']);

/**
 * `--key "value" …` for the card's command line. Every value is JSON-encoded
 * (dispatch.ts puts the line in a code fence and escapes invisibles), so no
 * value can add lines or pass as another flag; secrets are already redacted.
 */
export function renderCardArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `--${cardKey(key)} ${cardValue(key, value)}`)
    .join(' ');
}

/** A plain flag name as is; any other name quoted — and hidden whole when it carries an inline `=value`. */
function cardKey(key: string): string {
  if (FLAG_NAME_RE.test(key)) return key;
  return JSON.stringify(key.includes('=') ? redactSecret(key) : key);
}

/** JSON text for one value (bare for booleans, numbers and null). */
function cardValue(key: string, value: unknown): string {
  // Structured values only arrive via --stdin-json, and no handler decodes
  // them; String() of one can even throw (an own `toString` property).
  if (typeof value === 'object' && value !== null) return JSON.stringify(REDACTED_VALUE);
  if (typeof value !== 'string') return String(value);
  if (key === 'url') return JSON.stringify(cardUrl(value));
  if (JSON_RECORD_FLAGS.has(key) || JSON_LIST_FLAGS.has(key)) return cardJson(key, value);
  return JSON.stringify(isSecretEntry(key, value) ? redactSecret(value) : value);
}

function cardUrl(raw: string): string {
  try {
    return displayMcpUrl(raw);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a URL the handler would refuse is expected input; it is hidden whole
  } catch {
    return redactSecret(raw);
  }
}

/**
 * Decoded exactly as the handler decodes it. Only a flat record or list of
 * strings is shown entry by entry; any other shape is hidden whole — the
 * handler refuses it on replay, and re-serializing arbitrary JSON can throw.
 */
function cardJson(key: string, raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    // eslint-disable-next-line no-catch-all/no-catch-all -- unparseable input is expected; it is hidden whole
  } catch {
    return JSON.stringify(redactSecret(raw));
  }
  if (JSON_LIST_FLAGS.has(key)) {
    if (!isStringList(parsed)) return JSON.stringify(redactSecret(raw));
    return JSON.stringify(parsed.map((a) => (SECRET_VALUE_RE.test(a) ? redactSecret(a) : a)));
  }
  if (!isStringRecord(parsed)) return JSON.stringify(redactSecret(raw));
  return JSON.stringify(
    Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, isSecretEntry(k, v) ? redactSecret(v) : v])),
  );
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

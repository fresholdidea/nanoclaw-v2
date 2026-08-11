/**
 * Delivery error classification: did the send actually land?
 *
 * The delivery loop retries failed sends. That is only safe when we *know*
 * the message never reached the platform. A transport-level failure gives no
 * such guarantee — when `fetch` throws on a request that was already written
 * to the socket, Telegram has very likely accepted and posted the message and
 * only the response was lost. Retrying then posts it a second time, which the
 * user sees as a duplicate reply.
 *
 * So we split delivery errors in two:
 *
 *   - **Ambiguous** — no usable response came back, so the message may or may
 *     not have been delivered. Do not retry. One possibly-lost message beats
 *     a guaranteed duplicate; the caller records it as delivered and warns.
 *   - **Definite** — the platform answered and rejected the send (4xx/5xx
 *     API error, validation, permissions, rate limit), or the host rejected
 *     it before any network call. The message did not land, so retrying is
 *     safe and useful.
 *
 * Note that a Telegram 5xx is *definite*: the adapter only raises it after
 * parsing an API response body, which means the request was answered and
 * refused. Only the no-response cases are ambiguous.
 */

/** Node/undici transport error codes that mean the request never completed cleanly. */
const AMBIGUOUS_SYSCALL_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Error names that mean the request was cut off rather than answered. */
const AMBIGUOUS_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/**
 * Adapter-level NetworkError messages raised *after* a response arrived but
 * before we could read a result. The platform may still have acted on the
 * request, so these are ambiguous too.
 */
const AMBIGUOUS_MESSAGE_PATTERNS = [/failed to parse/i, /returned no result/i];

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  originalError?: unknown;
  cause?: unknown;
}

function asErrorLike(err: unknown): ErrorLike | null {
  return typeof err === 'object' && err !== null ? (err as ErrorLike) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** True when the underlying transport failed without a usable response. */
function isTransportFailure(err: unknown, depth = 0): boolean {
  const e = asErrorLike(err);
  if (!e || depth > 4) return false;

  if (AMBIGUOUS_ERROR_NAMES.has(str(e.name))) return true;
  if (AMBIGUOUS_SYSCALL_CODES.has(str(e.code))) return true;
  // undici surfaces a bare "fetch failed" with the real cause nested.
  if (/^fetch failed$/i.test(str(e.message))) return true;

  return isTransportFailure(e.cause, depth + 1) || isTransportFailure(e.originalError, depth + 1);
}

/**
 * True when a delivery error leaves it unknown whether the message reached
 * the user. Callers must not retry these — see the module header.
 */
export function isAmbiguousDeliveryError(err: unknown): boolean {
  const e = asErrorLike(err);
  if (!e) return false;

  // Raw transport failure, at any nesting depth.
  if (isTransportFailure(e)) return true;

  const isAdapterNetworkError = str(e.name) === 'NetworkError' || str(e.code) === 'NETWORK_ERROR';
  if (!isAdapterNetworkError) return false;

  // @chat-adapter wraps the thrown fetch error as `originalError` only when
  // the request itself failed. A NetworkError built from a parsed API
  // response (5xx) carries no original error and is a definite rejection.
  if (e.originalError !== undefined) return true;

  const message = str(e.message);
  return AMBIGUOUS_MESSAGE_PATTERNS.some((p) => p.test(message));
}

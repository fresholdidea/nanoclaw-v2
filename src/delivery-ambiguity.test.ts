/**
 * Classification tests for delivery errors.
 *
 * The fixtures mirror the real shapes @chat-adapter/shared produces (name +
 * code + optional originalError), so a future adapter bump that changes them
 * fails here rather than silently reintroducing duplicate Telegram replies.
 */
import { describe, it, expect } from 'vitest';

import { isAmbiguousDeliveryError } from './delivery-ambiguity.js';

/** Rebuild an @chat-adapter/shared NetworkError without importing the package. */
function networkError(message: string, originalError?: Error): Error {
  const err = new Error(message) as Error & { code: string; originalError?: Error };
  err.name = 'NetworkError';
  err.code = 'NETWORK_ERROR';
  if (originalError) err.originalError = originalError;
  return err;
}

function adapterError(name: string, code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.name = name;
  err.code = code;
  return err;
}

function syscallError(code: string): Error {
  const err = new Error(`connect ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('isAmbiguousDeliveryError', () => {
  describe('ambiguous — the send may already have landed', () => {
    it('flags the fetch-threw NetworkError seen in the duplicate-reply logs', () => {
      // Exactly what drainSession caught when Telegram duplicated replies.
      const err = networkError('Network error calling Telegram sendMessage', syscallError('ECONNRESET'));
      expect(isAmbiguousDeliveryError(err)).toBe(true);
    });

    it('flags a wrapped fetch failure even with no syscall code on the cause', () => {
      expect(
        isAmbiguousDeliveryError(networkError('Network error calling Telegram sendMessage', new Error('boom'))),
      ).toBe(true);
    });

    it('flags an unparseable response — Telegram may still have posted', () => {
      expect(isAmbiguousDeliveryError(networkError('Failed to parse Telegram API response for sendMessage'))).toBe(
        true,
      );
    });

    it('flags a result-less response', () => {
      expect(isAmbiguousDeliveryError(networkError('Telegram API sendMessage returned no result'))).toBe(true);
    });

    it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'])(
      'flags a bare %s from a native adapter',
      (code) => {
        expect(isAmbiguousDeliveryError(syscallError(code))).toBe(true);
      },
    );

    it('flags an aborted or timed-out request', () => {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      expect(isAmbiguousDeliveryError(abort)).toBe(true);
    });

    it("flags undici's bare 'fetch failed' with a nested cause", () => {
      const err = new Error('fetch failed', { cause: syscallError('ECONNRESET') });
      expect(isAmbiguousDeliveryError(err)).toBe(true);
    });
  });

  describe('definite — the platform answered and refused', () => {
    it('does not flag a 5xx NetworkError built from a parsed API response', () => {
      // Response body was read, so the message was rejected. Retry is correct.
      expect(isAmbiguousDeliveryError(networkError('Bad Gateway (status 502, error 502)'))).toBe(false);
    });

    it('does not flag the supergroup ValidationError', () => {
      const err = adapterError(
        'ValidationError',
        'VALIDATION_ERROR',
        'Bad Request: group chat was upgraded to a supergroup chat',
      );
      expect(isAmbiguousDeliveryError(err)).toBe(false);
    });

    it.each([
      ['AuthenticationError', 'AUTHENTICATION_ERROR'],
      ['PermissionError', 'PERMISSION_DENIED'],
      ['ResourceNotFoundError', 'NOT_FOUND'],
      ['AdapterRateLimitError', 'RATE_LIMIT'],
    ])('does not flag %s', (name, code) => {
      expect(isAmbiguousDeliveryError(adapterError(name, code, 'nope'))).toBe(false);
    });

    it('does not flag a host-side rejection raised before any network call', () => {
      const err = new Error('unauthorized channel destination: ag-x cannot send to telegram/telegram:1');
      expect(isAmbiguousDeliveryError(err)).toBe(false);
    });

    it('does not flag non-error values', () => {
      expect(isAmbiguousDeliveryError(null)).toBe(false);
      expect(isAmbiguousDeliveryError('ECONNRESET')).toBe(false);
      expect(isAmbiguousDeliveryError(undefined)).toBe(false);
    });
  });

  it('stops recursing on a self-referential cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(isAmbiguousDeliveryError(err)).toBe(false);
  });
});

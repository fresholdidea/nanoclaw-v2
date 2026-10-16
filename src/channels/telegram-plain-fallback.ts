/**
 * Last-resort delivery for Telegram messages whose MarkdownV2 rendering is
 * rejected ("Bad Request: can't parse entities: ..."). The rejection is
 * deterministic, so the host's delivery retries just repeat it and the
 * message is dropped. Instead, resend once as plain text (no parse_mode):
 * the user loses the formatting but gets the words. Telegram still autolinks
 * bare URLs in plain text.
 *
 * Only markdown/ast messages are retried. Raw messages are already plain, and
 * cards would lose their buttons, so both rethrow unchanged.
 */
import type { Adapter, AdapterPostableMessage } from 'chat';
import { markdownToPlainText, toPlainText } from 'chat';

import { log } from '../log.js';

const PARSE_ENTITIES = /can't parse entities/i;

export function isParseEntitiesError(err: unknown): boolean {
  return err instanceof Error && PARSE_ENTITIES.test(err.message);
}

/** The plain-text twin of a markdown/ast message, or null if there is none. */
export function toPlainTextMessage(message: AdapterPostableMessage): AdapterPostableMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  let raw: string;
  if ('markdown' in message && typeof message.markdown === 'string') raw = markdownToPlainText(message.markdown);
  else if ('ast' in message && message.ast) raw = toPlainText(message.ast);
  else return null;
  const { files, attachments } = message as { files?: unknown; attachments?: unknown };
  return {
    raw,
    ...(files !== undefined && { files }),
    ...(attachments !== undefined && { attachments }),
  } as AdapterPostableMessage;
}

/**
 * Wrap postMessage/editMessage in place so the Chat SDK bridge (which holds
 * this same adapter object) gets the fallback on every send path.
 */
export function withPlainTextFallback<A extends Adapter>(adapter: A): A {
  const post = adapter.postMessage.bind(adapter);
  const edit = adapter.editMessage.bind(adapter);

  adapter.postMessage = async (threadId, message) => {
    try {
      return await post(threadId, message);
    } catch (err) {
      const plain = isParseEntitiesError(err) ? toPlainTextMessage(message) : null;
      if (!plain) throw err;
      log.warn('Telegram rejected MarkdownV2, resending as plain text', {
        threadId,
        err: (err as Error).message,
      });
      return post(threadId, plain);
    }
  };

  adapter.editMessage = async (threadId, messageId, message) => {
    try {
      return await edit(threadId, messageId, message);
    } catch (err) {
      const plain = isParseEntitiesError(err) ? toPlainTextMessage(message) : null;
      if (!plain) throw err;
      log.warn('Telegram rejected MarkdownV2 edit, retrying as plain text', {
        threadId,
        messageId,
        err: (err as Error).message,
      });
      return edit(threadId, messageId, plain);
    }
  };

  return adapter;
}

import { getInboundDb } from './db/connection.js';
import { getCurrentBatchRouting } from './db/session-state.js';

export interface DestinationCorrelation {
  inReplyTo: string | null;
  threadId: string | null;
}

export interface ResolveDestinationCorrelationOptions {
  explicitThreadId?: string | null;
  legacyInReplyTo?: string | null;
  /** The wrapped-output path historically used the newest channel row's id.
   * MCP sends did not. This flag preserves that no-batch compatibility seam. */
  legacyHistoricalInReplyTo?: boolean;
}

/**
 * Resolve reply correlation for every outbound content door.
 *
 * When a claimed-batch map exists it is authoritative: a matching destination
 * receives that row's correlation and an absent destination starts a new
 * thread. Agent destinations never query inbound history, so an unseen A2A
 * row cannot steal a return path. Historical lookup remains available only
 * for non-agent channel threads and for the pre-batch-state compatibility
 * path.
 */
export function resolveDestinationCorrelation(
  channelType: string,
  platformId: string,
  options: ResolveDestinationCorrelationOptions = {},
): DestinationCorrelation {
  const batchRouting = getCurrentBatchRouting(channelType, platformId);

  if (batchRouting !== undefined) {
    const batchThreadId = options.explicitThreadId ?? batchRouting?.threadId ?? null;
    const historicalThreadId =
      batchThreadId === null && channelType !== 'agent'
        ? resolveHistoricalChannelRouting(channelType, platformId, true)?.threadId
        : null;
    return {
      inReplyTo: batchRouting?.inReplyTo ?? null,
      threadId: batchThreadId ?? historicalThreadId ?? null,
    };
  }

  const historical =
    channelType === 'agent'
      ? null
      : resolveHistoricalChannelRouting(channelType, platformId, !options.legacyHistoricalInReplyTo);
  return {
    inReplyTo: (options.legacyHistoricalInReplyTo ? historical?.inReplyTo : null) ?? options.legacyInReplyTo ?? null,
    threadId: options.explicitThreadId ?? historical?.threadId ?? null,
  };
}

function resolveHistoricalChannelRouting(
  channelType: string,
  platformId: string,
  requireThreadId: boolean,
): DestinationCorrelation | null {
  try {
    const threadPredicate = requireThreadId ? ' AND thread_id IS NOT NULL' : '';
    const row = getInboundDb()
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?${threadPredicate}
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    return row ? { threadId: row.thread_id, inReplyTo: row.id } : null;
  } catch (error) {
    console.error(
      `[destination-routing] historical lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

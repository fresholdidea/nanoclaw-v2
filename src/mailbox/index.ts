import type { AgentMailbox, AgentMailboxFactory } from './types.js';

let active: AgentMailbox | undefined;
let factory: AgentMailboxFactory | undefined;

export function getAgentMailbox(): AgentMailbox {
  if (!factory) throw new Error('No agent mailbox registered');
  return (active ??= factory());
}

export function registerAgentMailbox(next: AgentMailboxFactory): void {
  if (factory || active) throw new Error('Agent mailbox already registered');
  factory = next;
}

/**
 * An outbound read found a write journal the host may not replay: either the
 * runner is mid-commit (transient — retry next tick) or a dead runner left it
 * behind (replay with recoverOutboundJournal once no runner is live).
 */
export class OutboundJournalPendingError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Outbound mailbox has a pending write journal', options);
    this.name = 'OutboundJournalPendingError';
  }
}

export function resetAgentMailboxForTesting(): AgentMailboxFactory | undefined {
  const previous = factory;
  active = undefined;
  factory = undefined;
  return previous;
}

export type {
  AgentMailbox,
  AgentMailboxFactory,
  ContainerState,
  Destination,
  DirectOutboundMessage,
  InboundMessage,
  InboundMailbox,
  MailboxSessionKey,
  MailboxSession,
  MessageRetry,
  OutboundMessage,
  OutboundMailbox,
  ProcessingClaim,
  ProcessingAck,
  RecurringMessage,
  SessionRouting,
  Task,
  TaskRecord,
  TaskStats,
  TaskUpdate,
} from './types.js';

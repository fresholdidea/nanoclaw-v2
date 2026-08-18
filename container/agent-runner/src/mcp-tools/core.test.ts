/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentBatchRouting } from '../db/session-state.js';
import { sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed peer agent destinations
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer'),
              ('other', 'Other', 'agent', NULL, NULL, 'ag-other')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('stamps the claimed batch message id, ignoring newer unseen inbound rows', async () => {
    // Current claimed batch has 'seen-current' from ag-peer
    setCurrentBatchRouting(
      {
        'agent:ag-peer': { inReplyTo: 'seen-current', threadId: null },
      },
      'seen-current',
    );

    // Newer unseen row arrives in inbound.db from ag-peer
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, channel_type, platform_id)
         VALUES ('unseen-newer', 100, 'chat', 'now', 'pending', '{}', 'agent', 'ag-peer')`,
      )
      .run();

    await sendMessage.handler({ to: 'peer', text: 'reply to peer' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    // MUST be 'seen-current', NOT 'unseen-newer'
    expect(out[0].in_reply_to).toBe('seen-current');
  });

  it('sets in_reply_to = null when sending to a peer not in the claimed batch', async () => {
    // Current claimed batch only has messages from ag-peer
    setCurrentBatchRouting(
      {
        'agent:ag-peer': { inReplyTo: 'seen-current', threadId: null },
      },
      'seen-current',
    );

    // Send to 'other' (ag-other), which was not in the claimed batch
    await sendMessage.handler({ to: 'other', text: 'initiating new thread' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

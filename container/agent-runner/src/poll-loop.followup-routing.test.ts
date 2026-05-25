import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

// Regression test for: routing.inReplyTo captured once at processQuery start
// and never advanced when follow-up batches were pushed into the active query.
// Symptom in Telegram: replies to the second user message looked like
// duplicate responses to the first because they all stamped the first
// message's id as in_reply_to.
//
// This lives in its own file so the bun test runner gives it fresh module
// state — other integration tests don't tear down their background
// runPollLoop, which leads to ghost loops polling our in-memory DB and
// breaking content-based waits.

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text }));
}

describe('processQuery — follow-up routing', () => {
  it('stamps each batch its own id as in_reply_to (not the initial batch id)', async () => {
    insertMessage('m-first', 'first');

    let call = 0;
    const provider = new MockProvider({}, () => {
      call += 1;
      return `<message to="discord-test">reply-${call}</message>`;
    });

    let loopDone = false;
    const loopPromise = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' })
      .catch(() => {})
      .finally(() => {
        loopDone = true;
      });

    const hasReply = (text: string) =>
      getUndeliveredMessages().some((m) => JSON.parse(m.content).text === text);
    await waitFor(() => hasReply('reply-1'), 2000);

    insertMessage('m-second', 'second');
    await waitFor(() => hasReply('reply-2'), 3000);

    const out = getUndeliveredMessages();
    const initial = out.find((m) => JSON.parse(m.content).text === 'reply-1');
    const followup = out.find((m) => JSON.parse(m.content).text === 'reply-2');
    expect(initial?.in_reply_to).toBe('m-first');
    // Pre-fix: 'm-first'. Post-fix: 'm-second'.
    expect(followup?.in_reply_to).toBe('m-second');

    // Don't await loopPromise — runPollLoop has no abort. Closing the DB in
    // afterEach makes its next getPendingMessages throw and the loop exit.
    expect(loopDone).toBe(false); // suppress unused warning; satisfies linter
    void loopPromise;
  });
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

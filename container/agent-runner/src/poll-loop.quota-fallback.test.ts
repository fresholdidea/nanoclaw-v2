import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getQuotaCooldown, setQuotaCooldown } from './db/session-state.js';
import { GENERIC_FAILURE_NOTICE } from './formatter.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';
import { MAX_QUOTA_DEFERRALS, ProviderChain } from './provider-fallback.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;
const CODEX_USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 3:43 PM.";

function insertMessage(id: string, tries = 0): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, tries, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, ?, 'channel-1', 'slack', 'thread-a', ?)`,
    )
    .run(id, new Date().toISOString(), tries, JSON.stringify({ text: id }));
}

function ackStatus(id: string): string | undefined {
  return (
    getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined
  )?.status;
}

function chatRows() {
  return getUndeliveredMessages().filter((row) => row.kind === 'chat');
}

/** A provider whose every query fails the way Codex does on an exhausted ChatGPT plan. */
function quotaFailingProvider(counter: { queries: number }, before: ProviderEvent[] = []): AgentProvider {
  return {
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    query: () => {
      counter.queries += 1;
      return {
        events: (async function* () {
          for (const event of before) yield event;
          yield { type: 'error', message: CODEX_USAGE_LIMIT, retryable: false, classification: 'quota' };
          throw new Error(CODEX_USAGE_LIMIT);
        })(),
        push: () => {},
        end: () => {},
        abort: () => {},
      };
    },
  } as AgentProvider;
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
     VALUES ('main', 'Main', 'channel', 'slack', 'channel-1')`,
  );
});
afterEach(() => closeSessionDb());

describe('quota fallback in the poll loop', () => {
  it('Codex out of quota: records the cooldown, defers the batch without a notice, and restarts', async () => {
    insertMessage('ingest-1');
    const counter = { queries: 0 };
    const exit = await runPollLoop({
      provider: quotaFailingProvider(counter),
      providerContract: CONTRACT,
      providerName: 'codex',
      providerChain: new ProviderChain(['codex', 'claude']),
      cwd: '/tmp',
    });

    expect(exit).toBe('provider-switch');
    expect(counter.queries).toBe(1);
    expect(getQuotaCooldown('codex')).toBeDefined();
    expect(getQuotaCooldown('claude')).toBeUndefined();
    // Handed back for a few seconds, not acked completed, and nobody told it failed.
    const status = ackStatus('ingest-1')!;
    expect(status.startsWith('deferred:')).toBe(true);
    expect(Date.parse(status.slice('deferred:'.length)) - Date.now()).toBeLessThan(60_000);
    expect(chatRows()).toHaveLength(0);
    // Not visible to this runner again until the deferral passes.
    expect(getPendingMessages().map((m) => m.id)).not.toContain('ingest-1');
  });

  it('every provider out: holds the batch until the earliest reset and tells the sender once', async () => {
    insertMessage('ingest-2');
    const claudeBack = new Date(Date.now() + 2 * 60 * 60 * 1000);
    setQuotaCooldown('claude', claudeBack.toISOString());
    const exit = await runPollLoop({
      provider: quotaFailingProvider({ queries: 0 }),
      providerContract: CONTRACT,
      providerName: 'codex',
      providerChain: new ProviderChain(['codex', 'claude']),
      cwd: '/tmp',
    });

    expect(exit).toBe('provider-switch');
    const until = Date.parse(ackStatus('ingest-2')!.slice('deferred:'.length));
    // Codex said 3:43 PM (or the 30-minute default); either way no later than Claude's reset.
    expect(until).toBeLessThanOrEqual(claudeBack.getTime());
    expect(until).toBeGreaterThan(Date.now());
    const notices = chatRows();
    expect(notices).toHaveLength(1);
    const content = JSON.parse(notices[0].content) as { text: string; failureNotice?: boolean };
    expect(content.text).toContain('Codex and Claude are both out of quota');
    expect(content.failureNotice).toBe(true);
  });

  it('a provider still cooling down is never queried: the batch goes to the next one', async () => {
    insertMessage('ingest-3');
    setQuotaCooldown('codex', new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const counter = { queries: 0 };
    const exit = await runPollLoop({
      provider: quotaFailingProvider(counter),
      providerContract: CONTRACT,
      providerName: 'codex',
      providerChain: new ProviderChain(['codex', 'claude']),
      cwd: '/tmp',
    });

    expect(exit).toBe('provider-switch');
    expect(counter.queries).toBe(0);
    expect(ackStatus('ingest-3')?.startsWith('deferred:')).toBe(true);
  });

  it('a quota error after a reply went out fails normally instead of re-running the batch', async () => {
    insertMessage('ingest-4');
    const controller = new AbortController();
    const provider = quotaFailingProvider({ queries: 0 }, [
      { type: 'text', text: '<message to="main">Filed the first page.</message>' },
    ]);
    const original = provider.query.bind(provider);
    provider.query = (input) => {
      const query = original(input);
      return {
        ...query,
        events: (async function* () {
          try {
            yield* query.events;
          } finally {
            // After processQuery's catch has run (an abort first reads as a cancel).
            setTimeout(() => controller.abort(), 0);
          }
        })(),
      };
    };
    const exit = await runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'codex',
      providerChain: new ProviderChain(['codex', 'claude']),
      cwd: '/tmp',
      signal: controller.signal,
    });

    expect(exit).toBeUndefined();
    expect(ackStatus('ingest-4')).toBe('completed');
    const texts = chatRows().map((row) => (JSON.parse(row.content) as { text: string }).text);
    expect(texts).toContain('Filed the first page.');
    expect(texts).toContain(GENERIC_FAILURE_NOTICE);
  });

  it('after the deferral cap, the batch runs and fails like any other run', async () => {
    insertMessage('ingest-5', MAX_QUOTA_DEFERRALS);
    setQuotaCooldown('claude', new Date(Date.now() + 60 * 60 * 1000).toISOString());
    const controller = new AbortController();
    const provider = quotaFailingProvider({ queries: 0 });
    const original = provider.query.bind(provider);
    provider.query = (input) => {
      const query = original(input);
      return {
        ...query,
        events: (async function* () {
          try {
            yield* query.events;
          } finally {
            setTimeout(() => controller.abort(), 0);
          }
        })(),
      };
    };
    const exit = await runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'codex',
      providerChain: new ProviderChain(['codex', 'claude']),
      cwd: '/tmp',
      signal: controller.signal,
    });

    expect(exit).toBeUndefined();
    expect(ackStatus('ingest-5')).toBe('completed');
    const texts = chatRows().map((row) => (JSON.parse(row.content) as { text: string }).text);
    expect(texts).toEqual([GENERIC_FAILURE_NOTICE]);
  });

  it('releases a deferred claim once its time has passed', () => {
    insertMessage('ingest-6');
    insertMessage('ingest-7');
    getOutboundDb()
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('ingest-6', `deferred:${new Date(Date.now() - 1000).toISOString()}`, new Date().toISOString());
    getOutboundDb()
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('ingest-7', `deferred:${new Date(Date.now() + 60_000).toISOString()}`, new Date().toISOString());
    expect(getPendingMessages().map((m) => m.id)).toEqual(['ingest-6']);
  });
});

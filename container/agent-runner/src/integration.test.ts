import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation, getCurrentBatchRouting, setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import type { ProviderExchange } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
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

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('publishes routing only for messages that survive command and script filtering', async () => {
    const insertRouted = (
      id: string,
      seq: number,
      kind: 'chat' | 'task',
      channelType: string,
      platformId: string,
      content: object,
    ) => {
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in
             (id, seq, kind, timestamp, status, trigger, channel_type, platform_id, content)
           VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', 1, ?, ?, ?)`,
        )
        .run(id, seq, kind, channelType, platformId, JSON.stringify(content));
    };

    insertRouted('visible-peer', 2, 'chat', 'agent', 'ag-peer', { sender: 'Peer', text: 'handle this' });
    insertRouted('clear-command', 4, 'chat', 'agent', 'ag-command', { sender: 'Admin', text: '/clear' });
    insertRouted('gated-task', 6, 'task', 'agent', 'ag-task', {
      prompt: 'do not wake',
      script: `printf '%s\\n' '{"wakeAgent":false}'`,
    });

    let observed = false;
    let visibleRouting: ReturnType<typeof getCurrentBatchRouting>;
    let commandRouting: ReturnType<typeof getCurrentBatchRouting>;
    let gatedRouting: ReturnType<typeof getCurrentBatchRouting>;
    const provider = new MockProvider({}, () => {
      visibleRouting = getCurrentBatchRouting('agent', 'ag-peer');
      commandRouting = getCurrentBatchRouting('agent', 'ag-command');
      gatedRouting = getCurrentBatchRouting('agent', 'ag-task');
      observed = true;
      return '';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => observed, 3000);
    controller.abort();

    expect(visibleRouting).toEqual({ inReplyTo: 'visible-peer', threadId: null });
    expect(commandRouting).toBeNull();
    expect(gatedRouting).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage('m-discord', { sender: 'Alice', text: 'from discord' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' });
    insertMessage('m-slack', { sender: 'Bob', text: 'from slack' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' });

    // Agent replies to both destinations
    const provider = new MockProvider({}, () =>
      '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text produces no outbound messages (scratchpad only)', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    // Agent responds with bare text — no <message to="..."> wrapping
    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait long enough for the poll loop to process
    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Only the valid destination should produce output
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage('m1', { sender: 'Alice', text: 'tell slack' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage('m-old', { sender: 'Alice', text: 'old' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' });
    insertMessage('m-new', { sender: 'Alice', text: 'new' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' });

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('handles mixed task + chat batch with correct origin metadata', async () => {
    // Seed destination for routing lookup
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    // Task with same routing — simulates a scheduled task in a channel session
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('poll loop — exchange hook (onExchangeComplete)', () => {
  // A provider that declares the per-exchange hook. The hook call is the
  // wiring under test — these tests go red if the poll-loop seam is severed.
  // What the provider DOES with an exchange (e.g. write markdown into
  // conversations/) ships with the provider, not the runner.
  class HookedMockProvider extends MockProvider {
    readonly exchanges: ProviderExchange[] = [];
    onExchangeComplete(exchange: ProviderExchange): void {
      this.exchanges.push(exchange);
    }
  }

  it('reports each exchange to a provider that declares the hook', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'please archive this' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new HookedMockProvider({}, () => '<message to="discord-test">archived answer</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => provider.exchanges.length > 0, 2000);
    controller.abort();

    expect(provider.exchanges.length).toBe(1);
    const exchange = provider.exchanges[0];
    expect(exchange.prompt).toContain('please archive this');
    expect(exchange.result).toContain('archived answer');
    expect(exchange.continuation).toStartWith('mock-session-');
    expect(exchange.status).toBe('completed');

    await loopPromise.catch(() => {});
  });

  it('does not report the internal wrapping-retry nudge as a user prompt', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'wrap this later' }, { platformId: 'chan-1', channelType: 'discord' });

    let calls = 0;
    const provider = new HookedMockProvider({}, () => {
      calls += 1;
      // First result is unwrapped (triggers the retry nudge), second is wrapped.
      return calls === 1 ? 'unwrapped text' : '<message to="discord-test">wrapped now</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => provider.exchanges.length >= 2, 3000);
    controller.abort();

    // Both exchanges attribute themselves to the real user prompt, never the nudge.
    for (const exchange of provider.exchanges) {
      expect(exchange.prompt).not.toContain('Your response was not delivered');
      expect(exchange.prompt).toContain('wrap this later');
    }
    expect(provider.exchanges.map((e) => e.status)).toEqual(['undelivered', 'completed']);

    await loopPromise.catch(() => {});
  });

  it('a throwing hook never breaks delivery', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'still deliver this' }, { platformId: 'chan-1', channelType: 'discord' });

    class ThrowingHookProvider extends MockProvider {
      onExchangeComplete(): void {
        throw new Error('hook exploded');
      }
    }
    const provider = new ThrowingHookProvider({}, () => '<message to="discord-test">delivered anyway</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBe(1);
    expect(out[0].content).toContain('delivered anyway');

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — provider error recovery', () => {
  it('writes error to outbound and continues loop on provider throw', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');
    expect(JSON.parse(out[0].content).text).toContain('API rate limit exceeded');

    // Input message should be marked completed despite the error
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('routes a thrown provider error to the latest accepted follow-up batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'initial request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new FollowUpThrowingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(() => provider.started, 2000);
    insertMessage(
      'm2',
      { sender: 'Bob', text: 'follow-up request' },
      { platformId: 'chan-2', channelType: 'slack', threadId: 'thread-2' },
    );
    await waitFor(() => getUndeliveredMessages().length > 0, 3000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('chan-2');
    expect(out[0].thread_id).toBe('thread-2');
    expect(out[0].in_reply_to).toBe('m2');

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // Error was written to outbound
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');

    // Continuation was cleared (isSessionInvalid returned true)
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    setContinuation('mock', 'existing-session-id');
    expect(getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that throws on every query, simulating API failures.
 */
class ThrowingProvider {
  readonly supportsNativeSlashCommands = false;
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

class FollowUpThrowingProvider {
  readonly supportsNativeSlashCommands = false;
  started = false;

  isSessionInvalid(): boolean {
    return false;
  }

  query() {
    const owner = this;
    let pushed = false;
    let wake: (() => void) | null = null;
    return {
      push() {
        pushed = true;
        wake?.();
      },
      end() {},
      abort() {
        wake?.();
      },
      events: (async function* () {
        owner.started = true;
        yield { type: 'init' as const, continuation: 'follow-up-error-session' };
        if (!pushed) await new Promise<void>((resolve) => (wake = resolve));
        throw new Error('follow-up provider failure');
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  readonly supportsNativeSlashCommands = false;

  isSessionInvalid(): boolean {
    return true;
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}

describe('poll loop — slash command during active query', () => {
  // SKIPPED: hangs before the first provider query on GitHub Actions runners
  // only — 5 of 6 CI runs failed (the poll loop never issues the query within
  // 15s) while passing everywhere reproducible: macOS/arm64, Linux/arm64
  // (incl. 2-core pinned, TZ=UTC, bun --frozen-lockfile), and emulated
  // linux/amd64 — all on bun 1.3.12.
  // TODO: reproduce with in-loop diagnostics (pending rows + ack states per
  // tick) on a throwaway branch and fix the underlying race, then un-skip.
  it.skip(
    'aborts the active query when /clear arrives as a follow-up',
    async () => {
    insertMessage('m-active', { sender: 'Alice', text: 'long running request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new BlockingProvider();
    const controller = new AbortController();
    // Generous budgets: on resource-starved CI runners the poll loop can take
    // well over 2s to issue its first query, which made this test the only
    // deterministic CI failure while passing everywhere else (macOS + Linux
    // dev boxes run it in ~0.6s; success aborts the loop early, so the large
    // ceilings cost nothing on the happy path).
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 20000);

    await waitFor(() => provider.queries === 1, 15000);
    insertMessage('m-clear-active', { sender: 'Alice', text: '/clear' }, { platformId: 'chan-1', channelType: 'discord' });

    await waitFor(() => provider.aborts === 1, 15000);
    await waitFor(
      () => getUndeliveredMessages().some((msg) => JSON.parse(msg.content).text === 'Session cleared.'),
      15000,
    );
    controller.abort();

    expect(provider.ends).toBe(0);
    expect(getContinuation('mock')).toBeUndefined();
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
    },
    30000,
  );
});

/**
 * Provider whose query never completes until ended/aborted — for testing how
 * the loop interrupts an active stream.
 */
class BlockingProvider {
  readonly supportsNativeSlashCommands = false;
  queries = 0;
  aborts = 0;
  ends = 0;

  isSessionInvalid(): boolean {
    return false;
  }

  query() {
    const owner = this;
    this.queries += 1;
    let wake: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    return {
      push() {},
      end: () => {
        owner.ends += 1;
        ended = true;
        wake?.();
      },
      abort: () => {
        owner.aborts += 1;
        aborted = true;
        wake?.();
      },
      events: (async function* () {
        yield { type: 'activity' as const };
        yield { type: 'init' as const, continuation: 'blocking-session' };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })(),
    };
  }
}

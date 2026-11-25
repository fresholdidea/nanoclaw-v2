import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { deferredStatus, deferredUntil, parseProcessingAckRecord } from '../model.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './index.js';

/** Quota fallback: the runner hands a message back with `deferred:<ISO>`. */
describe('deferred processing acks', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup() {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);
    let sequence = 0;
    const nextSequence = () => (sequence += 2);
    const inbound = wrapSqliteInbound(inboundDb, nextSequence);
    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
      nextSequence,
    );
    inboundDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES ('in-1', 2, 'chat', '2026-11-24T19:11:53.241Z', 'pending', '{"text":"INGEST"}')`,
      )
      .run();
    const ack = (status: string) =>
      outboundDb
        .prepare('INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
        .run('in-1', status, '2026-11-24T19:12:02.000Z');
    const row = () =>
      inboundDb.prepare('SELECT status, process_after, tries FROM messages_in WHERE id = ?').get('in-1') as {
        status: string;
        process_after: string | null;
        tries: number;
      };
    const sync = () => inbound.applyProcessingAcks(outbound.getTerminalProcessingAcks());
    return { ack, row, sync, inbound };
  }

  it('parses a deferred status and rejects a malformed one', () => {
    const until = new Date('2026-11-24T20:43:00.000Z');
    expect(deferredStatus(until)).toBe('deferred:2026-11-24T20:43:00.000Z');
    expect(deferredUntil('deferred:2026-11-24T20:43:00.000Z')).toBe('2026-11-24T20:43:00.000Z');
    expect(deferredUntil('deferred:soon')).toBeUndefined();
    expect(deferredUntil('completed')).toBeUndefined();
    expect(
      parseProcessingAckRecord({
        messageId: 'in-1',
        status: 'deferred:2026-11-24T20:43:00.000Z',
        statusChanged: '2026-11-24T19:12:02.000Z',
      }).status,
    ).toBe('deferred:2026-11-24T20:43:00.000Z');
    expect(() =>
      parseProcessingAckRecord({
        messageId: 'in-1',
        status: 'deferred:soon',
        statusChanged: '2026-11-24T19:12:02.000Z',
      }),
    ).toThrow();
  });

  it('keeps the message pending until the requested time and counts one try', () => {
    const { ack, row, sync, inbound } = setup();
    ack('deferred:2999-11-24T20:43:00.000Z');
    sync();
    expect(row()).toEqual({ status: 'pending', process_after: '2999-11-24T20:43:00.000Z', tries: 1 });
    // Not due, so the host does not wake the session for it.
    expect(inbound.countDueMessages()).toBe(0);

    // The ack stays until the runner re-claims the row; later sweeps change nothing.
    sync();
    sync();
    expect(row().tries).toBe(1);
  });

  it('counts a new try for each new deferral, then completes normally', () => {
    const { ack, row, sync } = setup();
    ack('deferred:2026-11-24T19:12:07.000Z');
    sync();
    ack('deferred:2026-11-24T20:43:00.000Z');
    sync();
    expect(row()).toEqual({ status: 'pending', process_after: '2026-11-24T20:43:00.000Z', tries: 2 });
    ack('completed');
    sync();
    expect(row().status).toBe('completed');
  });

  it('never revives a message that already finished', () => {
    const { ack, row, sync } = setup();
    ack('completed');
    sync();
    ack('deferred:2999-01-01T00:00:00.000Z');
    sync();
    expect(row()).toEqual({ status: 'completed', process_after: null, tries: 0 });
  });
});

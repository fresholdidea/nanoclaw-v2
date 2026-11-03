import type { Migration } from './index.js';

/**
 * `thread_id` on `agent_destinations`: pin a channel destination to one
 * thread/topic of its messaging group.
 *
 * A destination names a chat. On threaded platforms an agent that lives in
 * one topic of a shared orchestrator room (topic-scoped wirings, migration
 * 024) needs its proactive sends — scheduled task output, cross-session
 * notices — to land in that topic rather than at the top level. NULL keeps
 * today's behaviour: replies follow the session thread, everything else
 * posts top-level. Non-null overrides the thread on every send through the
 * destination. Agent-target rows never carry a thread.
 */
export const migration025: Migration = {
  version: 25,
  name: 'destination-thread',
  async up(db) {
    await db.exec(`ALTER TABLE agent_destinations ADD COLUMN thread_id TEXT;`);
  },
};

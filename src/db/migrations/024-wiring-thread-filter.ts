import type { Migration } from './index.js';

/**
 * Per-wiring thread filter on `messaging_group_agents`.
 *
 * A wiring binds a whole messaging group to an agent. On threaded platforms
 * (Telegram forum topics, Slack threads) an operator may want ONE chat to
 * fan out by topic: an orchestrator agent answers everywhere except the
 * topics that belong to a specialist. `thread_filter` holds the exact
 * effective thread id (e.g. `telegram:-100123:4`) the wiring is scoped to — comma-separated for several.
 * NULL = unscoped, the pre-migration behaviour for every existing row. At
 * router fanout a scoped wiring engages only in its own thread, and when any
 * scoped wiring matches a message every unscoped wiring on the same
 * messaging group stands down for that message (src/router.ts).
 */
export const migration024: Migration = {
  version: 24,
  name: 'wiring-thread-filter',
  async up(db) {
    await db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN thread_filter TEXT;`);
  },
};

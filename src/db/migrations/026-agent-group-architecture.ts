import type { Migration } from './index.js';

/**
 * Agent architecture metadata on `agent_groups` — the org chart the host
 * knows about, so the dashboard and `ncl groups` can show it without
 * reading every group's CLAUDE.md.
 *
 * - `tier`       — orchestrator | account | specialist | worker | personal
 *                  (validated in code, see `src/db/agent-groups.ts`)
 * - `reports_to` — the agent group this one reports to (validated to exist
 *                  on write; no FK so a deleted parent never blocks the
 *                  cascade in `ncl groups delete`)
 * - `role`       — one-line role description
 * - `persona`    — JSON object: optional `emoji`, `color`, `initials`
 *
 * All nullable, no backfill: NULL = unclassified. One ALTER per column keeps
 * the statement portable across backends.
 */
export const migration026: Migration = {
  version: 26,
  name: 'agent-group-architecture',
  async up(db) {
    await db.exec(`ALTER TABLE agent_groups ADD COLUMN tier TEXT;`);
    await db.exec(`ALTER TABLE agent_groups ADD COLUMN reports_to TEXT;`);
    await db.exec(`ALTER TABLE agent_groups ADD COLUMN role TEXT;`);
    await db.exec(`ALTER TABLE agent_groups ADD COLUMN persona TEXT;`);
  },
};

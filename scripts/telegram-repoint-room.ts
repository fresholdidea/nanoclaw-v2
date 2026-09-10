#!/usr/bin/env tsx
/**
 * Re-point a Telegram messaging group at a new chat id.
 *
 * Enabling Topics on a plain Telegram group converts it to a supergroup and
 * Telegram assigns a NEW chat id (-100…). The messaging_groups row still holds
 * the old id, so every message from the room arrives as an unknown chat and
 * the room's wiring, sessions, and destinations go silently dark. This moves
 * the row's platform_id to the new id in place — wirings, sessions, and
 * destinations key on the row id, so they carry over untouched — and removes
 * any row the router auto-created for the new id in the meantime.
 *
 * Usage:
 *   pnpm exec tsx scripts/telegram-repoint-room.ts <old-platform-id> <new-platform-id> [--apply]
 *
 *   old-platform-id  e.g. telegram:-5292670198
 *   new-platform-id  e.g. telegram:-1001234567890   (must be a supergroup id)
 *
 * Dry-run by default; pass --apply to write. Restart nothing — the router
 * reads messaging_groups per message.
 */
import { CENTRAL_DB_PATH } from '../src/config.js';
import { getDb, initDb } from '../src/db/connection.js';
import type { MessagingGroup } from '../src/types.js';

const [, , oldId, newId, ...flags] = process.argv;
const apply = flags.includes('--apply');

function usage(msg: string): never {
  console.error(msg);
  console.error('Usage: pnpm exec tsx scripts/telegram-repoint-room.ts <old-platform-id> <new-platform-id> [--apply]');
  process.exit(2);
}

if (!oldId || !newId) usage('Both platform ids are required.');
if (!/^telegram:-\d+$/.test(oldId)) usage(`Old id must look like telegram:-<digits>, got ${oldId}`);
if (!/^telegram:-100\d{6,}$/.test(newId)) usage(`New id must be a supergroup id (telegram:-100…), got ${newId}`);

async function main(): Promise<void> {
  await initDb(CENTRAL_DB_PATH);
  const db = getDb();
  const rows = await db.all<MessagingGroup>(
    `SELECT * FROM messaging_groups WHERE channel_type = 'telegram' AND platform_id IN (?, ?)`,
    oldId,
    newId,
  );
  const oldRow = rows.find((r) => r.platform_id === oldId);
  const newRow = rows.find((r) => r.platform_id === newId);
  if (!oldRow) usage(`No messaging group has platform_id ${oldId}`);

  const wired = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messaging_group_agents WHERE messaging_group_id = ?`,
    oldRow.id,
  );
  console.log(`Old row ${oldRow.id} ("${oldRow.name ?? ''}") — ${wired[0]?.n ?? 0} wiring(s) — will move to ${newId}`);
  if (newRow) {
    const newWired = await db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messaging_group_agents WHERE messaging_group_id = ?`,
      newRow.id,
    );
    if ((newWired[0]?.n ?? 0) > 0) usage(`A row for ${newId} already exists AND has wirings (${newRow.id}); resolve by hand.`);
    console.log(`Auto-created row ${newRow.id} for ${newId} (no wirings) — will be deleted`);
  }

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write.');
    return;
  }
  if (newRow) await db.run(`DELETE FROM messaging_groups WHERE id = ?`, newRow.id);
  await db.run(`UPDATE messaging_groups SET platform_id = ? WHERE id = ?`, newId, oldRow.id);
  console.log(`Done. ${oldRow.id} now points at ${newId}. Send a message in the room to confirm the agent answers.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

import { readEnvFile } from '../env.js';
import { GROUPS_DIR, TIMEZONE } from '../config.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { resolveGroupTimezone } from '../container-config.js';
import { collectTaskSeries } from '../cli/resources/tasks.js';
import { createHudCollector } from './collect.js';
import type { TaskSeries } from './types.js';
const collect = createHudCollector();
let lastTasks: TaskSeries[] | null = null;
let tasksAsOf: string | null = null;
export async function collectDashboardHud(tokens: { daily?: Record<string, number>; asOf?: string | null }) {
  const env = readEnvFile([
    'HUD_PRIMARY_GROUP',
    'HUD_STEWARD_GROUP',
    'HUD_BILLING_GROUP',
    'HUD_INBOX_OPS_GROUP',
    'HUD_VAULT_DIR',
    'HUD_AD_METRICS_DB',
    'HUD_EXCLUSIONS',
  ]);
  const deadline = performance.now() + 200;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        const groups = await getAllAgentGroups();
        const metadata = new Map(
          await Promise.all(
            groups.map(async (g) => [g.id, { folder: g.folder, timezone: await resolveGroupTimezone(g.id) }] as const),
          ),
        );
        return (await collectTaskSeries(deadline - 100)).map((t) => ({
          ...t,
          status: t.status === 'paused' ? ('paused' as const) : ('pending' as const),
          ...metadata.get(t.agent_group_id),
        }));
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Task snapshot timeout')), 100);
      }),
    ]);
    lastTasks = result;
    tasksAsOf = new Date().toISOString();
  } catch {
    /* retain the previous task snapshot and its freshness */
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return collect(
    {
      groupsDir: GROUPS_DIR,
      primary: env.HUD_PRIMARY_GROUP,
      steward: env.HUD_STEWARD_GROUP,
      billing: env.HUD_BILLING_GROUP,
      inboxOps: env.HUD_INBOX_OPS_GROUP,
      vault: env.HUD_VAULT_DIR,
      adMetrics: env.HUD_AD_METRICS_DB,
      exclusions: env.HUD_EXCLUSIONS !== 'false',
    },
    { tokens, tasks: lastTasks, tasksAsOf, timezone: TIMEZONE, deadline },
  );
}

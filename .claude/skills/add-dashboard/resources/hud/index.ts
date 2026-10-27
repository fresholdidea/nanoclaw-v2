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
let refreshing: Promise<void> | null = null;
let refreshedAt = 0;
// Walking every task session's inbound.db takes ~0.3-1s with ~70 series, so it
// runs beside the push instead of inside the snapshot's 200ms budget.
const TASK_REFRESH_MS = 5 * 60_000;
const TASK_BUDGET_MS = 10_000;
const TASK_WAIT_MS = 150;
function refreshTasks(): Promise<void> {
  refreshing ??= (async () => {
    try {
      const groups = await getAllAgentGroups();
      const metadata = new Map(
        await Promise.all(
          groups.map(async (g) => [g.id, { folder: g.folder, timezone: await resolveGroupTimezone(g.id) }] as const),
        ),
      );
      lastTasks = (await collectTaskSeries(performance.now() + TASK_BUDGET_MS)).map((t) => ({
        ...t,
        status: t.status === 'paused' ? ('paused' as const) : ('pending' as const),
        ...metadata.get(t.agent_group_id),
      }));
      tasksAsOf = new Date().toISOString();
      refreshedAt = Date.now();
    } catch {
      /* retain the previous task snapshot and its freshness; retry within a minute */
      refreshedAt = Date.now() - TASK_REFRESH_MS + 60_000;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
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
  if (!refreshing && Date.now() - refreshedAt > TASK_REFRESH_MS) {
    const pending = refreshTasks();
    // The first push after a refresh starts gets its result when it is quick;
    // otherwise this snapshot keeps the previous series and the next one catches up.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>((r) => (timeout = setTimeout(r, TASK_WAIT_MS)))]);
    clearTimeout(timeout);
  }
  const deadline = performance.now() + 200;
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

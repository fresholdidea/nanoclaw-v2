import { CronExpressionParser } from 'cron-parser';
import type { TaskSeries } from '../types.js';
/** More than two of its own intervals past the scheduled run. One-shot tasks are never late. */
export function isLate(t: TaskSeries, now: Date): boolean {
  if (t.status !== 'pending' || !t.next_run) return false;
  try {
    const next = Date.parse(t.next_run);
    const cron = CronExpressionParser.parse(t.schedule, { currentDate: new Date(next), tz: t.timezone });
    const interval = cron.next().getTime() - next;
    return now.getTime() - next > 2 * interval;
  } catch {
    /* one-shot tasks have no cron interval */
    return false;
  }
}
export function taskHealth(tasks: TaskSeries[], now: Date, previous: Map<string, number>) {
  let failing = 0,
    overdue = 0,
    paused = 0;
  const detail: string[] = [];
  for (const t of tasks) {
    const key = `${t.agent_group_id}/${t.series_id}`;
    const failed = t.failed_runs > (previous.get(key) ?? t.failed_runs) || /failed/i.test(t.lastLine ?? '');
    previous.set(key, t.failed_runs);
    if (t.status === 'paused') paused++;
    const late = isLate(t, now);
    if (failed) failing++;
    if (late) overdue++;
    if (failed || late || t.status === 'paused')
      detail.push(
        `${t.folder ?? t.agent_group_id}/${t.series_id}: ${[failed && 'failing', late && 'overdue', t.status === 'paused' && 'paused'].filter(Boolean).join(', ')}|/dashboard/messages?agentGroupId=${encodeURIComponent(t.agent_group_id)}&sessionId=${encodeURIComponent(t.session_id)}`,
      );
  }
  return {
    value: `${failing} failing · ${overdue} overdue`,
    detail: [`${tasks.length} series · ${paused} paused`, ...detail],
  };
}

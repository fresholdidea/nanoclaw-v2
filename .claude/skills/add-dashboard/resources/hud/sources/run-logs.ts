import { zonedIso } from '../io.js';
import type { HudTickerItem, TaskSeries } from '../types.js';
export const ALLOWED =
  /^(client-dashboard|sos-source-requests|ci-watch|access-walls|overnight-changelog|cron-health|meeting-review|input-chase|work-queue|label-queue|morning-briefing|receivables-check)-/;
export function parseRunLog(text: string) {
  const lines = text.trim().split('\n').slice(-20);
  return lines.flatMap((line) => {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) — (.+)$/.exec(line);
    return m ? [{ stamp: m[1], text: m[2] }] : [];
  });
}
export function runLogItems(rows: ReturnType<typeof parseRunLog>, task: TaskSeries, timezone: string): HudTickerItem[] {
  return rows.flatMap((r) => {
    const t = zonedIso(r.stamp, task.timezone ?? timezone);
    return t
      ? [
          {
            t,
            source: `task:${task.folder ?? task.agent_group_id}/${task.series_id}`,
            level: /BLOCKED|failed|frozen|lock|overdue/i.test(r.text)
              ? ('alert' as const)
              : /alert|EROFS|401|revoked/i.test(r.text)
                ? ('warn' as const)
                : ('info' as const),
            text: r.text.slice(0, 240),
            href: `/dashboard/messages?agentGroupId=${encodeURIComponent(task.agent_group_id)}&sessionId=${encodeURIComponent(task.session_id)}`,
          },
        ]
      : [];
  });
}

import { frontmatter } from '../io.js';
import type { HudSkill, TaskSeries } from '../types.js';
const MAP: Record<string, string[]> = {
  invoicing: ['receivables-check'],
  'meeting-prep': ['meeting-prep-morning', 'meeting-prep-evening'],
  'plane-pm': ['label-queue'],
  'input-chase': ['input-chase'],
  'work-queue': ['work-queue'],
  'weekly-client-status': ['weekly-client-status'],
  'linkedin-community': ['linkedin-feed-monitor'],
  'meeting-assistant': ['meeting-review'],
  'cron-health': ['cron-health-audit'],
};
const PINNED = new Set(['morning-briefing', 'plane-pm', 'meeting-prep', 'invoicing']);
export function parseSkill(text: string) {
  const r = frontmatter(text);
  if (typeof r.name !== 'string' || typeof r.description !== 'string') throw new Error('Invalid skill');
  return {
    name: r.name,
    description: r.description,
    trigger: typeof r.metadata?.trigger === 'string' ? r.metadata.trigger : r.name,
    pull: r.metadata?.pull,
  };
}
export function skillTile(
  s: ReturnType<typeof parseSkill>,
  tasks: TaskSeries[],
  asOf: string | null,
  source: string,
): HudSkill {
  const prefixes = MAP[s.name] ?? [s.trigger.replace(/ (scheduled )?task.*$/, '')];
  const candidates = tasks.filter((t) => prefixes.some((p) => t.series_id.startsWith(p + '-')));
  // Prefer the next pending run when a skill has morning/evening series.
  const t = candidates.sort(
    (a, b) =>
      Number(a.status === 'paused') - Number(b.status === 'paused') ||
      (a.next_run ?? '9999').localeCompare(b.next_run ?? '9999'),
  )[0];
  return {
    name: s.name,
    description: s.description,
    pinned: PINNED.has(s.name),
    trigger: s.trigger,
    asOf,
    cadenceMin: 28800,
    source,
    ...(s.name === 'plane-pm' && !t ? { href: '#hud-card-plane' } : {}),
    ...(t
      ? {
          series: {
            id: t.series_id,
            group: t.agent_group_id,
            schedule: t.schedule,
            lastRun: t.last_run,
            nextRun: t.next_run,
            runs: t.runs,
            failedRuns: t.failed_runs,
            status: t.status,
            sessionId: t.session_id,
            lastLine: t.lastLine?.slice(0, 120) ?? null,
          },
        }
      : {}),
  };
}

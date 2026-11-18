/**
 * Integration health: one table, one row per thing that feeds the operator's
 * view, each with a verdict and the time it was last known.
 *
 * Nothing is probed here. Every row restates what a job that already runs has
 * recorded, so a row is only as fresh as its `asOf`; the page marks a row
 * whose record is old instead of trusting its verdict.
 */
import path from 'node:path';
import { SourceCache } from './io.js';
import { exclusionFilter } from './exclusions.js';
import { parseCollectorStates, readIngestRuns, type LaunchdJob } from './sources/health.js';
import { isLate } from './sources/tasks.js';
import { parseWalls } from './sources/walls.js';
import type { HudPaths } from './collect.js';
import type { HealthRow, HudHealth, TaskSeries } from './types.js';

export interface HealthInput {
  tasks: TaskSeries[] | null;
  tasksAsOf?: string | null;
  /** The last `launchctl list` read, or null where there is none (not macOS, or it failed). */
  launchd: { asOf: string | null; jobs: Map<string, LaunchdJob> | null; labels: string[] };
  /** The host's own issue-tracker reads, one per client project. */
  tracker: {
    configured: boolean;
    projects: Array<{ label: string; asOf: string | null; unavailable: boolean }>;
  } | null;
  now?: Date;
  deadline?: number;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const list = (names: string[], n = 6) =>
  names.slice(0, n).join(', ') + (names.length > n ? ` +${names.length - n} more` : '');
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
const ORDER = { down: 0, warn: 1, ok: 2 } as const;

export function createHealthCollector(cache = new SourceCache()) {
  return function collectHealth(paths: HudPaths, input: HealthInput): HudHealth {
    const now = input.now ?? new Date();
    cache.deadline = input.deadline ?? performance.now() + 100;
    const groupPath = (group: string | undefined, ...parts: string[]) =>
      group && /^[\w-]+$/.test(group) ? path.join(paths.groupsDir, group, ...parts) : undefined;
    const registry = cache.load(groupPath(paths.primary, 'scripts/client-dashboard/registry.json'), JSON.parse);
    const keep = exclusionFilter(registry.value, paths.exclusions !== false).keep;
    const rows: HealthRow[] = [];

    // Ad platforms: the latest ingest per client and platform.
    if (paths.adIngest) {
      const runs = cache.read(paths.adIngest, () => readIngestRuns(paths.adIngest!));
      if (!runs.value) {
        rows.push({
          id: 'ads',
          group: 'ads',
          label: 'Ad data ingest',
          status: 'down',
          detail: 'The ingest log could not be read.',
          asOf: null,
          cadenceMin: 1440,
          source: 'ad-metrics ingest_runs',
          unavailable: true,
        });
      }
      for (const r of (runs.value ?? []).filter(keep)) {
        rows.push({
          id: `ads:${slug(r.client)}:${slug(r.platform)}`,
          group: 'ads',
          label: `${r.client} · ${r.platform}`,
          status: r.status === 'ok' ? 'ok' : r.status === 'partial' ? 'warn' : 'down',
          detail:
            r.status === 'ok'
              ? `${r.rows.toLocaleString('en-US')} rows${r.through ? ` through ${r.through}` : ''}`
              : `Last ingest ${r.status === 'partial' ? 'was partial' : 'failed'}`,
          notes: r.status !== 'ok' && r.errors ? [clip(r.errors, 300)] : undefined,
          asOf: r.at,
          cadenceMin: 1440,
          source: 'ad-metrics ingest_runs',
          unavailable: runs.unavailable,
        });
      }
    }

    // The hourly client dashboard's own verdict on each of its sources.
    const currentFile = paths.vault ? path.join(paths.vault, '90-System/Client Dashboard/Current.md') : undefined;
    if (currentFile) {
      const current = cache.load(currentFile, parseCollectorStates);
      if (!current.value) {
        rows.push({
          id: 'collector',
          group: 'collector',
          label: 'Client dashboard run',
          status: 'down',
          detail: 'The latest client dashboard could not be read.',
          asOf: null,
          cadenceMin: 60,
          source: 'vault/90-System/Client Dashboard/Current.md',
          unavailable: true,
        });
      }
      for (const s of current.value?.sources ?? []) {
        const ok = s.ok.filter(keep),
          failed = s.failed.filter(keep);
        if (!ok.length && !failed.length) continue;
        const word = s.name.toLowerCase();
        rows.push({
          id: `collector:${slug(s.name)}`,
          group: 'collector',
          label: `${s.name} (client dashboard)`,
          status: !failed.length ? 'ok' : ok.length ? 'warn' : 'down',
          detail: failed.length
            ? `Could not be read for ${failed.length} of ${ok.length + failed.length}: ${list(failed)}`
            : `Read for all ${ok.length}`,
          notes: failed.length
            ? current
                .value!.reasons.filter((r) => r.toLowerCase().includes(word))
                .filter(keep)
                .slice(0, 3)
                .map((r) => clip(r, 300))
            : undefined,
          asOf: current.value!.asOf,
          validUntil: current.value!.validUntil,
          cadenceMin: 60,
          source: 'vault/90-System/Client Dashboard/Current.md',
          unavailable: current.unavailable,
        });
      }
    }

    // The host's own reads of the issue tracker.
    if (input.tracker) {
      const { configured, projects } = input.tracker;
      const unread = projects.filter((p) => p.unavailable || !p.asOf);
      const oldest =
        projects
          .map((p) => p.asOf)
          .filter((a): a is string => !!a)
          .sort()[0] ?? null;
      rows.push({
        id: 'tracker',
        group: 'tracker',
        label: 'Plane (issues on the Clients page)',
        status:
          !configured || (projects.length > 0 && unread.length === projects.length)
            ? 'down'
            : unread.length
              ? 'warn'
              : 'ok',
        detail: !configured
          ? 'Not configured on the host (PLANE_API_KEY, or the registry has no Plane address).'
          : unread.length
            ? `Could not be read for ${unread.length} of ${projects.length}: ${list(unread.map((p) => p.label))}`
            : `Read for all ${projects.length} projects`,
        // "Not configured" is a current fact, not a stale one.
        asOf: configured ? oldest : now.toISOString(),
        cadenceMin: 10,
        source: 'Plane API',
      });
    }

    // Background jobs on this machine.
    const { launchd } = input;
    for (const label of launchd.labels) {
      const job = launchd.jobs?.get(label);
      rows.push({
        id: `job:${slug(label)}`,
        group: 'jobs',
        label,
        status: !launchd.jobs ? 'warn' : !job ? 'down' : job.status === 0 ? 'ok' : 'down',
        detail: !launchd.jobs
          ? 'Job state could not be read.'
          : !job
            ? 'Not loaded.'
            : job.status === 0
              ? job.pid
                ? 'Running'
                : 'Last run succeeded'
              : `Last run exited with status ${job.status}`,
        asOf: launchd.asOf,
        cadenceMin: 10,
        source: 'launchctl list',
        unavailable: !launchd.jobs,
      });
    }

    // Scheduled agent tasks, as one row; the inbox lists the ones to act on.
    if (input.tasks) {
      const tasks = input.tasks.filter((t) => keep(`${t.folder ?? ''} ${t.series_id}`));
      const name = (t: TaskSeries) => `${t.folder ?? t.agent_group_id}/${t.series_id}`;
      const failing = tasks.filter((t) => /failed/i.test(t.lastLine ?? ''));
      const late = tasks.filter((t) => isLate(t, now));
      const paused = tasks.filter((t) => t.status === 'paused').length;
      rows.push({
        id: 'tasks',
        group: 'jobs',
        label: 'Scheduled agent tasks',
        status: failing.length || late.length ? 'warn' : 'ok',
        detail: `${tasks.length} series · ${failing.length} failing · ${late.length} overdue · ${paused} paused`,
        notes:
          failing.length || late.length
            ? [...failing.map((t) => `${name(t)}: failing`), ...late.map((t) => `${name(t)}: overdue`)].slice(0, 12)
            : undefined,
        asOf: input.tasksAsOf ?? null,
        cadenceMin: 10,
        source: 'task sessions',
      });
    }

    // Access the steward has recorded as blocked.
    const wallsFile = groupPath(paths.steward, 'walls.md');
    if (wallsFile) {
      const walls = cache.load(wallsFile, parseWalls);
      for (const w of (walls.value ?? []).filter(keep)) {
        rows.push({
          id: `wall:${slug(w.wall)}`,
          group: 'walls',
          label: clip(w.wall, 160),
          status: 'down',
          detail: clip(`Since ${w.since} · Blocks: ${w.blocks}`, 300),
          notes: w.action ? [clip(`To clear it: ${w.action}`, 300)] : undefined,
          asOf: walls.asOf,
          cadenceMin: 10080,
          source: `groups/${paths.steward}/walls.md`,
          unavailable: walls.unavailable,
        });
      }
    }

    const seen = new Set<string>();
    return {
      rows: rows
        .filter((r) => !seen.has(r.id) && !!seen.add(r.id))
        .map((r, n) => ({ r, n }))
        .sort((a, b) => ORDER[a.r.status] - ORDER[b.r.status] || a.n - b.n)
        .map(({ r }) => r)
        .slice(0, 200),
    };
  };
}

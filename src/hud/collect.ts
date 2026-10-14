import fs from 'node:fs';
import path from 'node:path';
import { SourceCache, files, iso, localDay, obsidian, zonedIso } from './io.js';
import { exclusionFilter } from './exclusions.js';
import { parseLedger, ledgerValue } from './sources/ledger.js';
import { parseWalls, wallsValue } from './sources/walls.js';
import { parseCurrent } from './sources/current-md.js';
import { readAds, adsValue } from './sources/ad-metrics.js';
import { parseUsageLedger, usageWeek } from './sources/usage.js';
import { taskHealth } from './sources/tasks.js';
import { ALLOWED, parseRunLog, runLogItems } from './sources/run-logs.js';
import { parseReview, reviewItem } from './sources/meeting-reviews.js';
import { parseCalendar, calendarEvents } from './sources/calendar-dump.js';
import { parseCarryover, sortDirectives } from './sources/carryover.js';
import { parseMeeting, nextMeeting } from './sources/meeting-notes.js';
import { parseSkill, skillTile } from './sources/skills.js';
import type { Hud, HudCard, TaskSeries } from './types.js';

export interface HudPaths {
  groupsDir: string;
  primary?: string;
  steward?: string;
  billing?: string;
  inboxOps?: string;
  vault?: string;
  adMetrics?: string;
  exclusions?: boolean;
}
export interface HudInput {
  tasks: TaskSeries[] | null;
  tasksAsOf?: string | null;
  tokens?: { daily?: Record<string, number>; asOf?: string | null };
  timezone: string;
  now?: Date;
  deadline?: number;
}
export function createHudCollector(cache = new SourceCache()) {
  const failureCounts = new Map<string, number>();
  return function collectHud(paths: HudPaths, input: HudInput): Hud {
    const now = input.now ?? new Date(),
      day = localDay(now, input.timezone);
    cache.deadline = input.deadline ?? performance.now() + 180;
    const groupPath = (group: string | undefined, ...parts: string[]) =>
      group && /^[\w-]+$/.test(group) ? path.join(paths.groupsDir, group, ...parts) : undefined;
    const primary = (...parts: string[]) => groupPath(paths.primary, ...parts);
    const source = (file?: string) =>
      file
        ? file.startsWith(paths.groupsDir + path.sep)
          ? `groups/${path.relative(paths.groupsDir, file)}`
          : paths.vault && file.startsWith(paths.vault + path.sep)
            ? `vault/${path.relative(paths.vault, file)}`
            : path.basename(file)
        : 'not configured';
    const registry = cache.load(primary('scripts/client-dashboard/registry.json'), JSON.parse);
    const filter = exclusionFilter(registry.value, paths.exclusions !== false),
      keep = filter.keep;
    const hud: Hud = {
      generatedAt: now.toISOString(),
      timezone: input.timezone,
      cards: [],
      ticker: [],
      skills: [],
      hiddenCount: 0,
      today: {
        asOf: null,
        cadenceMin: 1440,
        source: source(primary('out', `briefing-raw-${day}.md`)),
        events: [],
        directives: [],
        nextMeeting: null,
      },
    };
    const card = (
      id: HudCard['id'],
      label: string,
      file: string | undefined,
      cadenceMin: number,
      unit?: HudCard['unit'],
    ): HudCard => ({
      id,
      label,
      value: null,
      detail: [],
      asOf: null,
      source: source(file),
      cadenceMin,
      ...(unit ? { unit } : {}),
    });

    const ledgerFile = groupPath(paths.billing, 'invoices/DELIVERED-LEDGER.md');
    const ledger = cache.load(ledgerFile, parseLedger),
      receivables = card('receivables', 'Receivables', ledgerFile, 10080, '$');
    if (ledger.value)
      Object.assign(receivables, ledgerValue(ledger.value, now, keep), {
        asOf: ledger.asOf,
        unavailable: ledger.unavailable,
      });
    // Workspace reports are not served by the dashboard; Messages is the safe artifact route.
    const report = files(groupPath(paths.billing, 'reports'))
      .filter((f) => /receivables-.*\.md$/.test(f))
      .at(-1);
    if (report && keep(source(report))) receivables.detail.push(`Latest report: ${path.basename(report)}`);
    hud.cards.push(receivables);

    const ads = cache.read(paths.adMetrics, () => readAds(paths.adMetrics!)),
      spend = card('ad_spend', 'Ad spend MTD', paths.adMetrics, 1440, '$');
    const adValue = ads.value && adsValue(ads.value, day, keep);
    if (adValue) Object.assign(spend, adValue, { asOf: iso(adValue.asOf) ?? ads.asOf, unavailable: ads.unavailable });
    const watchdog = cache.load(
      paths.adMetrics ? path.join(path.dirname(paths.adMetrics), 'watchdog.txt') : undefined,
      (t) => t.trim(),
    );
    if (watchdog.value && keep(watchdog.value))
      hud.ticker.push({
        t: watchdog.asOf!,
        source: 'ad-metrics watchdog',
        level: 'warn',
        text: watchdog.value.slice(0, 240),
      });
    hud.cards.push(spend);

    const usage = card('usage', 'Tokens this week', 'snapshot.tokens', 1, 'tok');
    if (input.tokens?.asOf && input.tokens.daily) {
      const today = new Date(`${day}T00:00:00Z`),
        monday = new Date(today);
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const start = monday.toISOString().slice(0, 10);
      usage.value = Object.entries(input.tokens.daily)
        .filter(([d]) => d >= start && d <= day)
        .reduce((n, [, v]) => n + v, 0);
      usage.spark = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - 6 + i);
        return input.tokens!.daily![d.toISOString().slice(0, 10)] ?? 0;
      });
      usage.asOf = input.tokens.asOf;
      usage.detail.push('Observed Claude session tokens; no plan quota or Codex usage source.');
    }
    const usageLedger = cache.load(primary('memory/ops/usage-ledger.md'), parseUsageLedger);
    if (usageLedger.value) usage.detail.push(usageWeek(usageLedger.value, day, keep));
    hud.cards.push(usage);

    const tasks = (input.tasks ?? []).filter(keep).map((t) => ({ ...t }));
    for (const t of tasks) {
      const file = groupPath(t.folder, 'tasks', `${t.series_id}.md`);
      const rows = cache.load(file, parseRunLog);
      t.lastLine = rows.value?.at(-1)?.text;
      if (ALLOWED.test(t.series_id) && rows.value)
        hud.ticker.push(...runLogItems(rows.value.filter(keep), t, input.timezone).filter(keep));
    }
    const invoiceTask = tasks.find((t) => t.folder === paths.billing && t.series_id.startsWith('receivables-check-'));
    if (invoiceTask)
      receivables.href = `/dashboard/messages?agentGroupId=${encodeURIComponent(invoiceTask.agent_group_id)}&sessionId=${encodeURIComponent(invoiceTask.session_id)}`;
    const cron = card('cron', 'Cron health', 'task sessions', 1);
    if (input.tasks !== null)
      Object.assign(cron, taskHealth(tasks, now, failureCounts), { asOf: input.tasksAsOf ?? now.toISOString() });
    hud.cards.push(cron);

    const currentFile = paths.vault ? path.join(paths.vault, '90-System/Client Dashboard/Current.md') : undefined;
    const current = cache.load(currentFile, parseCurrent);
    const waiting = card('waiting', 'Waiting on Brad', currentFile, 60, 'n'),
      plane = card('plane', 'Plane for Brad', currentFile, 60, 'n');
    // Current.md publishes pre-aggregated counts. Reject the whole record on an exclusion hit.
    if (current.value && keep(current.value)) {
      const c = current.value;
      const meta = {
        asOf: c.asOf,
        validUntil: c.validUntil,
        unavailable: current.unavailable,
        href: obsidian(currentFile!, paths.vault),
      };
      Object.assign(waiting, meta, { value: c.waitingCount, detail: c.waiting });
      Object.assign(plane, meta, {
        value: c.open,
        detail: [`${c.overdue} overdue · ${c.due} due in 7 days`, ...c.planeDetail],
      });
    }
    hud.cards.push(waiting, plane);
    const wallsFile = groupPath(paths.steward, 'walls.md'),
      walls = cache.load(wallsFile, parseWalls),
      wallCard = card('walls', 'Access walls', wallsFile, 10080, 'n');
    if (walls.value)
      Object.assign(wallCard, wallsValue(walls.value, now, keep), { asOf: walls.asOf, unavailable: walls.unavailable });
    hud.cards.push(wallCard);

    for (const file of files(primary('meeting-reviews/pending')).filter((f) => f.endsWith('.json'))) {
      const review = cache.load(file, parseReview);
      if (review.value && keep(review.value)) hud.ticker.push(reviewItem(review.value, review.asOf!, paths.vault));
    }
    const changelog = cache.load(groupPath(paths.steward, 'ops14/changelog', `${day}.md`), (t) => t);
    const anomalies = changelog.value?.match(/^## Anomalies\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
    for (const line of anomalies?.split('\n').filter((l) => /^[-*] /.test(l)) ?? [])
      if (keep(line))
        hud.ticker.push({ t: changelog.asOf!, source: 'changelog', level: 'warn', text: line.slice(2, 242) });

    const calendarFile = primary('out', `briefing-raw-${day}.md`),
      calendar = cache.load(calendarFile, parseCalendar);
    if (calendar.value)
      Object.assign(hud.today, {
        events: calendarEvents(calendar.value, day, input.timezone, keep),
        asOf: calendar.value.pulledAt
          ? (zonedIso(calendar.value.pulledAt, input.timezone) ?? calendar.asOf)
          : calendar.asOf,
        unavailable: calendar.unavailable,
      });
    const directivesFile = primary('.state/briefing-carryover.json'),
      directives = cache.load(directivesFile, parseCarryover);
    const sorted = sortDirectives((directives.value ?? []).filter(keep));
    hud.today.directives = sorted.slice(0, 3);
    hud.today.directivesMore = Math.max(0, sorted.length - 3);
    hud.today.directivesFreshness = {
      asOf: directives.asOf,
      cadenceMin: 1440,
      source: source(directivesFile),
      unavailable: directives.unavailable,
    };
    const briefingTask = tasks.find((t) => t.folder === paths.primary && t.series_id.startsWith('morning-briefing-'));
    hud.today.directivesHref = briefingTask
      ? `/dashboard/messages?agentGroupId=${encodeURIComponent(briefingTask.agent_group_id)}&sessionId=${encodeURIComponent(briefingTask.session_id)}`
      : undefined;
    const meetingsDir = paths.vault
      ? path.join(paths.vault, '90-System/Timestamps/Meetings', day.slice(0, 4))
      : undefined;
    const notes = files(meetingsDir)
      .filter((f) => path.basename(f).startsWith(day) && f.endsWith('.md'))
      .flatMap((file) => {
        const n = cache.load(file, parseMeeting);
        return n.value && keep(n.value) && keep(file)
          ? [{ note: n.value, file, asOf: n.asOf, unavailable: n.unavailable }]
          : [];
      });
    hud.today.nextMeeting = nextMeeting(notes, now, day, input.timezone, paths.vault);
    hud.today.meetingFreshness = {
      asOf:
        notes
          .map((n) => n.asOf!)
          .sort()
          .at(-1) ?? null,
      cadenceMin: 1440,
      source: source(meetingsDir),
      unavailable: notes.some((n) => n.unavailable),
    };

    for (const dir of files(primary('skills'))) {
      const file = path.join(dir, 'SKILL.md'),
        s = cache.load(file, parseSkill);
      if (!s.value || !keep(s.value)) continue;
      let touched = s.asOf;
      // Skills are small; bounded traversal includes script edits in last-touched.
      const walk = (d: string, depth: number) => {
        if (depth > 4 || performance.now() > cache.deadline) return;
        for (const f of files(d)) {
          try {
            const st = fs.lstatSync(f);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) walk(f, depth + 1);
            else if (st.mtime.toISOString() > (touched ?? '')) touched = st.mtime.toISOString();
          } catch {
            /* keep known stamp */
          }
        }
      };
      walk(dir, 0);
      hud.skills.push({ ...skillTile(s.value, tasks, touched, source(file)), unavailable: s.unavailable });
    }
    // Final emission gate covers derived strings, paths, links and task metadata too.
    hud.cards = hud.cards.map((c) =>
      keep(c) ? c : { ...card(c.id, c.label, undefined, c.cadenceMin, c.unit), source: 'withheld' },
    );
    hud.skills = hud.skills.filter(keep);
    hud.ticker = hud.ticker
      .filter(keep)
      .sort((a, b) => b.t.localeCompare(a.t))
      .slice(0, 200);
    hud.today.events = hud.today.events.filter(keep);
    hud.today.directives = hud.today.directives.filter(keep);
    if (hud.today.nextMeeting && !keep(hud.today.nextMeeting)) hud.today.nextMeeting = null;
    hud.hiddenCount = filter.hiddenCount;
    return hud;
  };
}

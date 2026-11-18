/**
 * Readers for the integration health table. Each one turns a store some other
 * job already keeps into plain facts; health.ts decides what they mean.
 */
import Database from 'better-sqlite3';
import { frontmatter, iso } from '../io.js';

export interface IngestRun {
  client: string;
  platform: string;
  /** Worst status among the accounts of the latest run: ok | partial | error. */
  status: string;
  rows: number;
  through: string | null;
  errors: string | null;
  at: string | null;
}

// Accounts of one client and platform land seconds apart in the same run.
const SAME_RUN_MS = 15 * 60_000;
const RANK: Record<string, number> = { ok: 0, partial: 1, error: 2 };

/** The latest ingest per client and platform, from the ad-metrics ingest log. */
export function readIngestRuns(file: string): IngestRun[] {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 10 });
  try {
    const rows = db
      .prepare(
        'SELECT client, platform, status, rows, errors, date_to, ingested_at FROM ingest_runs ORDER BY id DESC LIMIT 2000',
      )
      .all() as Array<{
      client: string;
      platform: string;
      status: string;
      rows: number | null;
      errors: string | null;
      date_to: string | null;
      ingested_at: string;
    }>;
    return latestIngests(rows);
  } finally {
    db.close();
  }
}

/** `rows` newest first. */
export function latestIngests(
  rows: Array<{
    client: string;
    platform: string;
    status: string;
    rows: number | null;
    errors: string | null;
    date_to: string | null;
    ingested_at: string;
  }>,
): IngestRun[] {
  const latest = new Map<string, IngestRun & { ms: number }>();
  for (const r of rows) {
    if (typeof r.client !== 'string' || typeof r.platform !== 'string') continue;
    const ms = Date.parse(r.ingested_at);
    if (!Number.isFinite(ms)) continue;
    const key = `${r.client}\n${r.platform}`;
    const seen = latest.get(key);
    if (!seen) {
      latest.set(key, {
        client: r.client,
        platform: r.platform,
        status: r.status,
        rows: r.rows ?? 0,
        through: r.date_to,
        errors: r.errors || null,
        at: iso(r.ingested_at),
        ms,
      });
    } else if (seen.ms - ms <= SAME_RUN_MS) {
      seen.rows += r.rows ?? 0;
      if ((RANK[r.status] ?? 2) > (RANK[seen.status] ?? 2)) seen.status = r.status;
      seen.errors ??= r.errors || null;
    }
  }
  return [...latest.values()]
    .map(({ ms: _ms, ...run }) => run)
    .sort((a, b) => a.client.localeCompare(b.client) || a.platform.localeCompare(b.platform));
}

export interface CollectorStates {
  asOf: string;
  validUntil: string;
  /** Per source name as the dashboard prints it (Plane, Calendar, Ledger, ...). */
  sources: Array<{ name: string; ok: string[]; failed: string[] }>;
  /** The reasons the dashboard gave for a source it could not read. */
  reasons: string[];
}

/**
 * The per-source verdicts the hourly client dashboard prints under each
 * client: `Plane OK · Calendar OK · Ledger UNKNOWN · AM OK`.
 */
export function parseCollectorStates(text: string): CollectorStates {
  const fm = frontmatter(text);
  const asOf = iso(fm.published_at),
    validUntil = iso(fm.valid_until);
  if (!asOf || !validUntil) throw new Error('Invalid Current snapshot');
  const sources = new Map<string, { name: string; ok: string[]; failed: string[] }>();
  const reasons = new Set<string>();
  for (const section of text.split(/^## /m).slice(1)) {
    const lines = section.split('\n');
    const client = lines[0].trim();
    for (const line of lines.slice(1)) {
      const reason = /^[A-Z][\w ]{0,40} UNKNOWN — .+/.exec(line);
      if (reason) reasons.add(reason[0]);
      const verdicts = line
        .split(' · ')
        .map((part) => /^([A-Za-z][A-Za-z0-9 ]{0,30}) (OK|UNKNOWN|STALE|ERROR)$/.exec(part.trim()))
        .filter((m): m is RegExpExecArray => !!m);
      if (verdicts.length < 2) continue;
      for (const [, name, verdict] of verdicts) {
        const source = sources.get(name) ?? { name, ok: [], failed: [] };
        sources.set(name, source);
        (verdict === 'OK' ? source.ok : source.failed).push(client);
      }
    }
  }
  if (!sources.size) throw new Error('No source verdicts in Current snapshot');
  return { asOf, validUntil, sources: [...sources.values()], reasons: [...reasons] };
}

export interface LaunchdJob {
  /** Running now. */
  pid: number | null;
  /** Exit status of the last run; 0 is success. */
  status: number;
}

/** `launchctl list` output: PID, last exit status, label, tab separated. */
export function parseLaunchctl(stdout: string): Map<string, LaunchdJob> {
  const jobs = new Map<string, LaunchdJob>();
  for (const line of stdout.split('\n')) {
    const m = /^(-|\d+)\t(-?\d+)\t(\S+)$/.exec(line);
    if (m) jobs.set(m[3], { pid: m[1] === '-' ? null : +m[1], status: +m[2] });
  }
  return jobs;
}

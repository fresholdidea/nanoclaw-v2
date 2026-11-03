import Database from 'better-sqlite3';
import type { Keep } from '../exclusions.js';
export interface AdRow {
  date: string;
  client: string;
  platform: string;
  spend: number;
  fetched_at: string;
}
export function readAds(file: string): AdRow[] {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 10 });
  try {
    // Cache a bounded source window, recompute month/day boundaries on each push.
    const rows = db
      .prepare(
        'SELECT date, client, platform, SUM(spend) AS spend, MAX(fetched_at) AS fetched_at FROM campaign_daily GROUP BY date, client, platform ORDER BY date DESC LIMIT 20000',
      )
      .all() as AdRow[];
    if (!rows.length || rows.some((r) => !/^\d{4}-\d\d-\d\d$/.test(r.date) || !Number.isFinite(r.spend)))
      throw new Error('No usable spend rows');
    return rows;
  } finally {
    db.close();
  }
}
export function adsValue(rows: AdRow[], day: string, keep: Keep) {
  const visible = rows.filter(keep),
    month = day.slice(0, 7);
  const prior = new Date(`${month}-01T00:00:00Z`);
  prior.setUTCMonth(prior.getUTCMonth() - 1);
  const previousMonth = prior.toISOString().slice(0, 7);
  const current = visible.filter((r) => r.date.startsWith(month) && r.date <= day);
  if (!current.length) return null;
  const through = current
    .map((r) => r.date)
    .sort()
    .at(-1)!;
  const previous = visible
    .filter((r) => r.date.startsWith(previousMonth) && +r.date.slice(8) <= +through.slice(8))
    .reduce((n, r) => n + r.spend, 0);
  const value = current.reduce((n, r) => n + r.spend, 0);
  const clients = new Map<string, number>();
  for (const r of current) clients.set(r.client, (clients.get(r.client) ?? 0) + r.spend);
  const daily = new Map<string, number>();
  for (const r of visible.filter((r) => r.date <= through)) daily.set(r.date, (daily.get(r.date) ?? 0) + r.spend);
  const points = [...daily].sort(([a], [b]) => a.localeCompare(b)).slice(-14);
  // Missing dates have no trustworthy total. Omit a sparse spark rather than drawing zeroes.
  const complete =
    points.length >= 7 && points.every(([d], i) => !i || Date.parse(d) - Date.parse(points[i - 1][0]) === 86400000);
  const spark = complete ? points.map(([, n]) => n) : undefined;
  return {
    value,
    spark,
    asOf:
      current
        .map((r) => r.fetched_at)
        .sort()
        .at(-1) ?? null,
    detail: [`Data through ${through}`, ...[...clients].map(([c, n]) => `${c}: $${n.toFixed(2)}`)],
    ...(previous > 0
      ? { delta: { value: Math.round((value / previous - 1) * 100), label: '% vs same days last month' } }
      : {}),
  };
}

import { table } from '../io.js';
import type { Keep } from '../exclusions.js';
export function parseUsageLedger(text: string) {
  return table(text, 'Agent hops').map((r) => {
    if (r.length !== 7 || !/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(r[0]) || !/^\d+$/.test(r[3]) || !/^\d+$/.test(r[4]))
      throw new Error('Malformed usage row');
    return { date: r[0].slice(0, 10), run: r[1], status: r[2], items: +r[3], hops: +r[4], note: r[6] };
  });
}
export function usageWeek(rows: ReturnType<typeof parseUsageLedger>, day: string, keep: Keep) {
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const start = monday.toISOString().slice(0, 10),
    week = rows.filter(keep).filter((r) => r.date >= start && r.date <= day);
  return `${week.length} scheduled runs · ${week.reduce((n, r) => n + r.items, 0)} items · ${week.reduce((n, r) => n + r.hops, 0)} hops this week`;
}
export interface TokenEntry {
  timestamp: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
export function parseTokenJsonl(text: string): TokenEntry[] {
  if (!text.trim()) throw new Error('Empty token file');
  const entries: TokenEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line); // A partial write keeps the previous complete file snapshot.
    if (r.type !== 'assistant' || !r.message?.usage) continue;
    const u = r.message.usage;
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    entries.push({
      timestamp: typeof r.timestamp === 'string' ? r.timestamp : null,
      model: typeof r.message.model === 'string' ? r.message.model : 'unknown',
      inputTokens: count(u.input_tokens),
      outputTokens: count(u.output_tokens),
      cacheReadTokens: count(u.cache_read_input_tokens),
      cacheCreationTokens: count(u.cache_creation_input_tokens),
    });
  }
  return entries;
}

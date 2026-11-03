import { iso, localDay } from '../io.js';
import type { Keep } from '../exclusions.js';
import type { HudToday } from '../types.js';
export function parseCalendar(text: string) {
  const accounts: Array<{ account: string; items: any[] }> = [];
  for (const s of text.split(/^## Calendar — /m).slice(1)) {
    const account = s.split(',')[0].trim();
    const block = /```(?:json)?\s*\n([\s\S]*?)```/.exec(s);
    if (!block) throw new Error('Calendar JSON missing');
    const data = JSON.parse(block[1]);
    if (!Array.isArray(data.items)) throw new Error('Calendar items missing');
    accounts.push({ account, items: data.items });
  }
  if (!accounts.length) throw new Error('No calendar accounts');
  return Object.assign(accounts, { pulledAt: text.match(/Pulled[^\n]* at (\d{4}-\d\d-\d\d \d\d:\d\d)/)?.[1] });
}
export function calendarEvents(
  accounts: ReturnType<typeof parseCalendar>,
  day: string,
  timezone: string,
  keep: Keep,
): HudToday['events'] {
  const events: HudToday['events'] = [],
    seen = new Set<string>();
  for (const a of accounts) {
    if (!keep(a.account)) continue;
    for (const e of a.items) {
      if (!keep(e) || e.status === 'cancelled') continue;
      const start = e.start?.dateTime ?? e.start?.date,
        end = e.end?.dateTime ?? e.end?.date;
      if (typeof start !== 'string' || typeof end !== 'string' || !iso(start) || !iso(end)) continue;
      const eventDay = start.length === 10 ? start : localDay(new Date(start), timezone);
      const endDay = end.length === 10 ? end : localDay(new Date(end), timezone);
      if (eventDay > day || endDay < day || (end.length === 10 && endDay === day)) continue;
      const key = `${e.iCalUID ?? e.id ?? e.summary}/${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        start,
        end,
        title: String(e.summary ?? 'Untitled'),
        account: a.account,
        attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
        href: e.htmlLink,
      });
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

import { frontmatter, zonedIso, obsidian } from '../io.js';
import type { HudToday } from '../types.js';
export function parseMeeting(text: string) {
  const r = frontmatter(text);
  if (typeof r.date !== 'string' || r.time == null || !['prepped', 'held'].includes(r.status))
    throw new Error('Invalid meeting');
  return {
    date: r.date,
    time: String(r.time).padStart(5, '0'),
    title: String(r.title ?? r.company ?? ''),
    status: r.status,
    attendees: r.attendees,
  };
}
export function nextMeeting(
  rows: Array<{ note: ReturnType<typeof parseMeeting>; file: string }>,
  now: Date,
  day: string,
  timezone: string,
  vault?: string,
): HudToday['nextMeeting'] {
  return (
    rows
      .flatMap(({ note: n, file }) => {
        const start = zonedIso(`${n.date} ${n.time}`, timezone);
        return n.date === day && start && Date.parse(start) >= now.getTime()
          ? [
              {
                start,
                title:
                  n.title ||
                  file
                    .split('/')
                    .at(-1)!
                    .replace(/^\d{4}-\d\d-\d\d |\.md$/g, ''),
                status: n.status,
                prepHref: obsidian(file, vault),
              },
            ]
          : [];
      })
      .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null
  );
}

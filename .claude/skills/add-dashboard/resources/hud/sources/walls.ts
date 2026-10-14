import { table } from '../io.js';
import type { Keep } from '../exclusions.js';
export function parseWalls(text: string) {
  const section = text.match(/^## Open\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  if (!section) throw new Error('Missing Open section');
  return table(section, 'Wall').map((r) => {
    if (r.length < 5) throw new Error('Malformed wall');
    return { wall: r[1], since: r[2], blocks: r[3], action: r[4] };
  });
}
export function wallsValue(rows: ReturnType<typeof parseWalls>, now: Date, keep: Keep) {
  const visible = rows.filter(keep);
  const dates = visible.map((r) => /^\d{4}-\d\d-\d\d/.exec(r.since)?.[0]).filter(Boolean) as string[];
  const oldest = dates.sort()[0];
  return {
    value: visible.length,
    detail: [
      ...(oldest ? [`Oldest: ${Math.floor((now.getTime() - Date.parse(oldest)) / 86400000)} days`] : []),
      ...visible.map((r) => `${r.wall} · Blocks: ${r.blocks} · Brad: ${r.action}`),
    ],
  };
}

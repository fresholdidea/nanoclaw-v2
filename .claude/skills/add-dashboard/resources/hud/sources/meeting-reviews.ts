import { iso, obsidian } from '../io.js';
import type { HudTickerItem } from '../types.js';
export function parseReview(text: string) {
  const r = JSON.parse(text);
  if (typeof r.meeting !== 'string' || !Array.isArray(r.items)) throw new Error('Malformed review');
  return r as {
    meeting: string;
    date: string;
    created_at?: string;
    items: unknown[];
    source_files?: { action_items?: string };
  };
}
export function reviewItem(r: ReturnType<typeof parseReview>, asOf: string, vault?: string): HudTickerItem {
  return {
    t: iso(r.created_at) ?? asOf,
    source: 'meeting-review',
    level: 'warn',
    text: `${r.items.length} action items from ${r.meeting} (${r.date}) await approve/drop`.slice(0, 240),
    href: r.source_files?.action_items ? obsidian(r.source_files.action_items, vault) : undefined,
  };
}

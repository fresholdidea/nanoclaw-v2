import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { SourceResult } from './types.js';

/** Failed reads keep the last good value and its original timestamp. No write handles. */
export class SourceCache {
  constructor(private readonly maxFileBytes = 16 * 1024 * 1024) {}
  private entries = new Map<string, { stamp: string; result: SourceResult<unknown> }>();
  deadline = Infinity;
  load<T>(file: string | undefined, parser: (text: string) => T): SourceResult<T> {
    return this.read(file, () => parser(fs.readFileSync(file!, 'utf8')));
  }
  read<T>(file: string | undefined, reader: () => T): SourceResult<T> {
    if (!file) return { value: null, asOf: null };
    const previous = this.entries.get(file);
    try {
      if (performance.now() > this.deadline) throw new Error('HUD budget exhausted');
      const stat = fs.statSync(file);
      if (!stat.isFile() || (stat.size > this.maxFileBytes && !file.endsWith('.db'))) throw new Error('Invalid source');
      // SQLite WAL changes do not necessarily touch the main file.
      let wal = '';
      if (file.endsWith('.db')) {
        try {
          const s = fs.statSync(file + '-wal');
          wal = `:${s.mtimeMs}:${s.size}`;
        } catch {
          /* no WAL */
        }
      }
      const stamp = `${stat.mtimeMs}:${stat.size}${wal}`;
      if (previous?.stamp === stamp) return previous.result as SourceResult<T>;
      const value = reader();
      const result = { value, asOf: stat.mtime.toISOString() };
      this.entries.set(file, { stamp, result });
      return result;
    } catch {
      return { ...((previous?.result as SourceResult<T>) ?? { value: null, asOf: null }), unavailable: true };
    }
  }
}
export function files(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}
export function frontmatter(text: string): Record<string, any> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error('Missing frontmatter');
  const result = parse(m[1]);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid frontmatter');
  return result;
}
export function table(text: string, header: string): string[][] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('|') && l.includes(header));
  if (start < 0 || !/^\|[\s:|-]+\|\s*$/.test(lines[start + 1] ?? '')) throw new Error('Missing table');
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .slice(1, line.lastIndexOf('|'))
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
  }
  if (!rows.length) throw new Error('Empty or truncated table');
  return rows;
}
export function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function localDay(now: Date, timezone: string): string {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timezone, formatter);
  }
  return formatter.format(now);
}
/** Convert a wall-clock stamp in an IANA zone, including DST, without depending on host TZ. */
export function zonedIso(stamp: string, timezone: string): string | null {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)(?::\d\d)?$/.exec(stamp);
  if (!m) return iso(stamp);
  const target = Date.parse(`${m[1]}T${m[2]}:00Z`);
  let ms = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(ms);
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    ms += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function obsidian(file: string, vault?: string): string | undefined {
  if (!vault) return undefined;
  let relative = file.replace(/^\/workspace\/extra\/obsidian\//, '');
  if (path.isAbsolute(relative)) relative = path.relative(vault, relative);
  if (relative.startsWith('..')) return undefined;
  return `obsidian://open?vault=${encodeURIComponent(path.basename(vault))}&file=${encodeURIComponent(relative)}`;
}
export function linkLine(line: string): string {
  const m = /\[([^\]]+)\]\((https:\/\/[^)]+)\)/.exec(line);
  return m ? `${line.replace(m[0], m[1])}|${m[2]}` : line;
}

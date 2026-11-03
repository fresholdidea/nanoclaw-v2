import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import { SourceCache, zonedIso } from '../io.js';
import { exclusionFilter } from '../exclusions.js';
import { createHudCollector } from '../collect.js';
import { parseLedger, ledgerValue } from './ledger.js';
import { parseWalls, wallsValue } from './walls.js';
import { parseCurrent } from './current-md.js';
import { readAds, adsValue } from './ad-metrics.js';
import { parseCalendar, calendarEvents } from './calendar-dump.js';
import { parseCarryover, sortDirectives } from './carryover.js';
import { parseMeeting, nextMeeting } from './meeting-notes.js';
import { parseReview, reviewItem } from './meeting-reviews.js';
import { parseRunLog, runLogItems } from './run-logs.js';
import { parseSkill, skillTile } from './skills.js';
import { parseUsageLedger, usageWeek, parseTokenJsonl } from './usage.js';
import { taskHealth } from './tasks.js';
import type { TaskSeries } from '../types.js';
const NOW = new Date('2026-10-14T15:00:00Z'),
  keep = () => true;
const ledger =
  '| Client | Invoice | Period | Amount | Prepared | Delivered | Sent to client |\n|---|---|---|---|---|---|---|\n| Visible | 1 | Oct | $1,200.00 | x | x | ✅ 2026-10-01 |\n| Paid | 2 | Oct | $400.00 | x | x | ✅ 💵 |\n| Draft | 3 | Oct | $200.00 | x | x | DRAFT, not sent |\n| Vast.Dev | 4 | Oct | $9,000.00 | x | x | ✅ 2026-10-01 |';
const task: TaskSeries = {
  agent_group_id: 'ag-1',
  session_id: 's-1',
  series_id: 'morning-briefing-abc',
  folder: 'primary',
  status: 'pending',
  schedule: '0 * * * *',
  runs: 5,
  failed_runs: 2,
  last_run: null,
  next_run: '2026-10-14T10:00:00Z',
  timezone: 'America/New_York',
};
const current = `---\npublished_at: 2026-10-14T12:00:00Z\nvalid_until: 2026-10-14T13:30:00Z\n---\n**2 clients** · 1 items waiting on Brad\n## Brad — my work\n**Plane · 9 open assigned to me · 2 overdue · 1 due in 7 days**\nOverdue (2)\n- [A-1](https://app.plane.so/one) First\n- [A-2](https://app.plane.so/two) Second\nDue in 7 days (1)\n- Later\n## Client\n**Waiting on Brad**\n- Approve\n\n**Waiting on client**\n- Other\n`;
describe('HUD sources', () => {
  it('weekly usage sums only current-week visible rows; token entries retain timestamps', () => {
    const rows = parseUsageLedger(
      '| When | Run | Status | Items | Agent hops | Minutes | Note |\n|---|---|---|---|---|---|---|\n| 2026-10-12 01:00 | work | ok | 2 | 3 | 4 | review |\n| 2026-10-01 01:00 | work | ok | 8 | 9 | 4 | old |',
    );
    expect(usageWeek(rows, '2026-10-14', keep)).toBe('1 scheduled runs · 2 items · 3 hops this week');
    const entries = parseTokenJsonl(
      JSON.stringify({
        type: 'assistant',
        timestamp: NOW.toISOString(),
        message: { model: 'claude', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    );
    expect(entries[0]).toMatchObject({ timestamp: NOW.toISOString(), inputTokens: 10, outputTokens: 5 });
    expect(() => parseTokenJsonl('{partial')).toThrow();
  });
  it('ledger buckets unpaid invoices by age, oldest first', () => {
    const rows = parseLedger(
      ledger
        .replace('| Vast.Dev | 4 |', '| Old | 4 |')
        .replace('$9,000.00 | x | x | ✅ 2026-10-01', '$500.00 | x | x | ✅ 2026-08-01') +
        '\n| Mid | 5 | Oct | $300.00 | x | x | ✅ 2026-09-10 |\n| Undated | 6 | Oct | $50.00 | x | x | ✅ sent |',
    );
    const result = ledgerValue(rows, NOW, () => true);
    expect(result.value).toBe(2050);
    expect(result.detail).toEqual([
      'Aging · 61+ days: $500 (1) · 31–60 days: $300 (1) · 0–30 days: $1,200 (1) · undated: $50 (1)',
      'Old #4: $500 · 74 days since sent',
      'Mid #5: $300 · 34 days since sent',
      'Visible #1: $1,200 · 13 days since sent',
      'Undated #6: $50',
      'Draft: $200 draft awaiting approval',
    ]);
  });
  it('ledger counts only sent/unpaid visible rows, keeps drafts separate', () => {
    const f = exclusionFilter(null);
    const result = ledgerValue(parseLedger(ledger), NOW, f.keep);
    expect(result.value).toBe(1200);
    expect(result.detail).toEqual([
      'Aging · 0–30 days: $1,200 (1)',
      'Visible #1: $1,200 · 13 days since sent',
      'Draft: $200 draft awaiting approval',
    ]);
    expect(f.hiddenCount).toBe(1);
    expect(() => parseLedger(ledger.replace('$1,200.00', 'unknown'))).toThrow();
  });
  it('an empty watchdog clears a previous warning, while empty tables stay missing', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-watchdog-')), 'watchdog.txt'),
      cache = new SourceCache();
    fs.writeFileSync(file, 'failed');
    expect(cache.load(file, (t) => t.trim()).value).toBe('failed');
    fs.writeFileSync(file, '');
    expect(cache.load(file, (t) => t.trim()).value).toBe('');
    expect(() => parseLedger(ledger.split('\n').slice(0, 2).join('\n'))).toThrow();
    expect(() => parseCurrent(current.split('## Client')[0])).toThrow();
  });

  it('walls count rows rather than their IDs and skip unparseable ages', () => {
    const rows = parseWalls(
      '## Open\n\n| # | Wall | Since | Blocks | Brad must |\n|---|---|---|---|---|\n| 1 | A | 2026-10-01 | B | C |\n| 3 | D | never worked | E | F |\n\n## Cleared\n',
    );
    expect(wallsValue(rows, NOW, keep)).toEqual({
      value: 2,
      detail: ['Oldest: 13 days', 'A · Blocks: B · Brad: C', 'D · Blocks: E · Brad: F'],
    });
  });
  it('Current retains explicit expiry and captures all overdue links', () => {
    const r = parseCurrent(current);
    expect(r.waitingCount).toBe(1);
    expect(r.waiting).toEqual(['Client: Approve']);
    expect(r.open).toBe(9);
    expect(r.planeDetail).toHaveLength(2);
    expect(r.planeDetail[1]).toContain('|https://app.plane.so/two');
    expect(r.validUntil).toBe('2026-10-14T13:30:00.000Z');
  });
  it('calendar dedupes accounts, removes cancelled/excluded events, respects local day', () => {
    const event = {
      iCalUID: 'a',
      summary: 'Review',
      start: { dateTime: '2026-10-15T01:00:00Z' },
      end: { dateTime: '2026-10-15T02:00:00Z' },
      attendees: [],
    };
    const input = parseCalendar(
      '## Calendar — one@example.com, next 8 days\n```json\n' +
        JSON.stringify({
          items: [event, { ...event, iCalUID: 'b', summary: 'Vast.Dev' }, { ...event, status: 'cancelled' }],
        }) +
        '\n```\n## Calendar — two@example.com, next 8 days\n```\n' +
        JSON.stringify({ items: [event] }) +
        '\n```',
    );
    expect(calendarEvents(input, '2026-10-14', 'America/New_York', exclusionFilter(null).keep)).toHaveLength(1);
    expect(() => parseCalendar('## Calendar — a\n```\n{"error":401}\n```')).toThrow();
  });
  it('directives drop resolved items and sort escalations then deadlines', () => {
    const result = sortDirectives(
      parseCarryover(
        JSON.stringify({
          a: { title: 'Soon', cls: 'action', appearances: 1, deadline: '2026-10-15' },
          b: { title: 'ESCALATE', cls: 'access', appearances: 4 },
          c: { title: 'Done', cls: 'decision', appearances: 8, resolved: true },
        }),
      ),
    );
    expect(result.map((r) => r.key)).toEqual(['b', 'a']);
  });
  it('meeting note times and run logs use the group timezone, including DST', () => {
    expect(zonedIso('2026-10-14 12:00', 'America/New_York')).toBe('2026-10-14T16:00:00.000Z');
    expect(zonedIso('2026-12-14 12:00', 'America/New_York')).toBe('2026-12-14T17:00:00.000Z');
    const note = parseMeeting('---\ndate: 2026-10-14\ntime: "12:00"\nstatus: prepped\ncompany: Review\n---\n');
    expect(
      nextMeeting([{ note, file: '/vault/meeting.md' }], NOW, '2026-10-14', 'America/New_York', '/vault')?.prepHref,
    ).toContain('file=meeting.md');
    const items = runLogItems(parseRunLog('2026-10-14 10:01 — failed: lock\n2026-10-14 10:02 — EROFS\n'), task, 'UTC');
    expect(items.map((i) => i.level)).toEqual(['alert', 'warn']);
    expect(items[0].t).toBe('2026-10-14T14:01:00.000Z');
  });
  it('review deep links translate container vault paths and counts pending actions', () => {
    const r = parseReview(
      JSON.stringify({
        meeting: 'Review',
        date: '2026-10-01',
        items: [{}],
        source_files: { action_items: '/workspace/extra/obsidian/Notes/Review.md' },
      }),
    );
    const item = reviewItem(r, NOW.toISOString(), '/vault/JBH');
    expect(item.text).toMatch(/^1 action items/);
    expect(item.href).toBe('obsidian://open?vault=JBH&file=Notes%2FReview.md');
  });
  it('skills map scheduled work, retain on-demand triggers, and pin useful actions', () => {
    const s = parseSkill(
      '---\nname: morning-briefing\ndescription: Morning brief\nmetadata:\n  trigger: morning-briefing scheduled task\n---',
    );
    expect(skillTile(s, [task], null, 'skill').series?.id).toBe(task.series_id);
    expect(skillTile(s, [], null, 'skill').pinned).toBe(true);
  });
  it('cron detects newly failed, overdue and paused series without counting historic failures as new', () => {
    const prev = new Map<string, number>();
    expect(taskHealth([task], NOW, prev).value).toBe('0 failing · 1 overdue');
    expect(taskHealth([{ ...task, failed_runs: 3, status: 'paused' }], NOW, prev)).toMatchObject({
      value: '1 failing · 0 overdue',
      detail: expect.arrayContaining(['1 series · 1 paused']),
    });
  });
  it('ad metrics reads SQLite without writes, compares months and excludes rows before summing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-ads-')),
      file = path.join(dir, 'all.db');
    const db = new Database(file);
    db.exec(
      "CREATE TABLE campaign_daily(date,client,platform,spend,fetched_at); INSERT INTO campaign_daily VALUES ('2026-10-13','Client','google',100,'2026-10-14T11:00:00Z'),('2026-09-13','Client','google',50,'2026-09-14T11:00:00Z'),('2026-10-13','Vast.Dev','google',900,'2026-10-14T11:00:00Z')",
    );
    db.close();
    const value = adsValue(readAds(file), '2026-10-14', exclusionFilter(null).keep);
    expect(value?.value).toBe(100);
    expect(value?.delta?.value).toBe(100);
    expect(value?.spark).toBeUndefined();
    expect(adsValue(readAds(file), '2027-01-01', keep)).toBeNull();
  });
  it('missing configuration produces seven nulls, never fabricated zeroes', () => {
    const hud = createHudCollector()({ groupsDir: '/absent' }, { tasks: null, timezone: 'UTC', now: NOW });
    expect(hud.cards).toHaveLength(7);
    expect(hud.cards.every((c) => c.value === null)).toBe(true);
  });
  it('cache retains last good values and stamps on removal, truncation, malformed data and EACCES', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-cache-')),
      file = path.join(dir, 'value.json'),
      cache = new SourceCache();
    fs.writeFileSync(file, '{"n":4}');
    const first = cache.load(file, JSON.parse);
    for (const body of ['', '{bad']) {
      fs.writeFileSync(file, body);
      expect(cache.load(file, JSON.parse)).toEqual({ ...first, unavailable: true });
    }
    fs.renameSync(file, file + '.retired');
    expect(cache.load(file, JSON.parse)).toEqual({ ...first, unavailable: true });
    const stat = vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'EACCES' });
    });
    expect(cache.load(file, JSON.parse)).toEqual({ ...first, unavailable: true });
    stat.mockRestore();
  });
  it('exclusions normalize punctuation and nested values; opt-out is explicit', () => {
    expect(exclusionFilter(null).keep({ url: 'https://vast.dev/a' })).toBe(false);
    expect(exclusionFilter(null).keep('GROWING---WELLNESS')).toBe(false);
    expect(exclusionFilter(null, false).keep('falcone')).toBe(true);
  });
});

import { table } from '../io.js';
import type { Keep } from '../exclusions.js';
export function parseLedger(text: string) {
  return table(text, 'Sent to client').map((r) => {
    if (r.length !== 7 || !/^\$[\d,]+(?:\.\d{2})?$/.test(r[3])) throw new Error('Malformed ledger row');
    return { client: r[0], invoice: r[1], amount: Number(r[3].replace(/[$,]/g, '')), status: r[6] };
  });
}
const BUCKETS = [
  { label: '61+ days', min: 61 },
  { label: '31–60 days', min: 31 },
  { label: '0–30 days', min: 0 },
];
const money = (n: number) => `$${n.toLocaleString('en-US')}`;
export function ledgerValue(rows: ReturnType<typeof parseLedger>, now: Date, keep: Keep) {
  let value = 0;
  const sent: Array<{ line: string; amount: number; days: number | null }> = [],
    drafts: string[] = [];
  for (const row of rows.filter(keep)) {
    if (row.status.startsWith('✅') && !row.status.includes('💵')) {
      value += row.amount;
      const date = row.status.match(/\d{4}-\d\d-\d\d/)?.[0];
      const days = date ? Math.max(0, Math.floor((now.getTime() - Date.parse(date)) / 86400000)) : null;
      sent.push({
        line: `${row.client} #${row.invoice}: ${money(row.amount)}${days === null ? '' : ` · ${days} days since sent`}`,
        amount: row.amount,
        days,
      });
    } else if (/DRAFT, not sent/i.test(row.status))
      drafts.push(`${row.client}: ${money(row.amount)} draft awaiting approval`);
  }
  // Oldest first, undated last: the long tail is what needs chasing (or marking paid).
  sent.sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
  const aging = [
    ...BUCKETS.map((b, i) => {
      const inBucket = sent.filter(
        (r) => r.days !== null && r.days >= b.min && (i === 0 || r.days < BUCKETS[i - 1].min),
      );
      return { label: b.label, rows: inBucket };
    }),
    { label: 'undated', rows: sent.filter((r) => r.days === null) },
  ]
    .filter((b) => b.rows.length)
    .map((b) => `${b.label}: ${money(b.rows.reduce((n, r) => n + r.amount, 0))} (${b.rows.length})`);
  const detail = [...(aging.length ? [`Aging · ${aging.join(' · ')}`] : []), ...sent.map((r) => r.line), ...drafts];
  return { value, detail };
}

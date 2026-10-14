import { table } from '../io.js';
import type { Keep } from '../exclusions.js';
export function parseLedger(text: string) {
  return table(text, 'Sent to client').map((r) => {
    if (r.length !== 7 || !/^\$[\d,]+(?:\.\d{2})?$/.test(r[3])) throw new Error('Malformed ledger row');
    return { client: r[0], invoice: r[1], amount: Number(r[3].replace(/[$,]/g, '')), status: r[6] };
  });
}
export function ledgerValue(rows: ReturnType<typeof parseLedger>, now: Date, keep: Keep) {
  let value = 0;
  const detail: string[] = [];
  for (const row of rows.filter(keep)) {
    if (row.status.startsWith('✅') && !row.status.includes('💵')) {
      value += row.amount;
      const date = row.status.match(/\d{4}-\d\d-\d\d/)?.[0];
      const days = date ? Math.max(0, Math.floor((now.getTime() - Date.parse(date)) / 86400000)) : null;
      detail.push(
        `${row.client} #${row.invoice}: $${row.amount.toLocaleString('en-US')}${days === null ? '' : ` · ${days} days since sent`}`,
      );
    } else if (/DRAFT, not sent/i.test(row.status))
      detail.push(`${row.client}: $${row.amount.toLocaleString('en-US')} draft awaiting approval`);
  }
  return { value, detail };
}

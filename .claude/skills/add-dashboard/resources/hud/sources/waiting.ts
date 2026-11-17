export interface WaitingRow {
  id: string;
  what: string;
  client?: string;
  blocks?: string;
  asked?: string;
  via?: string;
}
/** The input-chase ledger: a dict of asks keyed by id. Open asks not owned by someone external are "waiting on me". */
export function parseWaiting(text: string): WaitingRow[] {
  const ledger = JSON.parse(text);
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new Error('Malformed waiting-on ledger');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return Object.values(ledger as Record<string, Record<string, unknown>>)
    .filter(
      (r) => r && typeof r === 'object' && r.status === 'open' && String(r.owner ?? '').toLowerCase() !== 'external',
    )
    .flatMap((r) => {
      const id = str(r.id),
        what = str(r.what);
      return id && /^[\w-]{1,40}$/.test(id) && what
        ? [{ id, what, client: str(r.client), blocks: str(r.blocks), asked: str(r.asked), via: str(r.via) }]
        : [];
    })
    .sort((a, b) => (a.asked ?? '9').localeCompare(b.asked ?? '9'));
}

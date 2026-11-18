export interface ClientLogEntry {
  /** When the status line first appeared, ISO. */
  t: string;
  text: string;
}

const ENTRY = /^## Update [^\n]*\n[\s\S]*?^recorded_at: (\S+)[^\n]*\n[\s\S]*?^```\s*\n+([^\n]+)/gm;

/**
 * The status line of each Client Log entry, oldest first, with a run of
 * entries that say the same thing reduced to the first of them: the log gets
 * an entry whenever anything on the card moves, the status line far less often.
 * Read-only; the collector that writes the log freezes a file anyone else edits.
 */
export function parseClientLog(text: string, last = 12): ClientLogEntry[] {
  if (!/^type: client-log\s*$/m.test(text.slice(0, 400))) throw new Error('Not a client log');
  const changes: ClientLogEntry[] = [];
  for (const m of text.matchAll(ENTRY)) {
    const ms = Date.parse(m[1]);
    const line = m[2]
      .replace(/\*\*/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    if (!Number.isFinite(ms) || !line) continue;
    if (changes[changes.length - 1]?.text !== line) changes.push({ t: new Date(ms).toISOString(), text: line });
  }
  return changes.slice(-last);
}

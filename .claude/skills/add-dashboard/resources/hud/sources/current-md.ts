import { frontmatter, iso, linkLine } from '../io.js';
export function parseCurrent(text: string) {
  const fm = frontmatter(text);
  const asOf = iso(fm.published_at),
    validUntil = iso(fm.valid_until);
  const count = /\*\*(\d+) clients\*\*\s*·\s*(\d+) items waiting on Brad/.exec(text);
  const plane = /\*\*Plane · (\d+) open assigned to me · (\d+) overdue · (\d+) due in 7 days\*\*/.exec(text);
  if (!asOf || !validUntil || !count || !plane) throw new Error('Invalid Current snapshot');
  const waiting: string[] = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const client = section.split('\n')[0];
    if (/^Brad/.test(client)) continue;
    const part = section.match(/\*\*Waiting on Brad\*\*\s*\n([\s\S]*?)(?=\n\*\*|$)/)?.[1] ?? '';
    waiting.push(
      ...part
        .split('\n')
        .filter((l) => /^- /.test(l))
        .map((l) => `${client}: ${l.slice(2)}`),
    );
  }
  const overdue = text.match(/^Overdue \(\d+\)\n([\s\S]*?)(?=^Due in|^Next |^## |$(?![\s\S]))/m)?.[1] ?? '';
  const planeDetail = overdue
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => linkLine(l.slice(2)));
  if (waiting.length !== +count[2] || planeDetail.length !== +plane[2]) throw new Error('Truncated Current snapshot');
  return {
    asOf,
    validUntil,
    waitingCount: +count[2],
    waiting,
    open: +plane[1],
    overdue: +plane[2],
    due: +plane[3],
    planeDetail,
  };
}

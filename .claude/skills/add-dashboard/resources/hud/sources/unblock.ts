import { frontmatter } from '../io.js';

export interface UnblockCard {
  /** `U16` */
  id: string;
  title: string;
  ask: string;
  options: string;
  answered: boolean;
}
export interface UnblockPack {
  /** `2026-11-17` */
  date: string;
  cards: UnblockCard[];
}
/**
 * The overnight unblocker's pack: `## U<n> · <title>` sections, each with
 * `- **Ask:**`, `- **Options:**` and `- **Answer:**` bullets. An em dash (or
 * nothing) after Answer means it is still open.
 */
export function parseUnblock(text: string): UnblockPack {
  const meta = frontmatter(text);
  const date = meta.date instanceof Date ? meta.date.toISOString().slice(0, 10) : String(meta.date ?? '');
  if (meta.type !== 'unblock-pack' || !/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error('Not an unblock pack');
  const cards: UnblockCard[] = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const head = /^(U\d{1,4}) · (.+)$/m.exec(section.split('\n', 1)[0]);
    if (!head) continue;
    const field = (name: string) => new RegExp(`^- \\*\\*${name}:\\*\\*[ \\t]*(.*)$`, 'm').exec(section)?.[1].trim();
    const answer = field('Answer');
    if (answer === undefined) throw new Error(`Card ${head[1]} has no Answer field`);
    cards.push({
      id: head[1],
      title: head[2].trim(),
      ask: field('Ask') ?? '',
      options: field('Options') ?? '',
      answered: !/^[—–-]?$/.test(answer),
    });
  }
  return { date, cards };
}
/** The line the operator would type to Zed: `11/17 U16 yes`, or `11/17 U16: <edit>`. */
export function unblockReply(date: string, id: string, answer: 'yes' | 'no' | 'edit', text?: string): string {
  const day = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return answer === 'edit' ? `${day} ${id}: ${text ?? ''}` : `${day} ${id} ${answer}`;
}

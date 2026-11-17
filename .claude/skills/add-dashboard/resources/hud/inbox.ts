/**
 * The "needs me" inbox: everything waiting on the operator, from every place
 * it already lives, as one list with the buttons that settle each item.
 *
 * Nothing is stored here. Approvals and questions come from the central DB
 * (passed in), the rest from the files their own agents maintain. An item's
 * buttons name entries in the host's action map (actions.ts); an item whose
 * action is not offered carries a note saying where to act instead.
 */
import path from 'node:path';
import { SourceCache, files, iso, obsidian } from './io.js';
import { exclusionFilter } from './exclusions.js';
import { parseReview } from './sources/meeting-reviews.js';
import { parseRunLog } from './sources/run-logs.js';
import { isLate } from './sources/tasks.js';
import { parseUnblock } from './sources/unblock.js';
import { parseWaiting } from './sources/waiting.js';
import type { HudPaths } from './collect.js';
import type { Freshness, HudInbox, InboxAction, InboxItem, InboxKind, TaskSeries } from './types.js';

export interface PendingApprovalRow {
  approval_id: string;
  action: string;
  title: string;
  question?: string;
  created_at: string;
  agent_group_id: string | null;
  status: string;
}
export interface PendingQuestionRow {
  question_id: string;
  title: string;
  created_at: string;
  options: Array<{ label: string; value: string }>;
}
export interface InboxInput {
  /** null = the DB read failed; the source shows as unavailable instead of empty. */
  approvals: PendingApprovalRow[] | null;
  questions: PendingQuestionRow[] | null;
  tasks: TaskSeries[] | null;
  tasksAsOf?: string | null;
  /** Approval action types the HUD may resolve. Others are listed with a note. */
  approvalActions: ReadonlySet<string>;
  /** False when no operator identity is configured: approvals and questions are listed, not actionable. */
  canRespond: boolean;
  /** False when the operator's chat session cannot be resolved. */
  canReply: boolean;
  /** Item id → ISO time it stays hidden until. */
  snoozed: ReadonlyMap<string, string>;
  /** Agent group id → folder, for labels. */
  folders?: ReadonlyMap<string, string>;
  now?: Date;
  deadline?: number;
}

const PER_KIND = 15;
const SNOOZE_DAY: InboxAction = { name: 'item.snooze', label: 'Snooze 1d', args: { hours: '24' } };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function createInboxCollector(cache = new SourceCache()) {
  return function collectInbox(paths: HudPaths, input: InboxInput): HudInbox {
    const now = input.now ?? new Date();
    cache.deadline = input.deadline ?? performance.now() + 150;
    const groupPath = (group: string | undefined, ...parts: string[]) =>
      group && /^[\w-]+$/.test(group) ? path.join(paths.groupsDir, group, ...parts) : undefined;
    const primary = (...parts: string[]) => groupPath(paths.primary, ...parts);
    const registry = cache.load(primary('scripts/client-dashboard/registry.json'), JSON.parse);
    const keep = exclusionFilter(registry.value, paths.exclusions !== false).keep;
    const byKind = new Map<InboxKind, InboxItem[]>();
    const sources: HudInbox['sources'] = [];
    const add = (item: InboxItem) => {
      if (!keep(item)) return;
      byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
    };
    const source = (kind: InboxKind, name: string, cadenceMin: number, f: Partial<Freshness>) =>
      sources.push({ kind, source: name, cadenceMin, asOf: f.asOf ?? null, unavailable: f.unavailable });
    const withItem = (id: string, actions: InboxAction[]) =>
      actions.map((a) => ({ ...a, args: a.name === 'item.snooze' ? { ...a.args, item: id } : a.args }));
    const folder = (id: string | null) => (id ? (input.folders?.get(id) ?? id) : undefined);

    // Approvals — the same rows the chat cards point at.
    source('approval', 'pending_approvals', 1, {
      asOf: input.approvals ? now.toISOString() : null,
      unavailable: !input.approvals,
    });
    for (const a of input.approvals ?? []) {
      if (a.status !== 'pending') continue;
      const id = `approval:${a.approval_id}`;
      const offered = input.approvalActions.has(a.action) && input.canRespond;
      add({
        id,
        kind: 'approval',
        title: clip(a.title || a.action, 160),
        detail: a.question ? clip(a.question, 600) : undefined,
        client: folder(a.agent_group_id),
        since: iso(a.created_at),
        note: offered
          ? undefined
          : input.approvalActions.has(a.action)
            ? 'No operator identity is configured for the HUD; answer the card in chat.'
            : `"${a.action}" approvals are answered on the chat card, not here.`,
        actions: offered
          ? [
              { name: 'approval.approve', label: 'Approve', args: { id: a.approval_id }, style: 'primary' },
              { name: 'approval.reject', label: 'Reject', args: { id: a.approval_id }, style: 'danger' },
            ]
          : [],
      });
    }

    // Questions an agent asked with buttons.
    source('question', 'pending_questions', 1, {
      asOf: input.questions ? now.toISOString() : null,
      unavailable: !input.questions,
    });
    for (const q of input.questions ?? []) {
      add({
        id: `question:${q.question_id}`,
        kind: 'question',
        title: clip(q.title || 'Question', 300),
        since: iso(q.created_at),
        note: input.canRespond ? undefined : 'No operator identity is configured for the HUD; answer the card in chat.',
        actions: input.canRespond
          ? q.options.slice(0, 6).map((o) => ({
              name: 'question.answer',
              label: clip(o.label, 40),
              args: { id: q.question_id, value: o.value },
            }))
          : [],
      });
    }

    // Unblock cards: the newest pack only; older packs are superseded by it.
    const packFile = files(paths.vault ? path.join(paths.vault, '30-Areas/Clients/_Unblock') : undefined)
      .filter((f) => /\d{4}-\d\d-\d\d\.md$/.test(f))
      .at(-1);
    const pack = cache.load(packFile, parseUnblock);
    source('unblock', packFile ? `vault/_Unblock/${path.basename(packFile)}` : 'not configured', 1440, pack);
    for (const c of pack.value?.cards ?? []) {
      if (c.answered) continue;
      const args = { date: pack.value!.date, id: c.id };
      add({
        id: `unblock:${pack.value!.date}:${c.id}`,
        kind: 'unblock',
        title: clip(`${c.id} · ${c.title}`, 200),
        detail: clip([c.ask, c.options && `Options: ${c.options}`].filter(Boolean).join('\n'), 1200),
        since: iso(pack.value!.date),
        href: obsidian(packFile!, paths.vault),
        note: input.canReply ? undefined : 'The operator chat session is not resolvable; answer in chat.',
        actions: input.canReply
          ? [
              { name: 'unblock.answer', label: 'Yes', args: { ...args, answer: 'yes' }, style: 'primary' },
              { name: 'unblock.answer', label: 'No', args: { ...args, answer: 'no' } },
              { name: 'unblock.answer', label: 'Edit…', args: { ...args, answer: 'edit' }, prompt: 'Your edit' },
            ]
          : [],
      });
    }

    // Meeting reviews waiting for approve/drop. Resolved in chat; listed so they are not forgotten.
    const reviewDir = primary('meeting-reviews/pending');
    let reviewAsOf: string | null = null,
      reviewDown = false;
    for (const file of files(reviewDir).filter((f) => f.endsWith('.json'))) {
      const review = cache.load(file, parseReview);
      reviewDown ||= !!review.unavailable;
      if (!review.value) continue;
      if ((review.asOf ?? '') > (reviewAsOf ?? '')) reviewAsOf = review.asOf;
      const id = `review:${path.basename(file, '.json')}`;
      const actionItems = review.value.source_files?.action_items;
      add({
        id,
        kind: 'review',
        title: clip(`${review.value.items.length} action items · ${review.value.meeting}`, 200),
        detail: review.value.date,
        since: iso(review.value.created_at) ?? review.asOf,
        href: actionItems ? obsidian(actionItems, paths.vault) : undefined,
        note: 'Approve or drop on the meeting-review card in chat.',
        actions: withItem(id, [SNOOZE_DAY]),
      });
    }
    source('review', reviewDir ? 'groups/…/meeting-reviews/pending' : 'not configured', 1440, {
      asOf: reviewAsOf ?? (reviewDir ? now.toISOString() : null),
      unavailable: reviewDown,
    });

    // Asks other people are waiting on the operator for.
    const waitingFile = primary('state/waiting-on/ledger.json');
    const waiting = cache.load(waitingFile, parseWaiting);
    source('waiting', waitingFile ? 'groups/…/state/waiting-on/ledger.json' : 'not configured', 1440, waiting);
    for (const w of waiting.value ?? []) {
      const id = `waiting:${w.id}`;
      add({
        id,
        kind: 'waiting',
        title: clip(w.what, 240),
        detail: w.blocks ? clip(`Blocks: ${w.blocks}`, 300) : undefined,
        client: w.client,
        since: iso(w.asked),
        actions: withItem(id, [SNOOZE_DAY, { ...SNOOZE_DAY, label: 'Snooze 1w', args: { hours: '168' } }]),
      });
    }

    // Scheduled tasks: failing or late ones need a look; paused ones are parked.
    source('task', 'task sessions', 10, { asOf: input.tasksAsOf ?? null, unavailable: input.tasks === null });
    for (const t of (input.tasks ?? []).filter(keep)) {
      const log = cache.load(groupPath(t.folder, 'tasks', `${t.series_id}.md`), parseRunLog);
      const lastLine = log.value?.at(-1)?.text;
      const failing = /failed/i.test(lastLine ?? ''),
        late = isLate(t, now),
        paused = t.status === 'paused';
      if (!failing && !late && !paused) continue;
      const id = `task:${t.agent_group_id}/${t.series_id}`;
      const args = { id: t.series_id, session: t.session_id };
      add({
        id,
        kind: 'task',
        title: `${t.folder ?? t.agent_group_id}/${t.series_id}`,
        detail: clip(
          [[failing && 'failing', late && 'overdue', paused && 'paused'].filter(Boolean).join(', '), lastLine]
            .filter(Boolean)
            .join(' · '),
          400,
        ),
        client: t.folder,
        since: iso(paused ? t.last_run : t.next_run),
        quiet: paused && !failing,
        href: `/dashboard/messages?agentGroupId=${encodeURIComponent(t.agent_group_id)}&sessionId=${encodeURIComponent(t.session_id)}`,
        actions: withItem(
          id,
          paused
            ? [{ name: 'task.resume', label: 'Resume', args, style: 'primary' }]
            : [
                { name: 'task.run', label: 'Run now', args, style: 'primary' },
                { name: 'task.pause', label: 'Pause', args },
                SNOOZE_DAY,
              ],
        ),
      });
    }

    const order: InboxKind[] = ['approval', 'question', 'unblock', 'review', 'task', 'waiting'];
    const inbox: HudInbox = { items: [], more: {}, snoozed: 0, sources };
    for (const kind of order) {
      const awake = (byKind.get(kind) ?? []).filter((item) => {
        const until = input.snoozed.get(item.id);
        if (!until || Date.parse(until) <= now.getTime()) return true;
        inbox.snoozed++;
        return false;
      });
      // Parked items never push waiting ones out of the cap.
      awake.sort((a, b) => Number(!!a.quiet) - Number(!!b.quiet));
      inbox.items.push(...awake.slice(0, PER_KIND));
      if (awake.length > PER_KIND) inbox.more[kind] = awake.length - PER_KIND;
    }
    return inbox;
  };
}

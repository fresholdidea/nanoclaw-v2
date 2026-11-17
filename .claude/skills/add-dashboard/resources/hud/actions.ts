/**
 * What the dashboard may do to the host. The map's keys are the whole
 * allowlist: the dashboard calls a handler by name and there is no generic
 * pass-through to the admin CLI.
 *
 * Scope is work actions only. Nothing here restarts a group, changes config,
 * roles or wirings, or approves a request that would (see `approvalActions`).
 *
 * Each handler re-reads the thing it acts on and refuses anything the host
 * does not currently know: a button's args come from a browser and are
 * treated as claims, not facts. Every call is audited, refused ones included.
 *
 * Host capabilities arrive as `deps` so the rules are testable without a host.
 */
import type { ResponsePayload } from '../response-registry.js';
import { unblockReply } from './sources/unblock.js';
import type { HudStore } from './store.js';

export interface HudActor {
  /** The Tailscale login, when the request came through the tailnet name. */
  login: string | null;
  via: 'loopback' | 'tailnet';
}
export interface HudActionResult {
  ok: boolean;
  message: string;
}
export type HudAction = (args: Record<string, unknown>, actor: HudActor) => Promise<HudActionResult>;

export interface HudActionDeps {
  /** Run one fixed admin-CLI command as the host. */
  cli(command: string, args: Record<string, string>): Promise<HudActionResult>;
  /** True when this series id lives in this session, per the last task collection. */
  knownTask(id: string, session: string): boolean;
  approval(id: string): Promise<
    | {
        action: string;
        status: string;
        channel_type: string | null;
        platform_id: string | null;
        instance: string | null;
        platform_message_id: string | null;
      }
    | undefined
  >;
  question(id: string): Promise<
    | {
        channel_type: string | null;
        platform_id: string | null;
        thread_id: string | null;
        options: Array<{ value: string }>;
      }
    | undefined
  >;
  /** Offer a card response to the host's response handlers, exactly as a chat click does. True when one claimed it. */
  respond(payload: ResponsePayload): Promise<boolean>;
  /** The operator's namespaced user id (`<channel>:<handle>`). Authorization runs against this, as for a click. */
  operatorUserId: string | null;
  /** Approval action types the HUD may resolve. */
  approvalActions: ReadonlySet<string>;
  /** True when this card is in the current unblock pack and unanswered. */
  openUnblock(date: string, id: string): boolean;
  /** Put a line into the operator's chat session, as if they had typed it. False when there is no such session. */
  reply(text: string): Promise<boolean>;
  store: HudStore;
  now?: () => Date;
}

const refuse = (message: string): HudActionResult => ({ ok: false, message });
const str = (v: unknown, pattern: RegExp): string | null => (typeof v === 'string' && pattern.test(v) ? v : null);
const ID = /^[\w.:-]{1,120}$/;
const ITEM = /^(approval|question|unblock|review|waiting|task):[\w.:/-]{1,160}$/;

export function createHudActions(deps: HudActionDeps): Record<string, HudAction> {
  const now = () => (deps.now ?? (() => new Date()))();
  const hide = (item: string, minutes: number) =>
    deps.store.snooze(item, new Date(now().getTime() + minutes * 60_000).toISOString());

  function task(command: 'tasks-run' | 'tasks-pause' | 'tasks-resume', done: string): HudAction {
    return async (args) => {
      const id = str(args.id, ID),
        session = str(args.session, ID);
      if (!id || !session) return refuse('Needs a task id and its session.');
      if (!deps.knownTask(id, session)) return refuse('That task is not in the current task list. Reload and retry.');
      // Always scoped to one session: without it the verb fans out over every active session.
      const result = await deps.cli(command, { id, session });
      return result.ok ? { ok: true, message: `${done}: ${id}` } : result;
    };
  }

  function approval(value: 'approve' | 'reject'): HudAction {
    return async (args) => {
      const id = str(args.id, ID);
      if (!id) return refuse('Needs an approval id.');
      if (!deps.operatorUserId) return refuse('No operator identity is configured (HUD_OPERATOR_USER_ID).');
      const row = await deps.approval(id);
      if (!row) return refuse('That approval is no longer pending.');
      if (row.status !== 'pending') return refuse(`That approval is ${row.status}, not pending.`);
      if (!deps.approvalActions.has(row.action))
        return refuse(`"${row.action}" approvals are answered on the chat card, not from the HUD.`);
      const claimed = await deps.respond({
        questionId: id,
        value,
        userId: deps.operatorUserId,
        channelType: row.channel_type ?? deps.operatorUserId.split(':')[0],
        instance: row.instance ?? row.channel_type ?? undefined,
        messageId: row.platform_message_id ?? undefined,
        platformId: row.platform_id ?? '',
        threadId: null,
      });
      // A handler claims an unauthorized click too, and leaves the row alone: the row is the proof.
      const after = await deps.approval(id);
      if (!claimed || after?.status === 'pending')
        return refuse('The host did not accept that response (not authorized for this approval, or already handled).');
      return { ok: true, message: value === 'approve' ? 'Approved.' : 'Rejected.' };
    };
  }

  const actions: Record<string, HudAction> = {
    'task.run': task('tasks-run', 'Queued a run'),
    'task.pause': task('tasks-pause', 'Paused'),
    'task.resume': task('tasks-resume', 'Resumed'),
    'approval.approve': approval('approve'),
    'approval.reject': approval('reject'),

    'question.answer': async (args) => {
      const id = str(args.id, ID),
        value = str(args.value, /^[\s\S]{1,200}$/);
      if (!id || value === null) return refuse('Needs a question id and an answer.');
      if (!deps.operatorUserId) return refuse('No operator identity is configured (HUD_OPERATOR_USER_ID).');
      const row = await deps.question(id);
      if (!row) return refuse('That question is no longer open.');
      if (!row.options.some((o) => o.value === value)) return refuse('That is not one of the offered answers.');
      const claimed = await deps.respond({
        questionId: id,
        value,
        userId: deps.operatorUserId,
        channelType: row.channel_type ?? deps.operatorUserId.split(':')[0],
        platformId: row.platform_id ?? '',
        threadId: row.thread_id,
      });
      if (!claimed || (await deps.question(id))) return refuse('The host did not accept that answer.');
      return { ok: true, message: 'Answer sent.' };
    },

    'unblock.answer': async (args) => {
      const date = str(args.date, /^\d{4}-\d\d-\d\d$/),
        id = str(args.id, /^U\d{1,4}$/),
        answer = str(args.answer, /^(yes|no|edit)$/) as 'yes' | 'no' | 'edit' | null;
      if (!date || !id || !answer) return refuse('Needs a pack date, a card id and yes, no or edit.');
      // One line, no control characters: this text is delivered to an agent as the operator's own words.
      const text = answer === 'edit' ? str(args.text, /^[^\p{Cc}]{1,500}$/u)?.trim() : undefined;
      if (answer === 'edit' && !text) return refuse('An edit needs one line of text, 500 characters at most.');
      if (!deps.openUnblock(date, id)) return refuse('That card is not open in the current unblock pack.');
      const line = unblockReply(date, id, answer, text);
      if (!(await deps.reply(line))) return refuse('The operator chat session could not be resolved; answer in chat.');
      // The pack only changes once the agent has processed the line.
      hide(`unblock:${date}:${id}`, 12 * 60);
      return { ok: true, message: `Sent to chat: ${line}` };
    },

    'item.snooze': async (args) => {
      const item = str(args.item, ITEM),
        hours = Number(str(args.hours, /^\d{1,3}$/));
      if (!item || !(hours >= 1 && hours <= 168)) return refuse('Needs an inbox item and 1 to 168 hours.');
      hide(item, hours * 60);
      return { ok: true, message: `Snoozed for ${hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`}.` };
    },
  };

  // Every call leaves a row, whatever happened: who, what, with which args, and the outcome.
  return Object.fromEntries(
    Object.entries(actions).map(([name, handler]) => [
      name,
      async (args: Record<string, unknown>, actor: HudActor): Promise<HudActionResult> => {
        let result: HudActionResult;
        try {
          result = await handler(args && typeof args === 'object' ? args : {}, actor);
        } catch (err) {
          result = refuse(`Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
        }
        try {
          deps.store.audit({
            t: now().toISOString(),
            action: name,
            args: JSON.stringify(args ?? {}).slice(0, 2000),
            actor: `${actor.via}:${actor.login ?? 'local'}`,
            ok: result.ok,
            message: result.message.slice(0, 500),
          });
        } catch {
          // An action that happened must still be reported as it went.
        }
        return result;
      },
    ]),
  );
}

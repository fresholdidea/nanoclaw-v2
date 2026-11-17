import path from 'node:path';
import { readEnvFile } from '../env.js';
import { DATA_DIR, GROUPS_DIR, TIMEZONE } from '../config.js';
import { getAgentGroupByFolder, getAllAgentGroups } from '../db/agent-groups.js';
import { getDb, hasTable } from '../db/connection.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getPendingApproval, getPendingQuestion, getSessionsByAgentGroup } from '../db/sessions.js';
import { resolveGroupTimezone } from '../container-config.js';
import { dispatch } from '../cli/dispatch.js';
import { collectTaskSeries } from '../cli/resources/tasks.js';
import { log } from '../log.js';
import { getUserDmsForUser } from '../modules/permissions/db/user-dms.js';
import { requestWake } from '../request-wake.js';
import { getResponseHandlers } from '../response-registry.js';
import { writeSessionMessage } from '../session-manager.js';
import { createHudActions, type HudAction } from './actions.js';
import { createHudCollector } from './collect.js';
import { createInboxCollector, type PendingApprovalRow, type PendingQuestionRow } from './inbox.js';
import { openHudStore, type HudStore } from './store.js';
import type { HudInbox, TaskSeries } from './types.js';
const collect = createHudCollector();
const collectInbox = createInboxCollector();
let lastInbox: HudInbox | null = null;
// Approvals that restart, reconfigure or create things stay on the chat card.
const DEFAULT_APPROVAL_ACTIONS = 'a2a_message_gate,gateway_request';
const HUD_ENV = [
  'HUD_PRIMARY_GROUP',
  'HUD_STEWARD_GROUP',
  'HUD_BILLING_GROUP',
  'HUD_INBOX_OPS_GROUP',
  'HUD_VAULT_DIR',
  'HUD_AD_METRICS_DB',
  'HUD_EXCLUSIONS',
  'HUD_OPERATOR_USER_ID',
  'HUD_APPROVAL_ACTIONS',
];
let store: HudStore | null | undefined;
/** The HUD's own store, or null when it cannot be opened: the inbox still renders, without snoozes or actions. */
function hudStore(): HudStore | null {
  if (store === undefined) {
    try {
      store = openHudStore(path.join(DATA_DIR, 'hud.db'));
    } catch (err) {
      log.warn('HUD store unavailable; dashboard actions are off', { err });
      store = null;
    }
  }
  return store;
}
function approvalActions(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.HUD_APPROVAL_ACTIONS ?? DEFAULT_APPROVAL_ACTIONS)
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
  );
}
/** The operator's own DM session with the primary agent: where a typed reply would land. */
async function operatorSession(primaryFolder: string | undefined, operatorUserId: string | undefined) {
  if (!primaryFolder || !operatorUserId) return null;
  const group = await getAgentGroupByFolder(primaryFolder);
  if (!group) return null;
  const dms = new Set((await getUserDmsForUser(operatorUserId)).map((d) => d.messaging_group_id));
  const session = (await getSessionsByAgentGroup(group.id))
    .filter(
      (s) => s.status === 'active' && s.thread_id === null && !!s.messaging_group_id && dms.has(s.messaging_group_id),
    )
    .sort((a, b) => (b.last_active ?? b.created_at).localeCompare(a.last_active ?? a.created_at))[0];
  if (!session) return null;
  const messagingGroup = await getMessagingGroup(session.messaging_group_id!);
  return messagingGroup ? { session, messagingGroup } : null;
}
async function pendingRows(): Promise<{
  approvals: PendingApprovalRow[] | null;
  questions: PendingQuestionRow[] | null;
}> {
  let approvals: PendingApprovalRow[] | null = null,
    questions: PendingQuestionRow[] | null = null;
  try {
    approvals = (await hasTable(getDb(), 'pending_approvals'))
      ? await getDb().all<PendingApprovalRow>("SELECT * FROM pending_approvals WHERE status = 'pending'")
      : [];
  } catch {
    /* shown as unavailable */
  }
  try {
    questions = (await hasTable(getDb(), 'pending_questions'))
      ? (
          await getDb().all<Omit<PendingQuestionRow, 'options'> & { options_json: string }>(
            'SELECT question_id, title, created_at, options_json FROM pending_questions',
          )
        ).map(({ options_json, ...q }) => ({ ...q, options: JSON.parse(options_json) }))
      : [];
  } catch {
    /* shown as unavailable */
  }
  return { approvals, questions };
}
let lastTasks: TaskSeries[] | null = null;
let tasksAsOf: string | null = null;
let refreshing: Promise<void> | null = null;
let refreshedAt = 0;
// Walking every task session's inbound.db takes ~0.3-1s with ~70 series, so it
// runs beside the push instead of inside the snapshot's 200ms budget.
const TASK_REFRESH_MS = 5 * 60_000;
const TASK_BUDGET_MS = 10_000;
const TASK_WAIT_MS = 150;
function refreshTasks(): Promise<void> {
  refreshing ??= (async () => {
    try {
      const groups = await getAllAgentGroups();
      const metadata = new Map(
        await Promise.all(
          groups.map(async (g) => [g.id, { folder: g.folder, timezone: await resolveGroupTimezone(g.id) }] as const),
        ),
      );
      lastTasks = (await collectTaskSeries(performance.now() + TASK_BUDGET_MS)).map((t) => ({
        ...t,
        status: t.status === 'paused' ? ('paused' as const) : ('pending' as const),
        ...metadata.get(t.agent_group_id),
      }));
      tasksAsOf = new Date().toISOString();
      refreshedAt = Date.now();
    } catch {
      /* retain the previous task snapshot and its freshness; retry within a minute */
      refreshedAt = Date.now() - TASK_REFRESH_MS + 60_000;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
export async function collectDashboardHud(tokens: { daily?: Record<string, number>; asOf?: string | null }) {
  const env = readEnvFile(HUD_ENV);
  if (!refreshing && Date.now() - refreshedAt > TASK_REFRESH_MS) {
    const pending = refreshTasks();
    // The first push after a refresh starts gets its result when it is quick;
    // otherwise this snapshot keeps the previous series and the next one catches up.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>((r) => (timeout = setTimeout(r, TASK_WAIT_MS)))]);
    clearTimeout(timeout);
  }
  const paths = {
    groupsDir: GROUPS_DIR,
    primary: env.HUD_PRIMARY_GROUP,
    steward: env.HUD_STEWARD_GROUP,
    billing: env.HUD_BILLING_GROUP,
    inboxOps: env.HUD_INBOX_OPS_GROUP,
    vault: env.HUD_VAULT_DIR,
    adMetrics: env.HUD_AD_METRICS_DB,
    exclusions: env.HUD_EXCLUSIONS !== 'false',
  };
  // The inbox's DB reads happen before the file budget starts.
  const [pending, operator, groups] = await Promise.all([
    pendingRows(),
    operatorSession(env.HUD_PRIMARY_GROUP, env.HUD_OPERATOR_USER_ID).catch(() => null),
    getAllAgentGroups().catch(() => []),
  ]);
  const hudDb = hudStore();
  let snoozed = new Map<string, string>();
  try {
    snoozed = hudDb?.snoozed(new Date().toISOString()) ?? snoozed;
  } catch {
    /* nothing is hidden */
  }
  const deadline = performance.now() + 200;
  const hud = collect(paths, { tokens, tasks: lastTasks, tasksAsOf, timezone: TIMEZONE, deadline });
  try {
    lastInbox = collectInbox(paths, {
      ...pending,
      tasks: lastTasks,
      tasksAsOf,
      approvalActions: approvalActions(env),
      canRespond: !!hudDb && !!env.HUD_OPERATOR_USER_ID,
      canReply: !!hudDb && !!operator,
      snoozed,
      folders: new Map(groups.map((g) => [g.id, g.folder])),
      deadline: performance.now() + 150,
    });
    hud.inbox = lastInbox;
  } catch (err) {
    log.warn('HUD inbox collection failed', { err });
  }
  return hud;
}

/**
 * The action map handed to the dashboard, or undefined when the HUD store
 * cannot be opened (no audit, so no actions).
 */
export function dashboardHudActions(): Record<string, HudAction> | undefined {
  const hudDb = hudStore();
  if (!hudDb) return undefined;
  const env = () => readEnvFile(HUD_ENV);
  return createHudActions({
    store: hudDb,
    get operatorUserId() {
      return env().HUD_OPERATOR_USER_ID || null;
    },
    get approvalActions() {
      return approvalActions(env());
    },
    async cli(command, args) {
      const res = await dispatch({ id: `hud-${Date.now()}`, command, args }, { caller: 'host' });
      return res.ok ? { ok: true, message: 'ok' } : { ok: false, message: res.error.message };
    },
    knownTask: (id, session) => !!lastTasks?.some((t) => t.series_id === id && t.session_id === session),
    approval: (id) => getPendingApproval(id),
    question: (id) => getPendingQuestion(id),
    async respond(payload) {
      // The same walk a chat card click takes (src/index.ts dispatchResponse).
      for (const handler of getResponseHandlers()) {
        try {
          if (await handler(payload)) return true;
        } catch (err) {
          log.error('Response handler threw', { questionId: payload.questionId, err });
        }
      }
      return false;
    },
    openUnblock: (date, id) => !!lastInbox?.items.some((i) => i.id === `unblock:${date}:${id}` && i.actions.length > 0),
    async reply(text) {
      const e = env();
      const target = await operatorSession(e.HUD_PRIMARY_GROUP, e.HUD_OPERATOR_USER_ID);
      if (!target) return false;
      await writeSessionMessage(target.session.agent_group_id, target.session.id, {
        id: `hud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: target.messagingGroup.platform_id,
        channelType: target.messagingGroup.channel_type,
        threadId: null,
        content: JSON.stringify({ text, sender: 'Operator (via HUD)', senderId: e.HUD_OPERATOR_USER_ID }),
      });
      await requestWake(target.session, 'inbound-message');
      return true;
    },
  });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHudActions, type HudActionDeps } from './actions.js';
import { createInboxCollector, type InboxInput } from './inbox.js';
import { parseUnblock, unblockReply } from './sources/unblock.js';
import { parseWaiting } from './sources/waiting.js';
import { openHudStore, type HudStore } from './store.js';
import type { TaskSeries } from './types.js';

const NOW = new Date('2026-11-17T15:00:00Z');
const PACK = `---
type: unblock-pack
date: 2026-11-17
status: ready
---

# Unblock: Tue 11/17

## U16 · Acme: choose a plan
- **Kind:** Decide
- **Ask:** prepare the one-set proposal?
- **Options:** yes = prepare it; no = more analysis
- **Answer:** —

## U17 · Beta: already settled
- **Ask:** run the test?
- **Answer:** yes (11/17 09:02)

## Also waiting
- U3, old thing
`;
const task = (over: Partial<TaskSeries>): TaskSeries => ({
  agent_group_id: 'ag-1',
  session_id: 's-1',
  series_id: 'weekly-status-aaaa',
  folder: 'primary',
  status: 'pending',
  schedule: '0 * * * *',
  runs: 3,
  failed_runs: 0,
  last_run: '2026-11-17T14:00:00.000Z',
  next_run: '2026-11-17T16:00:00.000Z',
  ...over,
});

let root: string, groupsDir: string, vault: string, store: HudStore;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-inbox-'));
  groupsDir = path.join(root, 'groups');
  vault = path.join(root, 'Vault');
  store = openHudStore(path.join(root, 'hud.db'));
  write(
    path.join(vault, '30-Areas/Clients/_Unblock/2026-11-16.md'),
    PACK.replaceAll('11-17', '11-16').replace('U16', 'U9'),
  );
  write(path.join(vault, '30-Areas/Clients/_Unblock/2026-11-17.md'), PACK);
  write(
    path.join(groupsDir, 'primary/state/waiting-on/ledger.json'),
    JSON.stringify({
      a1: {
        id: 'a1',
        status: 'open',
        owner: 'brad',
        what: 'Send the brief',
        client: 'Acme',
        asked: '2026-11-10',
        blocks: 'ACME-4',
      },
      a2: {
        id: 'a2',
        status: 'open',
        owner: 'external',
        what: 'Client to send logins',
        client: 'Acme',
        asked: '2026-11-01',
      },
      a3: { id: 'a3', status: 'resolved', owner: 'brad', what: 'Done already', asked: '2026-10-01' },
      a4: { id: 'a4', status: 'open', owner: 'brad', what: 'Older ask', client: 'Vast.dev', asked: '2026-10-02' },
    }),
  );
  write(
    path.join(groupsDir, 'primary/meeting-reviews/pending/2026-11-16-acme-sync.json'),
    JSON.stringify({ meeting: 'Acme sync', date: '2026-11-16', created_at: '2026-11-16T18:00:00Z', items: [1, 2, 3] }),
  );
  write(path.join(groupsDir, 'primary/tasks/weekly-status-aaaa.md'), '2026-11-17 09:00 — run failed: exit 1\n');
});
afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const input = (over: Partial<InboxInput> = {}): InboxInput => ({
  approvals: [
    {
      approval_id: 'ap-1',
      action: 'a2a_message_gate',
      title: 'Send to paid-media?',
      question: 'Relay the brief',
      created_at: '2026-11-17T12:00:00.000Z',
      agent_group_id: 'ag-1',
      status: 'pending',
    },
    {
      approval_id: 'ap-2',
      action: 'install_packages',
      title: 'Install ffmpeg',
      created_at: '2026-11-17T11:00:00.000Z',
      agent_group_id: 'ag-1',
      status: 'pending',
    },
    {
      approval_id: 'ap-3',
      action: 'a2a_message_gate',
      title: 'Held for a reason',
      created_at: '2026-11-17T10:00:00.000Z',
      agent_group_id: null,
      status: 'awaiting_reason',
    },
  ],
  questions: [
    {
      question_id: 'q-1',
      title: 'Which draft?',
      created_at: '2026-11-17T13:00:00.000Z',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
    },
  ],
  tasks: [task({}), task({ series_id: 'parked-bbbb', status: 'paused' }), task({ series_id: 'healthy-cccc' })],
  tasksAsOf: NOW.toISOString(),
  approvalActions: new Set(['a2a_message_gate']),
  canRespond: true,
  canReply: true,
  snoozed: new Map(),
  folders: new Map([['ag-1', 'primary']]),
  now: NOW,
  deadline: Infinity,
  ...over,
});
const collect = (over: Partial<InboxInput> = {}) =>
  createInboxCollector()({ groupsDir, primary: 'primary', vault, exclusions: true }, input(over));
const byId = (over: Partial<InboxInput> = {}) => new Map(collect(over).items.map((i) => [i.id, i]));

describe('unblock packs', () => {
  it('reads open and answered cards and ignores other sections', () => {
    const pack = parseUnblock(PACK);
    expect(pack.date).toBe('2026-11-17');
    expect(pack.cards.map((c) => [c.id, c.answered])).toEqual([
      ['U16', false],
      ['U17', true],
    ]);
    expect(pack.cards[0].ask).toBe('prepare the one-set proposal?');
  });
  it('rejects a file that is not a pack, or a card with no Answer field', () => {
    expect(() => parseUnblock('# notes')).toThrow();
    expect(() => parseUnblock(PACK.replace('- **Answer:** —\n', ''))).toThrow(/U16/);
  });
  it('builds the line the operator would type', () => {
    expect(unblockReply('2026-11-07', 'U16', 'yes')).toBe('11/7 U16 yes');
    expect(unblockReply('2026-11-17', 'U16', 'edit', 'two sets, capped')).toBe('11/17 U16: two sets, capped');
  });
});

describe('waiting-on ledger', () => {
  it('keeps open asks that are not owned by someone external, oldest first', () => {
    expect(
      parseWaiting(fs.readFileSync(path.join(groupsDir, 'primary/state/waiting-on/ledger.json'), 'utf8')).map(
        (r) => r.id,
      ),
    ).toEqual(['a4', 'a1']);
    expect(() => parseWaiting('[]')).toThrow();
  });
});

describe('inbox', () => {
  it('lists every kind once, with buttons only where the HUD may act', () => {
    const items = byId();
    expect(items.get('approval:ap-1')!.actions.map((a) => a.name)).toEqual(['approval.approve', 'approval.reject']);
    expect(items.get('approval:ap-1')!.client).toBe('primary');
    expect(items.get('approval:ap-2')!.actions).toEqual([]);
    expect(items.get('approval:ap-2')!.note).toMatch(/install_packages/);
    expect(items.has('approval:ap-3')).toBe(false);
    expect(items.get('question:q-1')!.actions.map((a) => a.args.value)).toEqual(['a', 'b']);
    expect(items.get('unblock:2026-11-17:U16')!.actions.map((a) => a.args.answer)).toEqual(['yes', 'no', 'edit']);
    expect(items.has('unblock:2026-11-17:U17')).toBe(false);
    expect(items.has('unblock:2026-11-16:U9')).toBe(false);
    expect(items.get('review:2026-11-16-acme-sync')!.title).toBe('3 action items · Acme sync');
    expect(items.get('waiting:a1')!.actions.map((a) => a.args)).toEqual([
      { hours: '24', item: 'waiting:a1' },
      { hours: '168', item: 'waiting:a1' },
    ]);
    expect(items.has('waiting:a2')).toBe(false);
    expect(items.get('task:ag-1/weekly-status-aaaa')!.actions.map((a) => a.name)).toEqual([
      'task.run',
      'task.pause',
      'item.snooze',
    ]);
    expect(items.get('task:ag-1/parked-bbbb')).toMatchObject({ quiet: true, actions: [{ name: 'task.resume' }] });
    expect(items.has('task:ag-1/healthy-cccc')).toBe(false);
  });
  it('applies the client exclusions to every kind', () => {
    expect(byId().has('waiting:a4')).toBe(false);
    const hidden = byId({
      approvals: [
        {
          approval_id: 'ap-9',
          action: 'a2a_message_gate',
          title: 'Falcone relay',
          created_at: '2026-11-17T12:00:00.000Z',
          agent_group_id: null,
          status: 'pending',
        },
      ],
    });
    expect(hidden.has('approval:ap-9')).toBe(false);
  });
  it('offers no response buttons without an operator identity or chat session', () => {
    const items = byId({ canRespond: false, canReply: false });
    for (const id of ['approval:ap-1', 'question:q-1', 'unblock:2026-11-17:U16']) {
      expect(items.get(id)!.actions).toEqual([]);
      expect(items.get(id)!.note).toBeTruthy();
    }
  });
  it('hides snoozed items until the snooze ends, and counts them', () => {
    const snoozed = new Map([
      ['waiting:a1', '2026-11-18T00:00:00.000Z'],
      ['review:2026-11-16-acme-sync', '2026-11-17T14:00:00.000Z'],
    ]);
    const inbox = collect({ snoozed });
    expect(inbox.items.some((i) => i.id === 'waiting:a1')).toBe(false);
    expect(inbox.items.some((i) => i.id === 'review:2026-11-16-acme-sync')).toBe(true);
    expect(inbox.snoozed).toBe(1);
  });
  it('reports a failed DB read as unavailable, never as an empty list', () => {
    const inbox = collect({ approvals: null, tasks: null });
    const source = (kind: string) => inbox.sources.find((s) => s.kind === kind)!;
    expect(source('approval')).toMatchObject({ asOf: null, unavailable: true });
    expect(source('task').unavailable).toBe(true);
    expect(source('question').unavailable).toBeFalsy();
  });
  it('caps each kind and says how many were left out', () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `w${i}`,
        { id: `w${i}`, status: 'open', owner: 'brad', what: `Ask ${i}`, asked: '2026-11-01' },
      ]),
    );
    write(path.join(groupsDir, 'primary/state/waiting-on/ledger.json'), JSON.stringify(many));
    const inbox = collect();
    expect(inbox.items.filter((i) => i.kind === 'waiting')).toHaveLength(15);
    expect(inbox.more.waiting).toBe(5);
  });
});

describe('actions', () => {
  const actor = { login: 'owner@example.com', via: 'tailnet' as const };
  function setup(over: Partial<HudActionDeps> = {}) {
    const calls: Array<[string, unknown]> = [];
    const approvals = new Map([
      [
        'ap-1',
        {
          action: 'a2a_message_gate',
          status: 'pending',
          channel_type: 'telegram',
          platform_id: 'telegram:1',
          instance: null,
          platform_message_id: 'm1',
        },
      ],
      [
        'ap-2',
        {
          action: 'install_packages',
          status: 'pending',
          channel_type: 'telegram',
          platform_id: 'telegram:1',
          instance: null,
          platform_message_id: null,
        },
      ],
    ]);
    const questions = new Map([
      [
        'q-1',
        {
          channel_type: 'telegram',
          platform_id: 'telegram:1',
          thread_id: null,
          options: [{ value: 'a' }, { value: 'b' }],
        },
      ],
    ]);
    const deps: HudActionDeps = {
      store,
      now: () => NOW,
      operatorUserId: 'telegram:42',
      approvalActions: new Set(['a2a_message_gate']),
      cli: async (command, args) => (calls.push([command, args]), { ok: true, message: 'ok' }),
      knownTask: (id, session) => id === 'weekly-status-aaaa' && session === 's-1',
      approval: async (id) => approvals.get(id),
      question: async (id) => questions.get(id),
      respond: async (payload) => {
        calls.push(['respond', payload]);
        approvals.delete(payload.questionId);
        questions.delete(payload.questionId);
        return true;
      },
      openUnblock: (date, id) => date === '2026-11-17' && id === 'U16',
      reply: async (text) => (calls.push(['reply', text]), true),
      editIssue: async (client, id, change) => (
        calls.push(['editIssue', { client, id, change }]),
        { ok: true, message: 'ok' }
      ),
      ...over,
    };
    return { actions: createHudActions(deps), calls };
  }

  it('offers exactly the work actions: nothing that restarts or reconfigures', () => {
    expect(Object.keys(setup().actions).sort()).toEqual([
      'approval.approve',
      'approval.reject',
      'issue.close',
      'issue.update',
      'item.snooze',
      'question.answer',
      'task.pause',
      'task.resume',
      'task.run',
      'unblock.answer',
    ]);
  });
  it('runs a known task scoped to its own session, and refuses an unknown one', async () => {
    const { actions, calls } = setup();
    expect(await actions['task.run']({ id: 'weekly-status-aaaa', session: 's-1' }, actor)).toMatchObject({ ok: true });
    expect(calls).toEqual([['tasks-run', { id: 'weekly-status-aaaa', session: 's-1' }]]);
    expect((await actions['task.pause']({ id: 'weekly-status-aaaa', session: 's-other' }, actor)).ok).toBe(false);
    expect((await actions['task.resume']({ id: 'x; rm -rf', session: 's-1' }, actor)).ok).toBe(false);
    expect((await actions['task.run']({ id: 'weekly-status-aaaa' }, actor)).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
  it('answers an approval as the operator, through the same path as a chat click', async () => {
    const { actions, calls } = setup();
    expect(await actions['approval.approve']({ id: 'ap-1' }, actor)).toEqual({ ok: true, message: 'Approved.' });
    expect(calls[0]).toEqual([
      'respond',
      {
        questionId: 'ap-1',
        value: 'approve',
        userId: 'telegram:42',
        channelType: 'telegram',
        instance: 'telegram',
        messageId: 'm1',
        platformId: 'telegram:1',
        threadId: null,
      },
    ]);
    expect((await actions['approval.approve']({ id: 'ap-1' }, actor)).ok).toBe(false);
  });
  it('refuses approval types outside the allowlist without offering them to the host', async () => {
    const { actions, calls } = setup();
    const result = await actions['approval.approve']({ id: 'ap-2' }, actor);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/install_packages/);
    expect(calls).toEqual([]);
  });
  it('reports failure when the host leaves the approval pending, or no operator is configured', async () => {
    const ignored = setup({ respond: async () => true });
    expect((await ignored.actions['approval.reject']({ id: 'ap-1' }, actor)).ok).toBe(false);
    const anonymous = setup({ operatorUserId: null });
    expect((await anonymous.actions['approval.approve']({ id: 'ap-1' }, actor)).ok).toBe(false);
    expect(anonymous.calls).toEqual([]);
  });
  it('answers a question only with one of its offered options', async () => {
    const { actions, calls } = setup();
    expect((await actions['question.answer']({ id: 'q-1', value: 'c' }, actor)).ok).toBe(false);
    expect(calls).toEqual([]);
    expect((await actions['question.answer']({ id: 'q-1', value: 'b' }, actor)).ok).toBe(true);
  });
  it('sends an unblock answer as one chat line and hides the card until the agent catches up', async () => {
    const { actions, calls } = setup();
    expect(await actions['unblock.answer']({ date: '2026-11-17', id: 'U16', answer: 'yes' }, actor)).toEqual({
      ok: true,
      message: 'Sent to chat: 11/17 U16 yes',
    });
    expect(store.snoozed(NOW.toISOString()).get('unblock:2026-11-17:U16')).toBe('2026-11-18T03:00:00.000Z');
    expect((await actions['unblock.answer']({ date: '2026-11-17', id: 'U99', answer: 'yes' }, actor)).ok).toBe(false);
    expect(
      (
        await actions['unblock.answer'](
          { date: '2026-11-17', id: 'U16', answer: 'edit', text: 'line one\nline two' },
          actor,
        )
      ).ok,
    ).toBe(false);
    expect((await actions['unblock.answer']({ date: '2026-11-17', id: 'U16', answer: 'edit' }, actor)).ok).toBe(false);
    expect(
      (
        await actions['unblock.answer'](
          { date: '2026-11-17', id: 'U16', answer: 'edit', text: ' cap it at two sets ' },
          actor,
        )
      ).ok,
    ).toBe(true);
    expect(calls).toEqual([
      ['reply', '11/17 U16 yes'],
      ['reply', '11/17 U16: cap it at two sets'],
    ]);
  });
  it('snoozes only inbox items, for a bounded time', async () => {
    const { actions } = setup();
    expect((await actions['item.snooze']({ item: 'waiting:a1', hours: '24' }, actor)).ok).toBe(true);
    expect(store.snoozed(NOW.toISOString()).get('waiting:a1')).toBe('2026-11-18T15:00:00.000Z');
    for (const bad of [
      { item: 'waiting:a1', hours: '0' },
      { item: 'waiting:a1', hours: '999' },
      { item: 'groups:restart', hours: '1' },
      { hours: '1' },
    ])
      expect((await actions['item.snooze'](bad, actor)).ok).toBe(false);
  });
  it('audits every call with actor and outcome, including refusals and throws', async () => {
    const { actions } = setup({
      cli: async () => {
        throw new Error('socket gone');
      },
    });
    await actions['task.run']({ id: 'weekly-status-aaaa', session: 's-1' }, actor);
    await actions['item.snooze']({ item: 'waiting:a1', hours: '1' }, { login: null, via: 'loopback' });
    const rows = store.recentAudit();
    expect(rows.map((r) => [r.action, r.actor, r.ok])).toEqual([
      ['item.snooze', 'loopback:local', true],
      ['task.run', 'tailnet:owner@example.com', false],
    ]);
    expect(rows[1].message).toMatch(/socket gone/);
    expect(rows[0].t).toBe(NOW.toISOString());
  });
});

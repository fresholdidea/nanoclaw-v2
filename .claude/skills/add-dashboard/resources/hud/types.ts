export interface Freshness {
  asOf: string | null;
  cadenceMin: number;
  source: string;
  validUntil?: string;
  unavailable?: boolean;
}
export interface HudCard extends Freshness {
  id: 'receivables' | 'ad_spend' | 'usage' | 'cron' | 'waiting' | 'plane' | 'walls';
  label: string;
  value: number | string | null;
  unit?: '$' | 'n' | 'd' | 'tok';
  delta?: { value: number; label: string };
  spark?: number[];
  detail: string[];
  href?: string;
}
export interface HudTickerItem {
  t: string;
  source: string;
  level: 'info' | 'warn' | 'alert';
  text: string;
  href?: string;
}
export interface HudToday extends Freshness {
  events: Array<{ start: string; end: string; title: string; account: string; attendees: number; href?: string }>;
  directives: Array<{
    key: string;
    title: string;
    cls: 'decision' | 'access' | 'action';
    appearances: number;
    deadline?: string;
  }>;
  nextMeeting: { start: string; title: string; prepHref?: string; status?: string } | null;
  directivesMore?: number;
  directivesHref?: string;
  directivesFreshness?: Freshness;
  meetingFreshness?: Freshness;
}
export interface HudSkill extends Freshness {
  name: string;
  description: string;
  pinned: boolean;
  series?: {
    id: string;
    group: string;
    schedule: string;
    lastRun: string | null;
    nextRun: string | null;
    runs: number;
    failedRuns: number;
    status: 'pending' | 'paused';
    sessionId: string;
    lastLine: string | null;
  };
  trigger?: string;
  href?: string;
}
/** A button on an inbox item. `name` is a key of the host's action map; `args` go to it unchanged. */
export interface InboxAction {
  name: string;
  label: string;
  args: Record<string, string>;
  style?: 'primary' | 'danger';
  /** Ask for a line of text first and send it as `args.text`. */
  prompt?: string;
  /** The prompt is a date picker; `args.text` is then YYYY-MM-DD. */
  input?: 'date';
}
export type InboxKind = 'approval' | 'question' | 'unblock' | 'review' | 'waiting' | 'task' | 'issue';
export interface InboxItem {
  /** Stable across pushes: `<kind>:<source id>`. Snoozes and deep links key on it. */
  id: string;
  kind: InboxKind;
  title: string;
  detail?: string;
  client?: string;
  /** When it started waiting, ISO. */
  since: string | null;
  href?: string;
  /** Why there is no button, or where else to act. */
  note?: string;
  /** Shown collapsed: true for things that are parked, not waiting. */
  quiet?: boolean;
  /** One word the page may highlight. */
  flag?: 'overdue' | 'mine';
  actions: InboxAction[];
}
export interface HudInbox {
  items: InboxItem[];
  /** Items left out per kind by the per-kind cap. */
  more: Partial<Record<InboxKind, number>>;
  snoozed: number;
  sources: Array<Freshness & { kind: InboxKind }>;
}
export interface HudClient extends Freshness {
  id: string;
  label: string;
  /** Open issues, after exclusions and snoozes. */
  open: number;
  overdue: number;
  mine: number;
  /** The most pressing open issues, capped. */
  issues: InboxItem[];
  /** Asks waiting on the operator for this client, capped. */
  waiting: InboxItem[];
  waitingCount: number;
}
export interface HudClients {
  clients: HudClient[];
  snoozed: number;
}
export type HealthStatus = 'ok' | 'warn' | 'down';
/** One integration, job or access path, with the verdict some existing record gives it. */
export interface HealthRow extends Freshness {
  /** Stable across pushes; deep links key on it. */
  id: string;
  group: 'ads' | 'collector' | 'tracker' | 'jobs' | 'walls';
  label: string;
  status: HealthStatus;
  detail: string;
  /** Reasons and next steps, shown when the row is opened. */
  notes?: string[];
}
export interface HudHealth {
  rows: HealthRow[];
}
export interface Hud {
  generatedAt: string;
  timezone: string;
  cards: HudCard[];
  ticker: HudTickerItem[];
  today: HudToday;
  skills: HudSkill[];
  hiddenCount: number;
  inbox?: HudInbox;
  clients?: HudClients;
  health?: HudHealth;
}
export interface TaskSeries {
  agent_group_id: string;
  session_id: string;
  series_id: string;
  status: 'pending' | 'paused';
  schedule: string;
  runs: number;
  failed_runs: number;
  last_run: string | null;
  next_run: string | null;
  folder?: string;
  timezone?: string;
  lastLine?: string;
}
export interface SourceResult<T> {
  value: T | null;
  asOf: string | null;
  unavailable?: boolean;
}

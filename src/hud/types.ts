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
export interface Hud {
  generatedAt: string;
  timezone: string;
  cards: HudCard[];
  ticker: HudTickerItem[];
  today: HudToday;
  skills: HudSkill[];
  hiddenCount: number;
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

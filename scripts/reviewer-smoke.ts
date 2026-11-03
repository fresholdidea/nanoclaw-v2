/**
 * Smoke check for the reviewer-1 adversarial reviewer.
 *
 * Sends the golden fixture to reviewer-1 as a one-shot task via `ncl`, polls
 * its outbound DB for the reply, and scores the reply against the expected
 * findings manifest.
 *
 * Requires: NanoClaw host service running.
 * Usage: pnpm exec tsx scripts/reviewer-smoke.ts [--timeout-sec 300] [--keep-task]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';

export interface ExpectedFinding {
  id: string;
  label: string;
  /** Every group must contribute at least one semantic alternative. */
  signalGroups: string[][];
  /** At least one consequence/mechanism phrase must appear in the same block. */
  evidence: string[];
  /** Explicit denials that invalidate an otherwise matching block. */
  denials?: string[];
}

export interface Manifest {
  fixture: string;
  minimumDetected: number;
  expected: ExpectedFinding[];
}

export interface SmokeResult {
  detected: string[];
  missed: string[];
  contractFailures: string[];
  passed: boolean;
  blocked: boolean;
}

/**
 * Strip fenced code blocks so markers echoed back inside a quoted snippet
 * don't count as detections. A reviewer that pastes the query back and says
 * "no findings" must not score as a pass.
 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_.\-/]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep evidence tied to one finding paragraph/bullet instead of matching across the whole reply. */
function reviewBlocks(text: string): string[] {
  return stripFences(text)
    .replace(/\r/g, '')
    .split(/\n\s*\n|(?=\n\s*(?:[-*]|\d+[.)])\s+)/)
    .map(normalize)
    .filter(Boolean);
}

/** Score only FINDINGS when a structured report exists; QUESTIONS must never satisfy the golden defects. */
function findingsScope(reply: string): string {
  const findingsHeading = /(?:^|\n|OUTPUT:\s*)(?:#{1,6}\s*)?FINDINGS\s*:?(?:$|\n)/im.exec(reply);
  if (!findingsHeading || findingsHeading.index === undefined) return reply;

  const bodyStart = findingsHeading.index + findingsHeading[0].length;
  const remainder = reply.slice(bodyStart);
  const questionsHeading = /(?:^|\n)(?:#{1,6}\s*)?QUESTIONS\s*:?(?:$|\n)/im.exec(remainder);
  return questionsHeading?.index === undefined ? remainder : remainder.slice(0, questionsHeading.index);
}

function matchesFinding(block: string, finding: ExpectedFinding): boolean {
  const denied = (finding.denials ?? []).some((phrase) => block.includes(normalize(phrase)));
  if (denied) return false;

  const hasSignals = finding.signalGroups.every((group) =>
    group.some((phrase) => block.includes(normalize(phrase))),
  );
  const hasEvidence = finding.evidence.some((phrase) => block.includes(normalize(phrase)));
  return hasSignals && hasEvidence;
}

function reportContractFailures(reply: string): string[] {
  const failures: string[] = [];
  const heading = (name: string): RegExp =>
    new RegExp(`(?:^|\\n|OUTPUT:\\s*)(?:#{1,6}\\s*)?${name}\\s*:?(?:$|\\n)`, 'im');

  if (!heading('FINDINGS').test(reply)) failures.push('missing FINDINGS section');
  if (!heading('QUESTIONS').test(reply)) failures.push('missing QUESTIONS section');
  if (!/DONE:\s*reviewer-1\s*\|\s*OUTPUT:/i.test(reply)) failures.push('missing DONE envelope');
  if (/(?:^|\n)\s*(?:#{1,6}\s*)?(?:STRENGTHS|PRAISE)\s*:?(?:$|\n)/im.test(reply)) {
    failures.push('forbidden praise/strengths section');
  }
  return failures;
}

export function scoreReview(reply: string, manifest: Manifest): SmokeResult {
  const blocked = /^\s*BLOCKED:\s*reviewer-1/im.test(reply);
  const blocks = reviewBlocks(findingsScope(reply));

  const detected: string[] = [];
  const missed: string[] = [];
  for (const finding of manifest.expected) {
    const hit = blocks.some((block) => matchesFinding(block, finding));
    (hit ? detected : missed).push(finding.id);
  }

  const contractFailures = blocked ? [] : reportContractFailures(reply);

  return {
    detected,
    missed,
    contractFailures,
    passed: !blocked && contractFailures.length === 0 && detected.length >= manifest.minimumDetected,
    blocked,
  };
}

const GROUP_ID = 'ag-1779729652625-n3m1xl';
const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');

function ncl(args: string[]): string {
  return execFileSync('pnpm', ['run', '-s', 'ncl', ...args], {
    encoding: 'utf8',
    cwd: path.join(import.meta.dirname, '..'),
  });
}

function sessionDir(sessionId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', GROUP_ID, sessionId);
}

export function parseChatContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
  } catch {
    // Legacy/plain-text chat rows are already the reply body.
  }
  return content;
}

/** Newest chat reply written after `sinceIso`, ignoring system actions and task logs. */
export function latestChatReply(dbPath: string, sinceIso: string): string | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT content FROM messages_out
          WHERE kind = 'chat' AND datetime(timestamp) > datetime(?)
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(sinceIso) as { content: string } | undefined;
    return row ? parseChatContent(row.content) : null;
  } finally {
    db.close();
  }
}

function latestReply(sessionId: string, sinceIso: string): string | null {
  return latestChatReply(path.join(sessionDir(sessionId), 'outbound.db'), sinceIso);
}

async function main(): Promise<void> {
  const timeoutSec = Number(
    process.argv[process.argv.indexOf('--timeout-sec') + 1] || 300,
  );
  const keepTask = process.argv.includes('--keep-task');

  const manifest = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, 'reviewer-golden-expected.json'), 'utf8'),
  ) as Manifest;
  const payload = readFileSync(path.join(FIXTURE_DIR, manifest.fixture), 'utf8');

  const startedAt = new Date().toISOString();

  const createEnv = JSON.parse(
    ncl([
      'tasks',
      'create',
      '--group',
      GROUP_ID,
      '--name',
      'reviewer smoke',
      '--prompt',
      payload,
      '--process-after',
      new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      '--json',
    ]),
  ) as { ok: boolean; data: { series_id?: string; id?: string } };
  const seriesId = createEnv.data.series_id ?? createEnv.data.id;
  if (!seriesId) throw new Error(`tasks create returned no series id`);

  let exitCode = 0;
  try {
    ncl(['tasks', 'run', '--id', seriesId, '--group', GROUP_ID]);

    // `ncl tasks create` + `ncl tasks run` cause the host to spin up a
    // brand-new task session per task (thread_id `system:tasks:<seriesId>`);
    // the reply lands there, never in the group's long-lived system session.
    // Confirmed from host logs: the task session does not exist at `tasks
    // create` time — it's created only when the task fires — so this poll
    // must tolerate the session being absent for the first several seconds.
    // Both polls below share the one overall deadline; no second timeout.
    const deadline = Date.now() + timeoutSec * 1000;
    const expectedThreadId = `system:tasks:${seriesId}`;

    // `ncl --json` wraps every payload in an envelope: { id, ok, data }.
    // Verified 2026-08-01 — do not parse the output as a bare array.
    let taskSessionId: string | null = null;
    while (Date.now() < deadline) {
      const sessionEnv = JSON.parse(ncl(['sessions', 'list', '--json'])) as {
        ok: boolean;
        data: Array<{ id: string; agent_group_id: string; thread_id: string | null }>;
      };
      const match = sessionEnv.data.find(
        (s) => s.agent_group_id === GROUP_ID && s.thread_id === expectedThreadId,
      );
      if (match) {
        taskSessionId = match.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    let reply: string | null = null;
    if (taskSessionId) {
      while (Date.now() < deadline) {
        reply = latestReply(taskSessionId, startedAt);
        if (reply) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    if (!taskSessionId) {
      console.error(
        `FAIL: task session for ${expectedThreadId} never appeared within ${timeoutSec}s.`,
      );
      console.error(
        'The task never fired — check scheduling / logs/nanoclaw.error.log for the host side.',
      );
      exitCode = 1;
    } else if (!reply) {
      console.error(
        `FAIL: task session ${taskSessionId} appeared but produced no reply within ${timeoutSec}s.`,
      );
      console.error('The container likely ran and died silently. Check: docker ps,');
      console.error(`logs/nanoclaw.error.log, and groups/reviewer-1/conversations/ for an archived error.`);
      exitCode = 1;
    } else {
      const result = scoreReview(reply, manifest);
      console.log(`detected: ${result.detected.join(', ') || '(none)'}`);
      console.log(`missed:   ${result.missed.join(', ') || '(none)'}`);
      console.log(
        `contract: ${result.contractFailures.length === 0 ? 'PASS' : `FAIL — ${result.contractFailures.join('; ')}`}`,
      );
      if (result.blocked) console.log('reviewer replied BLOCKED');
      console.log('\n--- reply ---\n' + reply);
      exitCode = result.passed ? 0 : 1;
    }
  } finally {
    if (!keepTask) {
      try {
        ncl(['tasks', 'delete', '--id', seriesId, '--group', GROUP_ID]);
      } catch {
        console.error(`WARN: could not delete task ${seriesId} — remove it manually.`);
      }
    }
  }
  process.exit(exitCode);
}

// Entrypoint guard — REQUIRED, not optional. `scripts/reviewer-smoke.test.ts`
// imports scoreReview from this module. Without this guard, `pnpm exec vitest
// run` would execute main(), create a live task, and hang the suite.
if (process.argv[1]?.endsWith('reviewer-smoke.ts')) void main();

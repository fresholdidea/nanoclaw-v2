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
  markers: string[];
}

export interface Manifest {
  fixture: string;
  minimumDetected: number;
  expected: ExpectedFinding[];
}

export interface SmokeResult {
  detected: string[];
  missed: string[];
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

export function scoreReview(reply: string, manifest: Manifest): SmokeResult {
  const blocked = /^\s*BLOCKED:\s*reviewer-1/im.test(reply);
  const prose = stripFences(reply).toLowerCase();

  const detected: string[] = [];
  const missed: string[] = [];
  for (const finding of manifest.expected) {
    const hit = finding.markers.every((m) => prose.includes(m.toLowerCase()));
    (hit ? detected : missed).push(finding.id);
  }

  return {
    detected,
    missed,
    passed: !blocked && detected.length >= manifest.minimumDetected,
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

/** Newest messages_out body written after `sinceIso`, or null. */
function latestReply(sessionId: string, sinceIso: string): string | null {
  const dbPath = path.join(sessionDir(sessionId), 'outbound.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT content FROM messages_out
          WHERE datetime(timestamp) > datetime(?)
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(sinceIso) as { content: string } | undefined;
    return row?.content ?? null;
  } finally {
    db.close();
  }
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

  // `ncl --json` wraps every payload in an envelope: { id, ok, data }.
  // Verified 2026-08-01 — do not parse the output as a bare array.
  const sessionEnv = JSON.parse(ncl(['sessions', 'list', '--json'])) as {
    ok: boolean;
    data: Array<{ id: string; agent_group_id: string }>;
  };
  const session = sessionEnv.data.find((s) => s.agent_group_id === GROUP_ID);
  if (!session) throw new Error(`no session found for ${GROUP_ID}`);

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

    const deadline = Date.now() + timeoutSec * 1000;
    let reply: string | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      reply = latestReply(session.id, startedAt);
      if (reply) break;
    }

    if (!reply) {
      console.error(`FAIL: no reply within ${timeoutSec}s.`);
      console.error('Check: docker ps for the container, logs/nanoclaw.error.log,');
      console.error(`and groups/reviewer-1/conversations/ for an archived error.`);
      exitCode = 1;
    } else {
      const result = scoreReview(reply, manifest);
      console.log(`detected: ${result.detected.join(', ') || '(none)'}`);
      console.log(`missed:   ${result.missed.join(', ') || '(none)'}`);
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

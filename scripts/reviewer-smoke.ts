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

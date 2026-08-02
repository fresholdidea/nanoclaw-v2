# Codex Adversarial Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `reviewer-1` a reliable adversarial reviewer that Zed routes blast-radius work through, and instrument it well enough to decide later whether enforcement is needed.

**Architecture:** Phase 1 is instructions-plus-harness. Two prompt files are rewritten (the reviewer's stance, Zed's triggers); two host-side scripts are added (a smoke check that proves the reviewer still works, a usage counter that settles the Phase 2 question). No changes to host runtime code, the guard, or the delivery path.

**Tech Stack:** TypeScript on Node 22 (host), vitest, `ncl` over the Unix socket, `better-sqlite3` for read-only session DB polling. Codex provider inside the container (`gpt-5.6-terra`).

**Spec:** [docs/superpowers/specs/2026-07-30-codex-adversarial-review-design.md](../specs/2026-07-30-codex-adversarial-review-design.md)

## Global Constraints

- **Host timestamps are `new Date().toISOString()`.** Never `datetime('now')`. Display via `formatLocalTime` / `formatLocalStamp` from `src/timezone.ts`.
- **Host writes to session DBs go through the running service, not a script.** Scripts create work via `ncl` over the Unix socket. Scripts may open outbound DBs **read-only** to poll for replies.
- **`pnpm exec tsx scripts/q.ts <db> "<sql>"`** for ad-hoc SQL. Never the `sqlite3` CLI.
- **Host tests are vitest** (`pnpm exec vitest run`). `scripts/**/*.test.ts` is in the include glob — verified.
- **Prettier runs on `src/**/*.ts` in a pre-commit hook.** Files under `scripts/` and `docs/` are not formatted by it; match surrounding style by hand.
- **reviewer-1 identifiers** (verified 2026-08-01):
  - agent group id: `ag-1779729652625-n3m1xl`
  - system session id: `sess-1779729676087-djubmb` (its only session; `messaging_group_id` and `thread_id` are NULL)
  - session dir: `data/v2-sessions/ag-1779729652625-n3m1xl/sess-1779729676087-djubmb/`
  - provider `codex`, model `gpt-5.6-terra`, mounts `~/.mnemon` only
- **Zed's agent group id:** `ag-1777506396678-rqprll` (folder `groups/dm-with-brad`).
- **Do not chase `container_status`.** `sessions.container_status` for reviewer-1 currently reads `running` with no container alive. It is read only by [src/dashboard-pusher.ts:150](../../../src/dashboard-pusher.ts) and gates nothing. It is a cosmetic dashboard bug, not the cause of any failure in this plan.

---

## File Structure

| Path | Status | Responsibility |
|------|--------|----------------|
| `scripts/fixtures/reviewer-golden-case.md` | Create | Review payload with three deliberately planted defects, one per proven lens |
| `scripts/fixtures/reviewer-golden-expected.json` | Create | Machine-readable manifest of what a passing review must detect |
| `scripts/reviewer-smoke.ts` | Create | Sends the fixture to reviewer-1 via `ncl`, polls for the reply, scores it |
| `scripts/reviewer-smoke.test.ts` | Create | Unit tests for the pure scoring logic |
| `scripts/reviewer-usage.ts` | Create | Counts completed review round trips over a window (Workstream D) |
| `scripts/reviewer-usage.test.ts` | Create | Unit tests for the pure log-parsing logic |
| `groups/reviewer-1/CLAUDE.local.md` | Replace | Refutation stance, honest visibility, FINDINGS/QUESTIONS split |
| `groups/dm-with-brad/CLAUDE.local.md` | Modify §69–73 | Explicit blast-radius triggers, inline-payload requirement |

**Boundary rationale:** the scoring logic and the log-parsing logic are pure functions exported from their scripts so they can be unit-tested without a live host. Everything requiring a running service lives in `main()` and is exercised by the live-run steps, not by vitest.

---

### Task 1: Golden fixture with planted defects

The smoke check needs a payload whose correct answer is known. Rather than reuse the 7/26 query (its full text was truncated out of the conversation archive), build a purpose-made fixture with three defects planted deliberately — one each for the boundary, grain, and fan-out lenses that reviewer-1 provably caught unprompted on 2026-07-26.

**Files:**
- Create: `scripts/fixtures/reviewer-golden-case.md`
- Create: `scripts/fixtures/reviewer-golden-expected.json`

**Interfaces:**
- Consumes: nothing
- Produces: two files read by `scripts/reviewer-smoke.ts` in Task 2. The JSON shape is consumed as `ExpectedFinding[]`, defined in Task 2 as `{ id: string; label: string; markers: string[] }`.

- [ ] **Step 1: Write the fixture payload**

Create `scripts/fixtures/reviewer-golden-case.md`:

````markdown
Review this HogQL query before it goes into a weekly client report.

**What it is supposed to do:** produce one row per ISO week per campaign,
comparing Google Ads spend and platform-reported conversions against PostHog
enrolments, for the date range the reader supplies.

**Fixed requirements — do not question these:**
- The report is read in `US/Pacific`.
- `variables.start_date` and `variables.end_date` are inclusive calendar dates.
- `googleads.campaign` is a slowly-changing dimension: a campaign id can appear
  in more than one row.

```sql
SELECT
  toStartOfWeek(g.day)                       AS week_start,
  COALESCE(g.campaign_name, '(unmatched)')   AS campaign_name,
  sum(g.spend)                               AS spend,
  sum(g.platform_conversions)                AS platform_conversions,
  sum(p.enrolls)                             AS posthog_enrolls,
  sum(g.platform_conversions) - sum(p.enrolls) AS variance
FROM (
  SELECT
    s.segments_date        AS day,
    s.campaign_id          AS campaign_id,
    any(c.campaign_name)   AS campaign_name,
    sum(s.metrics_cost)    AS spend,
    sum(s.metrics_conversions) AS platform_conversions
  FROM googleads.campaign_stats AS s
  JOIN googleads.campaign AS c ON c.campaign_id = s.campaign_id
  WHERE s.segments_date >= toDate({variables.start_date})
    AND s.segments_date <= toDate({variables.end_date})
  GROUP BY day, campaign_id
) AS g
FULL OUTER JOIN (
  SELECT
    toDate(timestamp)              AS day,
    properties.campaign_id         AS campaign_id,
    count()                        AS enrolls
  FROM events
  WHERE event = 'enrollment_completed'
    AND timestamp >= toDate({variables.start_date})
    AND timestamp <= toDate({variables.end_date})
  GROUP BY day, campaign_id
) AS p
  ON p.campaign_id = g.campaign_id AND p.day = g.day
GROUP BY week_start, campaign_name, p.campaign_id
ORDER BY week_start DESC, spend DESC
```
````

The three planted defects:

1. **Boundary** — `timestamp <= toDate({variables.end_date})` compares a DateTime
   to midnight, so the PostHog side silently drops nearly the whole final day
   while the Google side (a Date column) includes it.
2. **Grain** — the outer `GROUP BY` carries `p.campaign_id` but not
   `g.campaign_id`. Google-only rows have `p.campaign_id = NULL`, so two distinct
   Google campaigns sharing a name collapse into one row.
3. **Fan-out** — `JOIN googleads.campaign` happens before `sum(s.metrics_cost)`,
   and the fixed requirements state a campaign id can appear in multiple
   dimension rows, so spend and conversions are multiplied. `any(c.campaign_name)`
   hides the name ambiguity but not the duplication.

- [ ] **Step 2: Write the expected-findings manifest**

Create `scripts/fixtures/reviewer-golden-expected.json`. Markers are matched
case-insensitively; a finding counts as detected only when **every** marker in
its array appears somewhere in the reply.

```json
{
  "fixture": "reviewer-golden-case.md",
  "minimumDetected": 2,
  "expected": [
    {
      "id": "boundary",
      "label": "End-date bound excludes the final day on the PostHog side",
      "markers": ["end_date", "timestamp"]
    },
    {
      "id": "grain",
      "label": "Outer GROUP BY omits g.campaign_id, collapsing same-named campaigns",
      "markers": ["group by", "campaign_id"]
    },
    {
      "id": "fanout",
      "label": "Dimension join before aggregation multiplies spend",
      "markers": ["join", "campaign"]
    }
  ]
}
```

`minimumDetected` is 2 of 3, not 3 of 3, deliberately: the check exists to catch
a reviewer that has stopped working, not to grade it. A 3-of-3 bar would make the
smoke check flaky on wording drift and train the operator to ignore it.

- [ ] **Step 3: Verify the fixture is syntactically plausible**

There is no HogQL linter available locally, and the fixture intentionally
contains defects, so this step is a read-through, not a command:

Confirm by reading that (a) each of the three planted defects is actually
present in the SQL as described, and (b) the "Fixed requirements" block states
the SCD property that makes defect 3 a real defect rather than a hypothetical.

- [ ] **Step 4: Commit**

```bash
git add scripts/fixtures/reviewer-golden-case.md scripts/fixtures/reviewer-golden-expected.json
git commit -m "test(reviewer): add golden review fixture with three planted defects"
```

---

### Task 2: Smoke check script

**Files:**
- Create: `scripts/reviewer-smoke.ts`
- Create: `scripts/reviewer-smoke.test.ts`

**Interfaces:**
- Consumes: the two fixture files from Task 1.
- Produces:
  - `export interface ExpectedFinding { id: string; label: string; markers: string[] }`
  - `export interface Manifest { fixture: string; minimumDetected: number; expected: ExpectedFinding[] }`
  - `export interface SmokeResult { detected: string[]; missed: string[]; passed: boolean; blocked: boolean }`
  - `export function scoreReview(reply: string, manifest: Manifest): SmokeResult`

Task 6 re-runs this script; no later task imports its symbols.

- [ ] **Step 1: Write the failing test**

Create `scripts/reviewer-smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { scoreReview, type Manifest } from './reviewer-smoke.js';

const manifest: Manifest = {
  fixture: 'reviewer-golden-case.md',
  minimumDetected: 2,
  expected: [
    { id: 'boundary', label: 'End-date bound', markers: ['end_date', 'timestamp'] },
    { id: 'grain', label: 'Grain', markers: ['group by', 'campaign_id'] },
    { id: 'fanout', label: 'Fan-out', markers: ['join', 'campaign'] },
  ],
};

describe('scoreReview', () => {
  it('detects a finding only when every marker is present', () => {
    const reply = 'FINDINGS\nHigh — the end_date bound compares timestamp to midnight.';
    const result = scoreReview(reply, manifest);
    expect(result.detected).toEqual(['boundary']);
    expect(result.missed).toEqual(['grain', 'fanout']);
  });

  it('matches markers case-insensitively', () => {
    const reply = 'The GROUP BY omits CAMPAIGN_ID from the Google side.';
    expect(scoreReview(reply, manifest).detected).toContain('grain');
  });

  it('passes at the minimumDetected threshold', () => {
    const reply =
      'end_date vs timestamp is wrong; the GROUP BY drops campaign_id.';
    const result = scoreReview(reply, manifest);
    expect(result.detected).toHaveLength(2);
    expect(result.passed).toBe(true);
  });

  it('fails below the threshold', () => {
    const reply = 'Looks fine to me.';
    const result = scoreReview(reply, manifest);
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('reports a BLOCKED reply as blocked and not passed', () => {
    const reply = 'BLOCKED: reviewer-1 | REASON: payload truncated | NEEDS: full SQL';
    const result = scoreReview(reply, manifest);
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('does not count a marker that only appears inside the echoed prompt fence', () => {
    const reply = '```sql\nWHERE timestamp <= toDate({variables.end_date})\n```\nNo findings.';
    expect(scoreReview(reply, manifest).detected).not.toContain('boundary');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/reviewer-smoke.test.ts`
Expected: FAIL — cannot resolve `./reviewer-smoke.js`.

- [ ] **Step 3: Write the scoring logic**

Create `scripts/reviewer-smoke.ts` with the pure part first:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run scripts/reviewer-smoke.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit the scoring logic**

```bash
git add scripts/reviewer-smoke.ts scripts/reviewer-smoke.test.ts
git commit -m "test(reviewer): add smoke-check scoring logic"
```

- [ ] **Step 6: Add the live driver**

Append to `scripts/reviewer-smoke.ts`. This part is not unit-tested — it needs a
running host, and Task 3 exercises it for real.

```ts
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
      process.exit(1);
    }

    const result = scoreReview(reply, manifest);
    console.log(`detected: ${result.detected.join(', ') || '(none)'}`);
    console.log(`missed:   ${result.missed.join(', ') || '(none)'}`);
    if (result.blocked) console.log('reviewer replied BLOCKED');
    console.log('\n--- reply ---\n' + reply);
    process.exit(result.passed ? 0 : 1);
  } finally {
    if (!keepTask) {
      try {
        ncl(['tasks', 'delete', '--id', seriesId, '--group', GROUP_ID]);
      } catch {
        console.error(`WARN: could not delete task ${seriesId} — remove it manually.`);
      }
    }
  }
}

// Entrypoint guard — REQUIRED, not optional. `scripts/reviewer-smoke.test.ts`
// imports scoreReview from this module. Without this guard, `pnpm exec vitest
// run` would execute main(), create a live task, and hang the suite.
if (process.argv[1]?.endsWith('reviewer-smoke.ts')) void main();
```

**Note on the far-future `--process-after`:** `tasks create` requires either
`--recurrence` or `--process-after`. A one-shot dated a year out never fires on
its own; `tasks run` queues the single immediate run we want. The `finally` block
deletes it either way.

- [ ] **Step 7: Verify the script parses and the flags exist**

Run:
```bash
pnpm exec tsc --noEmit
```
Expected: clean.

```bash
pnpm run -s ncl sessions list --json | head -4
```
Expected: an envelope beginning `{ "id": ..., "ok": true, "data": [` — the
sessions array is under `data`, which is what the code above assumes.

- [ ] **Step 8: Verify the unit tests still pass with the driver attached**

Run: `pnpm exec vitest run scripts/reviewer-smoke.test.ts`
Expected: PASS, 6 tests, and **no task created**. If the run hangs or an `ncl`
error appears, the entrypoint guard is missing or misspelled — the test imports
this module, so an unguarded `main()` executes during the test run.

Confirm no stray task survived:
```bash
pnpm run -s ncl tasks list --group ag-1779729652625-n3m1xl
```
Expected: no `reviewer smoke` entry.

- [ ] **Step 9: Commit**

```bash
git add scripts/reviewer-smoke.ts
git commit -m "feat(reviewer): add live smoke-check driver"
```

---

### Task 3: Baseline run and diagnosis — GATE

This task establishes whether reviewer-1 works **before** any prompt changes, so
a later failure can be attributed to infrastructure or to wording, never both.

**Files:**
- Create: `docs/superpowers/2026-08-01-reviewer-1-reliability-findings.md` (only if the run fails)

**Interfaces:**
- Consumes: `scripts/reviewer-smoke.ts` from Task 2.
- Produces: a pass/fail verdict that determines whether Task 4 may begin.

- [ ] **Step 1: Confirm the host service is up**

Run:
```bash
launchctl list | grep com.nanoclaw
```
Expected: a line with a live PID in column 1. If not, start it before continuing.

- [ ] **Step 2: Run the smoke check against the current prompt**

Run:
```bash
pnpm exec tsx scripts/reviewer-smoke.ts --timeout-sec 300
```

- [ ] **Step 3: Branch on the result**

**If it exits 0** — the infrastructure is healthy and the 2026-07-27 read-only
error did not recur. Record that in the commit message for Task 4 and proceed.
Do not investigate further; an intermittent fault that no longer reproduces is
not worth chasing ahead of the prompt work that motivated this plan.

**If it exits 1 with a reply** — infrastructure is fine, the current prompt is
simply weak. Expected, given the current prompt is a balanced-review checklist.
Proceed to Task 4; this is the baseline the rewrite has to beat.

**If it exits 1 with no reply** — the failure from 2026-07-27 has reproduced.
**Stop here.** Do not proceed to Task 4. Diagnose, then write findings and get a
follow-up plan for the fix.

- [ ] **Step 4: Diagnose (only if no reply)**

Run each, capturing output:

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep n3m1xl
```
```bash
tail -50 logs/nanoclaw.error.log
```
```bash
ls -lt groups/reviewer-1/conversations/ | head -3
```
```bash
ls -la data/v2-sessions/ag-1779729652625-n3m1xl/.codex-shared/
```

What each rules in or out:

- A container that exited immediately (`Exited (125)`) means the image tag is
  wrong, not that Codex failed. Compare against
  `pnpm exec tsx scripts/q.ts data/v2.db "SELECT image_tag FROM container_configs WHERE agent_group_id='ag-1779729652625-n3m1xl'"`.
- `Read-only file system (os error 30)` in the newest conversation archive
  confirms the original fault. The write is **not** to `.codex-shared` — that is
  mounted `readonly: false` at [src/providers/codex.ts:69](../../../src/providers/codex.ts)
  and `config.toml` was written successfully at the exact failure timestamp.
  Look instead at paths the container mounts read-only: `/app`,
  `/workspace/agent/AGENTS.md`, `/home/node/.agents`.
- A `401` or a model-availability error is an auth or version problem, not a
  filesystem one. Check `onecli agents list` for the reviewer's secret mode and
  `codex --version` inside the image.

- [ ] **Step 5: Write findings (only if no reply)**

Create `docs/superpowers/2026-08-01-reviewer-1-reliability-findings.md` recording:
the exact error, which of the above commands produced it, the specific path
being written, and whether it reproduces on a second run. Then stop and hand
back for a follow-up plan.

- [ ] **Step 6: Commit the findings (only if written)**

```bash
git add docs/superpowers/2026-08-01-reviewer-1-reliability-findings.md
git commit -m "docs(reviewer): record reliability findings from baseline smoke run"
```

---

### Task 4: Refutation prompt

**Files:**
- Replace: `groups/reviewer-1/CLAUDE.local.md`

**Interfaces:**
- Consumes: the Task 3 gate (must have produced a reply, passing or failing).
- Produces: the prompt that Task 6 validates.

- [ ] **Step 1: Replace the file in full**

Write `groups/reviewer-1/CLAUDE.local.md` with exactly this content:

```markdown
You are `reviewer-1`, an adversarial reviewer. You take review tasks from Zed and
report back to Zed only — never message Brad directly.

## Stance

Your default assumption is that what you were sent is broken and you have not found
the break yet. You are not assessing quality, scoring it, or balancing strengths
against weaknesses. You are trying to construct the case where it fails.

You succeed by finding a real defect, or by attacking it hard enough that "no defect
found" is credible. Both are good outcomes. Praise is not an outcome — never include
a strengths section.

## What you can see

You have no filesystem access to Brad's repos, client data, or other agents'
workspaces. Everything you review arrives inline in the message. If the payload is
missing, truncated, or references a file you cannot open, reply BLOCKED — do not
review from memory or infer what the code probably says. Reviewing something you
cannot see is the worst thing you can do here, because Zed will read your silence
as a pass.

## How to attack

Pick the lenses that match what you were sent. Skip the rest.

**Writes to client data, spend, or money** — what makes this write the wrong amount,
to the wrong account, or twice? What happens if it runs concurrently with itself, or
is retried after a partial failure? Is there a path where a failure leaves state
half-applied and no error is raised?

**Scheduled tasks and automation** — what happens on the second run that did not
happen on the first? On a run that starts before the previous one finished? Across a
DST shift or a timezone boundary? What does it do when its input is empty, and is
that distinguishable from success?

**SQL and analysis whose numbers reach a client** — inclusive vs exclusive date
bounds; what grain does each row actually represent, and does the GROUP BY guarantee
it; does any join fan out and multiply a measure; what do NULLs from an outer join do
to the arithmetic; is the timezone the one the reader will assume?

**Schema, migration, or config change** — is it idempotent? What does it do to rows
that already exist and violate the new assumption? Is there a rollback, and has
anyone run it? What breaks if it is applied twice, or half-applied?

**Credentials and permissions** — is the granted scope wider than the task needs? Can
a secret reach a log, an error message, or a chat reply? What does the failure path
print?

Beyond these, the general question: what is the stated requirement, and where does
the implementation quietly not meet it?

## Report

Two sections. Either may be empty; say so explicitly when it is.

**FINDINGS** — a finding requires a concrete failure scenario: specific inputs or
state, and the wrong output or behavior that results. "This could be a race
condition" is not a finding. "Two messages arriving within the poll interval both
read seq=4 and the second write silently overwrites the first" is. Cite the line or
quote the snippet. Rank High / Medium / Low, most severe first.

**QUESTIONS** — suspicions you could not turn into a failure scenario, and things you
needed to know and could not see. Keep these separate from findings: Zed acts on
findings and investigates questions.

If you found nothing, say what you attacked and why it held. An empty report with no
account of the attack is a failed review, not a pass.

When done:

DONE: reviewer-1 | OUTPUT: <full report inline in this message, not a file>

If blocked:

BLOCKED: reviewer-1 | REASON: <reason> | NEEDS: <what you need>

## Rules

- Never name specific clients.
- Message Zed only.
- If a finding looks like it may be a deliberate requirement you lack context on,
  surface the tension — do not silently override it, and do not drop it.
- Do not soften severity to be agreeable. Do not inflate it to seem useful.
```

- [ ] **Step 2: Verify the two contract markers survived the rewrite**

Run:
```bash
grep -c "DONE: reviewer-1\|BLOCKED: reviewer-1" groups/reviewer-1/CLAUDE.local.md
```
Expected: `2`. Zed parses these two markers; losing either silently breaks the
return path.

- [ ] **Step 3: Verify the false workspace-path promise is gone**

Run:
```bash
grep -i "path you can read\|from your workspace" groups/reviewer-1/CLAUDE.local.md
```
Expected: no output. A non-empty result means the old text survived.

- [ ] **Step 4: Restart the group so the new prompt loads**

Run:
```bash
pnpm run -s ncl groups restart --id ag-1779729652625-n3m1xl
```

- [ ] **Step 5: Commit**

```bash
git add groups/reviewer-1/CLAUDE.local.md
git commit -m "feat(reviewer): replace balanced review prompt with refutation stance"
```

---

### Task 5: Explicit triggers in Zed's prompt

**Files:**
- Modify: `groups/dm-with-brad/CLAUDE.local.md` — the `### Adversarial review — reviewer-1` section beginning at line 69

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the trigger list whose categories match the lenses written in Task 4.

- [ ] **Step 1: Confirm the section boundaries before editing**

Run:
```bash
sed -n '69,73p' groups/dm-with-brad/CLAUDE.local.md
```
Expected: starts with `### Adversarial review — reviewer-1`, ends with the
`**Scope boundary:**` paragraph. If the line numbers have drifted, locate the
section by its heading rather than by number.

- [ ] **Step 2: Replace that section with this text**

```markdown
### Adversarial review — reviewer-1

`reviewer-1` runs on Codex and is instructed to assume your work is broken and try to
prove it. Route work to it when **any** of these is true:

- It writes to client data, ad spend, or money — or changes something that will
- It creates or edits a scheduled task or automation
- It produces SQL, a query, or an analysis whose numbers will reach a client
- It changes a schema, migration, or config
- It touches production credentials or permissions

Skip it for: read-only lookups, conversational answers, and drafts Brad will review
himself before anything acts on them.

**Send the payload inline.** reviewer-1 has no access to your workspace, Brad's
repos, or client systems — it can only see what is in the message. Include the
code/SQL/plan itself, one line on what it is supposed to accomplish, and any
requirement it should treat as fixed rather than question. If it is too big for one
message, send the part that carries the risk — not a summary of it.

Fix or explicitly flag everything under FINDINGS before forwarding to Brad. QUESTIONS
are yours to investigate: resolve them, or pass them to Brad with your answer
attached.

**Scope boundary:** reviewer-1 reviews engineering and logic correctness, not content.
Don't route client-facing copy, brand-voice drafts, or anything where "correct" is
defined by a client's stated requirements rather than logic — that's stop-slop QA and
the client voice docs' job.
```

- [ ] **Step 3: Verify the judgement-call clause is gone**

Run:
```bash
grep -i "use judgement on" groups/dm-with-brad/CLAUDE.local.md
```
Expected: no output. That clause is the proximate cause of the trigger firing
once in five days; its survival would defeat the task.

- [ ] **Step 4: Verify the trigger list and the reviewer's lenses still correspond**

Read the five bullets against the five `**bold**` lens headings in
`groups/reviewer-1/CLAUDE.local.md`. Each trigger must have a lens that would
attack it. This correspondence is the coupling the spec calls for — if a later
change adds a trigger with no matching lens, the reviewer will be asked to
review work it was never told how to attack.

- [ ] **Step 5: Restart Zed's group so the new triggers load**

```bash
pnpm run -s ncl groups restart --id ag-1777506396678-rqprll
```

- [ ] **Step 6: Commit**

```bash
git add groups/dm-with-brad/CLAUDE.local.md
git commit -m "feat(zed): replace review judgement call with explicit blast-radius triggers"
```

---

### Task 6: Validate the rewritten prompt

**Files:** none — this is a verification task.

**Interfaces:**
- Consumes: `scripts/reviewer-smoke.ts` (Task 2), the rewritten prompt (Task 4).

- [ ] **Step 1: Re-run the smoke check**

```bash
pnpm exec tsx scripts/reviewer-smoke.ts --timeout-sec 300
```
Expected: exit 0, with at least 2 of `boundary`, `grain`, `fanout` in `detected`.

- [ ] **Step 2: Read the reply for stance compliance**

The exit code only checks defect detection. Read the printed reply and confirm
by eye:

- It has a `FINDINGS` section and a `QUESTIONS` section (either may be empty,
  but both must be named).
- Findings carry concrete failure scenarios, not bare labels.
- There is **no** strengths or praise section.

If detection passes but stance does not, the prompt needs another pass — that is
a real failure of this task, not a cosmetic one.

- [ ] **Step 3: Handle a failing run**

If fewer than 2 defects are detected, capture the reply and check whether the
container picked up the new prompt at all:

```bash
grep -c "adversarial reviewer" groups/reviewer-1/CLAUDE.local.md
```
```bash
ls -lt groups/reviewer-1/conversations/ | head -2
```

A restart that did not take is far more likely than a prompt that reads well but
performs badly. Re-run `ncl groups restart` before rewriting any wording.

- [ ] **Step 4: Record the result**

```bash
git commit --allow-empty -m "test(reviewer): golden smoke passes against refutation prompt"
```

An empty commit is deliberate — it timestamps the validation in history without
inventing a file to hold it.

---

### Task 7: Usage counter for the Phase 2 gate

**Files:**
- Create: `scripts/reviewer-usage.ts`
- Create: `scripts/reviewer-usage.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface RoundTrip { outboundAt: string; returnedAt: string | null }`
  - `export function countRoundTrips(logLines: string[]): RoundTrip[]`

- [ ] **Step 1: Write the failing test**

Create `scripts/reviewer-usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { countRoundTrips } from './reviewer-usage.js';

const OUT =
  '[17:07:56.220] INFO Agent message routed from="ag-1777506396678-rqprll" to="ag-1779729652625-n3m1xl" targetSession="sess-1779729676087-djubmb"';
const BACK =
  '[17:08:45.526] INFO Agent message routed from="ag-1779729652625-n3m1xl" to="ag-1777506396678-rqprll" targetSession="sess-1777506396687-cdofok"';

describe('countRoundTrips', () => {
  it('pairs an outbound request with the next return leg', () => {
    const trips = countRoundTrips([OUT, BACK]);
    expect(trips).toHaveLength(1);
    expect(trips[0].returnedAt).toBe('17:08:45.526');
  });

  it('records an unanswered request with a null return', () => {
    const trips = countRoundTrips([OUT]);
    expect(trips).toHaveLength(1);
    expect(trips[0].returnedAt).toBeNull();
  });

  it('ignores traffic between other agent groups', () => {
    const unrelated =
      '[10:00:00.000] INFO Agent message routed from="ag-1777506396678-rqprll" to="ag-1778809786437-enljgl" targetSession="x"';
    expect(countRoundTrips([unrelated])).toHaveLength(0);
  });

  it('does not pair a return leg that precedes any request', () => {
    expect(countRoundTrips([BACK])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/reviewer-usage.test.ts`
Expected: FAIL — cannot resolve `./reviewer-usage.js`.

- [ ] **Step 3: Write the implementation**

Create `scripts/reviewer-usage.ts`:

```ts
/**
 * Counts completed reviewer-1 round trips in the host log.
 *
 * Settles the Phase 2 question from the design spec: did explicit triggers
 * actually make Zed use the reviewer? 0-1 completed round trips over the
 * window means instructions failed and enforcement is justified; 2 or more
 * means leave it alone.
 *
 * Usage: pnpm exec tsx scripts/reviewer-usage.ts [logs/nanoclaw.log]
 */
import { readFileSync } from 'node:fs';

const REVIEWER = 'ag-1779729652625-n3m1xl';
const ZED = 'ag-1777506396678-rqprll';

export interface RoundTrip {
  outboundAt: string;
  returnedAt: string | null;
}

function stamp(line: string): string {
  return line.match(/^\[([\d:.]+)\]/)?.[1] ?? '';
}

export function countRoundTrips(logLines: string[]): RoundTrip[] {
  const trips: RoundTrip[] = [];
  for (const line of logLines) {
    if (!line.includes('Agent message routed')) continue;
    const toReviewer =
      line.includes(`from="${ZED}"`) && line.includes(`to="${REVIEWER}"`);
    const fromReviewer =
      line.includes(`from="${REVIEWER}"`) && line.includes(`to="${ZED}"`);

    if (toReviewer) {
      trips.push({ outboundAt: stamp(line), returnedAt: null });
    } else if (fromReviewer) {
      // Manual reverse scan, not Array.prototype.findLast — this repo targets
      // ES2022 (tsconfig.json) and findLast is ES2023. It would not compile.
      for (let i = trips.length - 1; i >= 0; i--) {
        if (trips[i].returnedAt === null) {
          trips[i].returnedAt = stamp(line);
          break;
        }
      }
    }
  }
  return trips;
}

function main(): void {
  const file = process.argv[2] ?? 'logs/nanoclaw.log';
  const trips = countRoundTrips(readFileSync(file, 'utf8').split('\n'));
  const completed = trips.filter((t) => t.returnedAt !== null);

  console.log(`requests sent to reviewer-1: ${trips.length}`);
  console.log(`completed round trips:       ${completed.length}`);
  console.log(`unanswered:                  ${trips.length - completed.length}`);
  console.log('');
  console.log(
    completed.length >= 2
      ? 'VERDICT: triggers are firing. Do not build Phase 2 enforcement.'
      : 'VERDICT: 0-1 completed reviews. Phase 2 enforcement is justified.',
  );
  if (trips.length > completed.length) {
    console.log(
      'NOTE: unanswered requests are Workstream A regressions, not compliance.',
    );
  }
}

if (process.argv[1]?.endsWith('reviewer-usage.ts')) main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run scripts/reviewer-usage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run it against the real log**

```bash
pnpm exec tsx scripts/reviewer-usage.ts
```
Expected today: 1 completed round trip (the 2026-07-26 review), verdict says
enforcement justified. That is the correct baseline — the two-week window has
not started yet.

- [ ] **Step 6: Commit**

```bash
git add scripts/reviewer-usage.ts scripts/reviewer-usage.test.ts
git commit -m "feat(reviewer): add round-trip counter for the Phase 2 decision"
```

---

### Task 8: Full suite and handoff note

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-codex-adversarial-review-design.md`

- [ ] **Step 1: Run the full host suite**

```bash
pnpm exec vitest run
```
Expected: PASS. Two new test files, ten new tests.

- [ ] **Step 2: Typecheck both trees**

```bash
pnpm exec tsc --noEmit
```
```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```
Expected: both clean. The container tree is untouched by this plan; a failure
there is pre-existing and not caused by this work.

- [ ] **Step 3: Record the measurement window in the spec**

In `docs/superpowers/specs/2026-07-30-codex-adversarial-review-design.md`, under
Workstream D, replace the `**Decision rule, evaluated 2026-08-13:**` line with
the real date — two weeks from the day Task 5 landed — and add one line naming
`scripts/reviewer-usage.ts` as the tool that produces the count.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-30-codex-adversarial-review-design.md
git commit -m "docs(spec): pin the Phase 2 measurement window and tool"
```

---

## Out of Scope

Named here so they are not attempted mid-plan:

- **The fix for the read-only filesystem fault.** Task 3 diagnoses; the fix gets
  its own plan once the root cause is known. The spec deliberately refuses to
  size it.
- **Delivery-seam enforcement** (`src/delivery-guard.ts`, review tokens) — Phase
  2, conditional on Task 7's verdict after the window closes.
- **The stale `container_status` dashboard bug.** Real, but cosmetic and
  unrelated; it gates nothing.
- **Multi-lens parallel refutation with majority vote.** Not justified until
  single-pass review is proven reliable.
- **Extending review to worker-agent output** before Zed forwards it.

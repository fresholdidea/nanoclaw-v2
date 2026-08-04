import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { latestChatReply, parseChatContent, scoreReview, type Manifest } from './reviewer-smoke.js';

const manifest: Manifest = {
  fixture: 'reviewer-golden-case.md',
  minimumDetected: 2,
  expected: [
    {
      id: 'boundary',
      label: 'End-date bound',
      signalGroups: [
        ['end_date', 'end date', 'upper bound', 'final day'],
        ['timestamp', 'midnight', 'inclusive', 'calendar date'],
      ],
      evidence: ['exclude', 'drop', 'miss', 'midnight', 'non-inclusive'],
      denials: ['no boundary defect', 'end date is correctly inclusive'],
    },
    {
      id: 'grain',
      label: 'Grain',
      signalGroups: [
        ['g.campaign_id', 'google-only', 'campaign grouping'],
        ['group by', 'grouping', 'row grain'],
      ],
      evidence: ['collapse', 'merge', 'same name', 'same-named', 'distinct campaigns'],
      denials: ['no grain defect', 'grouping preserves distinct campaigns'],
    },
    {
      id: 'fanout',
      label: 'Fan-out',
      signalGroups: [
        ['fan-out', 'fanout', 'scd join', 'scd row', 'dimension join', 'join inflation', 'join emits'],
      ],
      evidence: ['duplicat', 'multipl', 'inflation', 'two copies', 'twice', 'doubl', 'double count', 'overcount'],
      denials: ['no fanout', 'no fan-out', 'join cannot fan out'],
    },
  ],
};

function completeReport(findings: string): string {
  return `DONE: reviewer-1 | OUTPUT:
### FINDINGS
${findings}

### QUESTIONS
None.`;
}

describe('scoreReview', () => {
  it('detects semantic alternatives only with consequence evidence in the same finding block', () => {
    const reply = completeReport(
      '- High — The SCD join happens before aggregation, causing spend inflation for every duplicate dimension row.',
    );
    const result = scoreReview(reply, manifest);
    expect(result.detected).toEqual(['fanout']);
    expect(result.missed).toEqual(['boundary', 'grain']);
  });

  it('recognizes an SCD-row duplication scenario without requiring the phrase fan-out', () => {
    const reply = completeReport(
      '- High — A campaign has two SCD rows, so the join emits two copies and reports twice the spend.',
    );
    expect(scoreReview(reply, manifest).detected).toContain('fanout');
  });

  it('normalizes punctuation, underscores, and case', () => {
    const reply = completeReport(
      '- High — The outer GROUP BY omits G.CAMPAIGN_ID, so same-named campaigns collapse into one row.',
    );
    expect(scoreReview(reply, manifest).detected).toContain('grain');
  });

  it('passes only when the detection threshold and complete report contract both pass', () => {
    const reply = completeReport(`- High — TIMESTAMP <= END_DATE compares against midnight, so the final day is excluded.

- High — The outer GROUP BY omits g.campaign_id, so distinct same-name campaigns collapse.`);
    const result = scoreReview(reply, manifest);
    expect(result.detected).toEqual(['boundary', 'grain']);
    expect(result.contractFailures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('does not count a bare semantic label without a mechanism or consequence', () => {
    const reply = completeReport('- High — There is incorrect campaign grouping.');
    expect(scoreReview(reply, manifest).detected).not.toContain('grain');
  });

  it('does not combine a signal in one block with evidence from another block', () => {
    const reply = completeReport(`- High — There is an SCD join.

- Medium — An unrelated calculation can inflate totals.`);
    expect(scoreReview(reply, manifest).detected).not.toContain('fanout');
  });

  it('rejects explicit denial even when semantic and evidence phrases are present', () => {
    const reply = completeReport(
      '- None — There is no fanout: the dimension join does not duplicate or multiply spend.',
    );
    expect(scoreReview(reply, manifest).detected).not.toContain('fanout');
  });

  it('does not count a suspected defect that appears only under QUESTIONS', () => {
    const reply = `DONE: reviewer-1 | OUTPUT:
### FINDINGS
None.

### QUESTIONS
Could the SCD join emit duplicate rows and inflate spend?`;
    expect(scoreReview(reply, manifest).detected).not.toContain('fanout');
  });

  it('recognizes terse semantic detections but fails their missing report contract', () => {
    const reply =
      'Review complete: block deployment for SCD join inflation and a non-inclusive end-date timestamp filter.';
    const result = scoreReview(reply, manifest);
    expect(result.detected).toEqual(['boundary', 'fanout']);
    expect(result.contractFailures).toEqual([
      'missing FINDINGS section',
      'missing QUESTIONS section',
      'missing DONE envelope',
    ]);
    expect(result.passed).toBe(false);
  });

  it('fails a structured report that omits the DONE envelope', () => {
    const reply = `### FINDINGS
- High — The end date is midnight, so timestamp rows on the final day are excluded.

### QUESTIONS
None.`;
    expect(scoreReview(reply, manifest).contractFailures).toContain('missing DONE envelope');
  });

  it('fails a report with a forbidden strengths section', () => {
    const reply = `${completeReport('- None — no findings.')}

### STRENGTHS
Good naming.`;
    expect(scoreReview(reply, manifest).contractFailures).toContain('forbidden praise/strengths section');
  });

  it('reports a BLOCKED reply as blocked without applying the success contract', () => {
    const reply = 'BLOCKED: reviewer-1 | REASON: payload truncated | NEEDS: full SQL';
    const result = scoreReview(reply, manifest);
    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.contractFailures).toEqual([]);
  });

  it('does not count signals and evidence that only appear inside an echoed code fence', () => {
    const reply = completeReport(`\`\`\`sql
-- end_date timestamp excludes final day; SCD join duplicates spend
\`\`\`
No findings after review.`);
    expect(scoreReview(reply, manifest).detected).toEqual([]);
  });
});

describe('live reply extraction', () => {
  it('unwraps JSON chat text while preserving legacy plain text', () => {
    expect(parseChatContent('{"text":"DONE: reviewer-1"}')).toBe('DONE: reviewer-1');
    expect(parseChatContent('plain reply')).toBe('plain reply');
  });

  it('ignores newer system actions and task logs when selecting the final chat reply', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-smoke-outbox-'));
    const dbPath = path.join(root, 'outbound.db');
    const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE messages_out (
        seq INTEGER,
        timestamp TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL
      )`);
      const insert = db.prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?)');
      insert.run(1, '2026-08-04T12:00:01.000Z', 'system', '{"action":"cli_request"}');
      insert.run(3, '2026-08-04T12:00:02.000Z', 'chat', '{"text":"full findings"}');
      insert.run(5, '2026-08-04T12:00:03.000Z', 'task_log', '{"text":"summary"}');
    } finally {
      db.close();
    }

    try {
      expect(latestChatReply(dbPath, '2026-08-04T12:00:00.000Z')).toBe('full findings');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

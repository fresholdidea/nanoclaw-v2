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

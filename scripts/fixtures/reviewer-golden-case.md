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

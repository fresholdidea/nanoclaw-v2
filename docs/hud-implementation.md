# Fleet HUD implementation

The host pushes an additive `hud` field with the existing dashboard snapshot. The
linked dashboard fork renders it above the Fleet chart and exposes the same data
at authenticated `GET /api/hud`. The existing chart and activity strip remain.
No task execution or workspace-file serving endpoint was added.

## Configuration

These keys are read with `readEnvFile` on each push. An unset source path produces
missing data. The values below match the source locations in the October 14 spec;
set them in the deployed host's `.env` when activating the change.

```dotenv
HUD_PRIMARY_GROUP=dm-with-brad
HUD_STEWARD_GROUP=steward
HUD_BILLING_GROUP=billing
HUD_INBOX_OPS_GROUP=inbox-ops
HUD_VAULT_DIR=/Users/bradhess/Documents/Obsidian/JBH
HUD_AD_METRICS_DB=/Users/bradhess/.local/share/ad-metrics/data/exports/all/all.db
HUD_EXCLUSIONS=true
```

Billing remains the ledger source because it has the verified sent rows. Change
`HUD_BILLING_GROUP` when invoice-ledger ownership actually moves. No credentials
are needed beyond the dashboard's existing authentication configuration.

## Data and interaction behavior

- Source reads cache successful parses by mtime/size; SQLite also checks its WAL.
  Read/parse failures preserve the last good value and its original timestamp,
  marked unavailable. Without a prior value, cards show no data. Empty/truncated
  ledger tables never become zero. An empty watchdog intentionally clears its warning.
- Freshness uses source timestamps, explicit Current.md expiry, and the age of the
  HUD snapshot. A stopped pusher makes all available data stale after 90 seconds.
  Calendar, directives, and prep notes have separate source freshness.
- Exclusions apply before financial aggregation and again to emitted content.
  Registry aliases extend the built-in exclusion floor. Setting `HUD_EXCLUSIONS=false`
  is the explicit opt-out. Current.md is withheld as a whole if its pre-aggregated
  content matches an exclusion.
- Ad spend compares the same reported day count in the prior month. Sparse daily
  history omits its sparkline instead of inventing zero-spend dates.
- Tokens use timestamped Claude session JSONL, with a cached parser and weekly
  totals in the install timezone. The secondary line sums scheduled runs/items/hops
  from the usage ledger. This is observed usage, not a plan quota percentage.
- Task data uses the CLI's existing series projection. An incomplete task inventory
  retains the previous result. Task collection receives a 100 ms deadline; file
  collection shares a 200 ms overall deadline. Synchronous filesystem/SQLite calls
  cannot be preempted, so this is a best-effort budget, not a hard realtime bound.
- Copy buttons only copy commands or request phrases. Directive checkboxes save to
  localStorage by directive key and local date; they never resolve host records.
- The HUD shares Fleet's existing one-minute refresh and interaction guard. Open
  details, keyboard focus, and in-flight pointer actions defer DOM replacement.
  The existing five-minute maximum deferral remains.
- Receivables lists the newest report filename and links to the associated task's
  Messages page when available. Workspace reports are not exposed as HTTP files.
- Optional fields extend the brief's types: `validUntil`, `unavailable`, separate
  Today freshness, directive overflow, `timezone`, and `hiddenCount`.

## Delivery locations

- Host branch: `feat/hud-host`, worktree `.worktrees/hud-host`.
- Dashboard branch: `feat/hud-dashboard`, worktree `.worktrees/hud-dashboard`.
- Main checkout and live service were not changed or restarted.
- The dashboard's `docs/hud-spec.md` remains in its original checkout.
- The add-dashboard resource copy includes `hud/`, and its recipe describes the
  task-series projection, so reapplying the skill preserves this feature.

Activation requires landing both branches, setting the source paths above,
building the dashboard fork and host, then restarting the host. Follow the
installation's normal land/stamp process. No group deletion, access-wall repair,
client-dashboard repair, or credential changes are part of this implementation.

## Verification

Both TypeScript builds passed. The full host suite passed (3,957 tests and 18
skipped at the full-suite checkpoint); after final parser and task-projection
refinements, all 53 focused source/task/pusher tests passed. Dashboard node tests
passed (29). Headless Chrome checks covered 1440 and 375 px, light and dark,
authenticated `/api/hud`, unauthenticated rejection, copy controls, ticker filters,
checkbox persistence, and refresh deferral followed by flush. No page errors or
horizontal overflow occurred.

Read-only source verification matched $20,554 receivables, 8 waiting items,
86 Plane assignments, 14 walls, and six pending meeting-review files. The skills
source currently has 26 readable entries, rather than the earlier spec's 20.
The file collector measured about 90–110 ms cold and 27–32 ms cached. This check
did not run a production pusher or mutate any source. Calendar data remains
missing before today's briefing pull exists.

Temporary browser evidence and logs are in `/tmp/hud-verification/`. These are
local checks; production `/api/hud` verification is still required after landing.

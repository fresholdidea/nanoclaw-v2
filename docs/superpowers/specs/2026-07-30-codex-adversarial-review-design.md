# Codex Adversarial Review — Design

**Date:** 2026-07-30
**Status:** Approved, ready for implementation planning
**Scope:** NanoClaw runtime (agent groups), not the host dev loop

## Problem

Adversarial review is claimed in Zed's instructions but not delivered in practice.
Four independent defects each prevent it from working:

| # | Defect | Evidence |
|---|--------|----------|
| 1 | The reviewer is not adversarial | `groups/reviewer-1/CLAUDE.local.md` asks for balanced six-dimension review. Only Zed's side (`dm-with-brad/CLAUDE.local.md:71`) describes it as adversarial. |
| 2 | The trigger is a judgement call | `"use judgement on 'non-trivial'"` — fired once in five days. |
| 3 | It does not reliably run | Last session (2026-07-27 16:22) ended `Read-only file system (os error 30)`. One success in four real attempts. |
| 4 | It is told it can read files it cannot | Prompt promises "a path you can read from your workspace". `container.json` mounts only `~/.mnemon` — no repo, no client data, no worker workspaces. |

### Session history

| Date | Outcome |
|------|---------|
| 2026-07-26 10:55 | `401 Unauthorized` → self-feeding error loop, 50 dead sessions (fixed by `c566b78`) |
| 2026-07-26 12:09 | `'gpt-5.6-terra' requires a newer version of Codex` (fixed by `162a48a`) |
| 2026-07-26 16:18 | Smoke test passed |
| 2026-07-26 ~17:07 | The one real review — three grounded High findings on a HogQL/Google Ads variance query |
| 2026-07-27 16:22 | `Read-only file system (os error 30)` — last recorded activity |

The one successful review is the existence proof that this is worth fixing. It caught an
end-date boundary silently excluding the final day, an outer `GROUP BY` collapsing distinct
campaign IDs into one row, and a dimension-join fan-out multiplying spend — the class of
defect a same-family reviewer nods past.

## Decisions

Three scoping decisions were made before design:

1. **Where:** NanoClaw runtime (container agents), not the host dev loop for this repo.
2. **Enforcement:** Instructions now, enforcement later — conditional on measured evidence.
3. **Trigger set:** Blast radius (explicit list), not an irreversibility judgement call, and
   not extended to worker-agent output in Phase 1.

## Architecture

Zed (`dm-with-brad`, `ag-1777506396678-rqprll`) is the hub of a hub-and-spoke a2a fabric:
13 worker agent groups, each with a `parent` destination back to Zed, plus three channel
destinations. `reviewer-1` (`ag-1779729652625-n3m1xl`) is one of those spokes —
`provider=codex`, `model=gpt-5.6-terra`, no channel wiring, `parent` → Zed only.

Because Zed forwards all worker output to Brad, routing Zed's outbound deliverables through
`reviewer-1` covers worker-produced work transitively. Phase 1 therefore adds no new
destinations and no new agent groups.

**Hard constraint:** `reviewer-1` has no filesystem access to repos, client systems, or other
agents' workspaces. Its only mount is `~/.mnemon`. Every review payload must arrive inline in
the a2a message. This constraint is load-bearing for the prompt design — see Workstream B.

### Coupling principle

The attack lenses in the reviewer's prompt map one-to-one onto the trigger list in Zed's
prompt. Whatever class of work trips the trigger determines what the reviewer is told to
attack. Adding a trigger later means adding the matching lens; the coupling is explicit so
the two files cannot silently drift apart the way they did before.

## Workstream A — Reliability (blocking prerequisite)

Nothing else is worth shipping on an agent that errors on spawn.

**Goal:** root-cause and fix `Read-only file system (os error 30)`, then leave behind a
re-runnable smoke check.

**What is already known:**

- `.codex-shared` is mounted `readonly: false` (`src/providers/codex.ts:69`) and
  `config.toml` was successfully written at the exact failure timestamp — the mount itself
  is writable.
- `config.toml` sets `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`,
  so Codex is not sandbox-restricting itself.
- The error surfaced through Codex's `Reconnecting... 2/5:` retry loop, the same channel
  that surfaced the earlier `401`. The retry loop reports the underlying error, so the
  failing write happens somewhere in the reconnect path.
- Container mounts that *are* readonly: `/app` (shared agent-runner source),
  `/workspace/agent/AGENTS.md`, `/home/node/.agents`.

**Deliverables:**

1. Live reproduction with a controlled review task.
2. Identification of the path Codex is writing to during reconnect.
3. Fix — likely a mount or env correction, but explicitly unscoped until reproduced.
4. A smoke check that can be re-run on demand, so the next silent breakage surfaces in
   seconds rather than five days.

**Sizing note:** this workstream is deliberately not estimated. It could be a one-line mount
fix or something structural in how Codex handles writes during reconnect. Determining which
is the first implementation step.

## Workstream B — Refutation prompt

Replaces `groups/reviewer-1/CLAUDE.local.md` in full.

### Rationale for the three structural changes

**Stance before checklist.** The current prompt opens with a six-dimension review checklist,
which produces balanced assessment. The replacement opens by establishing the default
assumption — that the work is broken and the break has not been found yet.

**Honest visibility.** The current prompt's promise of "a path you can read from your
workspace" is false and dangerous: it invites reviewing from inference when the payload is
missing, and Zed reads a returned review as a pass regardless of whether the reviewer
actually saw anything.

**FINDINGS / QUESTIONS split.** The current prompt says *"Do not report hunches as
findings."* Right instinct, wrong mechanism — it suppresses suspicion rather than routing it.
Two channels keep the evidentiary bar high on FINDINGS while giving the adversarial instinct
somewhere to go. The closing rule — an empty report must account for the attack — makes a
rubber-stamp visibly cheap.

### Full replacement text

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

## Workstream C — Explicit triggers

Replaces the `### Adversarial review — reviewer-1` section at
`groups/dm-with-brad/CLAUDE.local.md:69–73`.

The `"use judgement on 'non-trivial'"` clause is removed. That clause is the proximate cause
of defect #2.

### Full replacement text

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

## Workstream D — Phase 2 gate

Phase 1 is instructions-only. Nothing prevents Zed from skipping a review. This is a
deliberate bet, and Workstream D is how the bet gets settled.

**Measurement approach:** count `reviewer-1` a2a round-trips over two weeks from the host
side — `logs/nanoclaw.log` (`Agent message routed` lines with
`to="ag-1779729652625-n3m1xl"` and the matching return leg) and `reviewer-1`'s session DB.

**Why host-side rather than agent self-reporting:** an agent that skips a review will also
skip logging that it skipped. Self-reported compliance data is generated by the party whose
compliance is in question. Host logs require no agent cooperation and no implementation work.

**Decision rule, evaluated 2026-08-13:**

- **0–1 completed reviews in the two weeks** → instructions failed. Phase 2 (delivery-seam
  enforcement via `src/delivery-guard.ts` and a review-token concept) is justified.
- **2 or more** → the trigger is firing. Leave it alone; do not build enforcement.

A "completed review" means a round trip: an `Agent message routed` line to
`ag-1779729652625-n3m1xl` followed by a return leg carrying a `DONE: reviewer-1` payload.
Outbound requests that error or never return do not count — those are Workstream A
regressions, and should be handled as such rather than read as compliance.

## Out of scope for Phase 1

- Delivery-seam enforcement (`delivery-guard.ts`, review tokens) — Phase 2, conditional.
- Multi-lens parallel refutation with majority vote — higher quality per review, higher
  token cost, not justified until single-pass review is proven to run reliably.
- Extending review to worker-agent output before Zed forwards it — covered transitively for
  now; revisit if Phase 1 measurement shows Zed forwarding unreviewed worker code.
- Any change to the host dev loop for this repo. Claude-reviewing-Claude in
  `~/.claude/agents/code-reviewer.md`, `superpowers:requesting-code-review`, and CI remains
  as-is.

## Risks

| Risk | Mitigation |
|------|------------|
| Workstream A turns out to be structural, not a quick mount fix | Reproduce first, size second. Do not commit to a Phase 1 ship date before A is understood. |
| Instructions alone do not change behavior | That is precisely what Workstream D measures. Phase 2 exists for this outcome. |
| Payload-too-large for inline review on bigger changes | Prompt instructs sending the risk-carrying part, not a summary. If this proves to be a recurring blocker, a read-only mount for a review drop directory is the natural Phase 2 addition. |
| `gpt-5.6-terra` model availability drifts again | The smoke check from Workstream A should assert the model answers, not just that the container spawns. |

# Notes on scope

## v1 composition

`references/patterns.md` holds 51 patterns:

| Source | Count |
|--------|-------|
| humanizer (all 35, renumbered and regrouped) | 35 |
| stop-slop (tells humanizer lacks) | 11 |
| Wikipedia "Signs of AI writing" (gaps humanizer does not carry) | 5 |

humanizer derives from the same Wikipedia page, so the five Wikipedia entries are only the tells humanizer left out and that transfer to business prose. Wikipedia's markup category (broken wikitext, nonexistent templates and categories) was dropped as wiki-specific.

Two source conflicts were resolved rather than merged. Both are recorded in the patterns file:

- **Em dashes.** stop-slop bans them, humanizer flags overuse. Strict ban wins. See pattern 23.
- **Adverbs.** stop-slop bans all of them, humanizer warns against flattening formal vocabulary. Ban wins with two carve-outs. See pattern 14.

## Excluded from v1: StoryScope

**What it is.** StoryScope (arXiv 2604.03136) detects machine-generated fiction from narrative structure rather than from surface language. Instead of looking at word choice or punctuation, it extracts features describing how a story is built: character agency, chronological continuity, presence of dream or vision sequences, and the escalation pattern of events across the narrative.

**Headline result.** 93.2% macro-F1 separating human from machine fiction using narrative features alone, with no lexical or stylometric signal. That is a strong result, and it says something real: machine text has a structural signature, not only a vocabulary.

**Why it is not in v1.** The corpus is 61,608 fiction stories. Every feature it uses is a property of narrative. Character agency, dream sequences, and chronological discontinuity have no counterpart in a campaign brief, a scope of work, or a client status email. Encoding them here would produce rules that never fire, or worse, rules that fire on the wrong thing. The transfer from fiction structure to business prose structure is unproven, and this skill is built around not shipping unproven claims.

**One candidate worth investigating later.** StoryScope's *event escalation* feature measures whether successive events in a story build in consequence. Human fiction escalates unevenly; machine fiction escalates flatly or on a schedule. The possible business-prose analogue is a document in which every paragraph carries the same weight and no argument builds: each section states a fact of equal size, nothing depends on what came before, and the piece could be read in any order without loss. Call it flat argumentative escalation.

**Mark this clearly.** The paper does not make this claim. It tested fiction and reported on fiction. The mapping from event escalation to argument escalation is an extrapolation made here, untested, and it should be validated against real client documents before it becomes a pattern. It is written down so the idea is not lost, not because it is a finding.

Adjacent note: pattern 48 (metronomic rhythm) already catches uniform *sentence* cadence. Flat argumentative escalation would be the same failure one level up, at the paragraph and section level. That adjacency is the reason the idea looks promising and also the reason it might turn out to be redundant.

## Relationship to stop-slop

This skill supersedes stop-slop. The original at `~/.claude/skills/stop-slop/` was read and left unmodified. Everything in it is carried forward: all phrase lists, all structure tables, all five examples, and the five-dimension scoring table.

One correction was made in transit. stop-slop's published Example 4 rewrite contained an em dash, contradicting its own rule 6. The version in `references/examples.md` is fixed and the change is flagged in place.

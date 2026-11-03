---
name: humanize
description: Strip AI writing patterns from prose without changing what it says. MUST run before any email, client deliverable, proposal, report, ad/social/web copy, or other client- or public-facing text leaves the agent (drafted, sent, or saved to a file). Not for chat replies to the operator. Includes a mandatory claim-fidelity check.
metadata:
  trigger: Writing prose, editing drafts, reviewing content for AI patterns, preparing client-facing copy
  supersedes: stop-slop
  sources: humanizer (github.com/blader/humanizer, MIT), stop-slop by Hardik Pandya (MIT), Wikipedia "Signs of AI writing" (WikiProject AI Cleanup)
---

# Humanize

Rewrite text so it reads like the writer, not a chatbot, and says exactly what the source said.

Two things make this skill different from a style pass. It never lets a rewrite change a fact. It never overrides a client's own voice document.

## The pass

Run all four steps. Step 3 is not optional.

1. **Mark the patterns.** Read the source and tag every hit against [references/patterns.md](references/patterns.md). Fifty-one patterns in five groups: content, language, style, tone, structure.
2. **Rewrite.** Fix the paragraph, not the flagged phrase. Patching one phrase at a time leaves the AI cadence in place. Shorten dull parts, expand useful parts, merge or split paragraphs. Keep every claim.
3. **Run the claim-fidelity pass.** See below. Mandatory.
4. **Score and decide.** Rate the rewrite on the five dimensions. Below 35, revise and repeat.

## Claim fidelity

The rewrite must carry the same claims as the source. Diff the two and check each item:

| Check | What a failure looks like |
|-------|---------------------------|
| Numbers | "roughly 40%" became "40%", or "$12,400" became "over $12,000" |
| Dates and durations | "since 2023" became "for years", "Q3" became "this quarter" |
| Names and entities | A named source became "experts", or a person's title shifted |
| Hedges | "may reduce" became "reduces", "early data suggests" became "data shows" |
| Qualifiers | "in most accounts" or "for enterprise plans" dropped from a claim |
| Causal strength | "correlates with" became "drives", "followed" became "caused" |
| Scope | "two of the five campaigns" became "the campaigns" |
| Attribution | An opinion lost its owner and became a statement of fact |
| Additions | Any fact, number, quote, or citation not present in the source |

Every changed claim gets reverted or flagged. Nothing changed silently. If the source is unclear and the rewrite needs a detail the source does not have, ask for it or write a simpler sentence. Never fill the gap with something plausible.

Two of these deserve extra attention because the humanize rules themselves push toward them. Pattern 19 (too many qualifiers) and pattern 14 (adverbs) both delete words, and some of those words carry meaning. Cutting "may" from "may reduce churn" is a fidelity failure wearing the costume of a style fix. When a hedge is doing real work, keep it and cut somewhere else.

These documents go to paying clients. A cleaner sentence that overstates a result is worse than the original.

## Conflict resolution

Rules do not apply in a vacuum. Resolve conflicts in this order.

**1. Client voice documents win.** A client brand-voice doc defines what correct means for that client's copy. Meshberg's `brand-voice-v2` is the standing example, and every client with a voice doc in `_reference/` gets the same treatment. When a humanize rule contradicts the voice doc, follow the voice doc and do not make the change. Report it instead:

> Voice-doc conflict: pattern 43 (forced groups of three) flags the three-item list in paragraph 2. `brand-voice-v2` calls for triads in section openers. Left as written.

Report, do not argue, and do not apply the rule quietly anyway. If no voice doc exists, the rules apply in full.

**2. A supplied writing sample wins over general style rules.** If the user provides their own prior writing, match its sentence length, punctuation habits, and openings. The sample does not override claim fidelity, and it does not override rule 3 below.

**3. Claim fidelity wins over everything.** No voice doc and no writing sample authorizes changing a fact.

## Em dashes: banned

No em dashes (—) and no en dashes (–) in the final text. Also none of the substitutes: spaced hyphens ( - ), double hyphens ( -- ), spaced dashes ( — ). Replace with a period, comma, colon, or parentheses, or rewrite the sentence.

This is a deliberate resolution of a disagreement between the two source skills. stop-slop bans the em dash outright. humanizer treats it as overuse-only and permits it when a writing sample uses it. The strict ban wins here for one reason: the em dash is the single most reliable surface tell of machine text in 2026, and client-facing copy cannot afford to carry it even when the underlying prose is clean. A comma or a period costs nothing. The rule is absolute, including in the writing-sample case, and including in this file.

Search the output for `—` and `–` before returning it.

## Scoring

Rate 1-10 on each dimension.

| Dimension | Question |
|-----------|----------|
| Directness | Statements or announcements? |
| Rhythm | Varied or metronomic? |
| Trust | Respects reader intelligence? |
| Authenticity | Sounds human? |
| Density | Anything cuttable? |

Below 35/50: revise.

Score after the claim-fidelity pass, not before. A rewrite that scores 45 and moved a number scores zero.

## Quick checks before delivering

- Em dash or en dash anywhere? Remove.
- Any adverb? Cut it or prove it carries meaning.
- Passive voice? Find the actor, put them in front.
- Inanimate thing doing a human verb ("the decision emerges")? Name the person.
- Sentence starts with a Wh- word? Restructure.
- "Here's what/this/that" throat-clearing? Cut to the point.
- "Not X, it's Y" contrast? State Y.
- Three consecutive sentences the same length? Break one.
- Three-item list that wanted to be two? Cut one.
- Paragraph ends on a punchy one-liner? Vary it.
- Vague declarative ("The implications are significant")? Name the implication.
- Meta-joiner ("The rest of this doc covers...")? Delete.
- Bold mini-headings in a list? Rewrite as prose.
- Any number, date, name, or hedge that moved? Revert or flag.

## What not to flag

Humans use some of these patterns. One tell proves nothing; several stacked in a passage is the signal. Do not flag polish, formal vocabulary, a single "however", curly quotes on their own, one short sentence for emphasis, deliberate repetition for rhythm, real scope and safety disclaimers, or genuine alternatives weighed in a design doc. Do not rewrite a watched phrase that appears inside a quotation, a title, a proper name, or an example where the phrase is being discussed rather than used. Full list in [references/patterns.md](references/patterns.md#what-not-to-flag).

Keep the human details: unusual specifics, mixed feelings, self-corrections, era-bound references, uneven sentence length.

## Return format

- **Pasted text (default).** The rewrite, a short list of patterns still present, and the claim-fidelity report.
- **File mode.** Write only the final text to the file. Change prose; leave code blocks, YAML, data, and link targets alone. Summarize the changes and the fidelity report in chat.
- **Embedded mode.** Another task called this skill for a commit message, a PR body, or a document section. Return the final text and the fidelity report. Suppress the pattern list.

The fidelity report is never suppressed. If nothing changed, say "No claims changed."

## Reference

- [references/patterns.md](references/patterns.md): the 51 patterns
- [references/examples.md](references/examples.md): before/after transformations
- [NOTES.md](NOTES.md): scope decisions, including what was left out of v1

## License

MIT. Derived from humanizer (Sasha Blader, MIT) and stop-slop (Hardik Pandya, MIT), both of which draw on Wikipedia's "Signs of AI writing" by WikiProject AI Cleanup.

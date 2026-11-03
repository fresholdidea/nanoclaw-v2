# Before and after

Each example names the patterns it fixes. Numbers refer to [patterns.md](patterns.md).

---

## Carried over from stop-slop

### 1. Throat-clearing and binary contrast

**Before:**
> Here's the thing: building products is hard. Not because the technology is complex. Because people are complex. Let that sink in.

**After:**
> Building products is hard. Technology is manageable. People aren't.

Patterns 36, 42, 38.

### 2. Filler and unnecessary reassurance

**Before:**
> It turns out that most teams struggle with alignment. The uncomfortable truth is that nobody wants to admit they're confused. And that's okay.

**After:**
> Teams struggle with alignment. Nobody admits confusion.

Patterns 36, 37.

**Fidelity note:** this rewrite drops "most". If the source said *most teams* and had evidence for it, keep the quantifier. If "most" was itself an unsupported extreme, cutting it is correct under pattern 20. Decide, do not default.

### 3. Business jargon stack

**Before:**
> In today's fast-paced landscape, we need to lean into discomfort and navigate uncertainty with clarity. This matters because your competition isn't waiting.

**After:**
> Move faster. Your competition is.

Patterns 13, 14, 38.

### 4. Dramatic fragmentation

**Before:**
> Speed. Quality. Cost. You can only pick two. That's it. That's the tradeoff.

**After:**
> You can pick two of speed, quality, and cost.

Patterns 47, 43.

**Changed from the stop-slop original.** stop-slop's published "after" for this example was "Speed, quality, cost—pick two", which contains an em dash and violates its own rule 6. Fixed here under pattern 23.

### 5. Rhetorical setup

**Before:**
> What if I told you that the best teams don't optimize for productivity? Here's what I mean: they optimize for learning. Think about it.

**After:**
> The best teams optimize for learning, not productivity.

Patterns 37, 46.

---

## Patterns stop-slop did not cover

### 6. Inflated significance and shallow -ing analysis

**Before:**
> The account's Q3 restructure marks a pivotal moment in its paid search evolution, underscoring the client's commitment to data-driven decision-making and reflecting a broader shift toward consolidated campaign architecture.

**After:**
> We consolidated the account's paid search campaigns from 14 to 4 in Q3.

Patterns 1, 3, 21, 22.

### 7. Vague sources

**Before:**
> Industry reports suggest that shorter forms convert better, and experts argue that three fields is the sweet spot.

**After:**
> Our own test on the pricing page moved conversion from 3.1% to 4.4% when we cut the form from seven fields to three.

Patterns 4, 43. If no such test exists, cut the claim rather than replacing one vague source with another.

### 8. Bold mini-heading list

**Before:**
> - **Budget:** Budget has been increased to $12,000/month.
> - **Targeting:** Targeting has been narrowed to the top three metros.
> - **Creative:** Creative has been refreshed with new video assets.

**After:**
> Budget goes to $12,000/month. Targeting narrows to Dallas, Houston, and Austin. Two new video assets replace the static creative.

Patterns 25, 16. Note the rewrite names the three metros because the campaign brief listed them. If the brief did not, "the top three metros" stays.

### 9. Chatbot artifacts and agreeable tone

**Before:**
> Great question! Here's an overview of the attribution model change. I hope this helps, and let me know if you'd like me to expand on any section.

**After:**
> The attribution model changes from last-click to data-driven on 1 September.

Patterns 32, 31, 36.

### 10. Knowledge-limit disclaimer with speculative gap-fill

**Before:**
> While specific figures for the client's 2025 spend are not readily available, it appears they invested somewhere in the range of $200,000, which likely explains the slower Q1 ramp.

**After:**
> The client's 2025 spend is not in the files we have. We can pull it from the Ads account history if it matters for the Q1 comparison.

Patterns 7, 4. The invented $200,000 and the invented causal link are both fidelity failures, not style problems.

### 11. Collaborative framing and placeholder text

**Before:**
> In this section, we'll explore how [Client Name] can improve retention. As we can see, there are several levers available. Feel free to reach out with questions!

**After:**
> Cubby Storage has three retention levers: the 60-day price lock, the auto-pay discount, and the win-back email at day 45.

Patterns 33, 34, 36, 31.

### 12. False agency and narrator from a distance

**Before:**
> The data tells us that churn accelerates after month three. Nobody designed this. People tend to disengage once onboarding support ends.

**After:**
> We looked at 400 accounts and found churn roughly doubles in month four. Onboarding support ends at day 90, and nothing replaces it.

Patterns 17, 40, 16. The word *roughly* stays because the underlying figure was an approximation.

### 13. Rejecting a fake alternative

**Before:**
> Reporting runs on the first business day of the month. A tempting approach would be to run it nightly, but that would hammer the API quota. It runs monthly and the numbers are final by 9am.

**After:**
> Reporting runs on the first business day of the month, with final numbers by 9am.

Pattern 51.

### 14. Em dash removal without changing the claim

**Before:**
> The campaign delivered 214 leads in July — well above the 150 target — at a cost per lead of $41.

**After:**
> The campaign delivered 214 leads in July, above the 150 target, at a cost per lead of $41.

Pattern 23. "Well above" became "above", which weakens the claim. Both are defensible against 214 versus 150, so this one gets flagged rather than silently kept:

> Fidelity flag: "well above the target" softened to "above the target". Revert if the emphasis was intentional.

---

## Claim fidelity in action

The most common failure is a rewrite that reads better and says something new. Three shapes to watch.

**Hedge to certainty:**

> Early data suggests the new landing page may reduce bounce.

> The new landing page reduces bounce.

Cleaner, and false. Keep the hedge, cut elsewhere: "Early data suggests the page reduces bounce."

**Correlation to cause:**

> Spend rose in the same month retention improved.

> Higher spend drove the retention improvement.

The source claimed sequence. The rewrite claimed cause.

**Scope loss:**

> Two of the five markets hit the CPA target.

> The markets hit the CPA target.

Compression deleted the number that carried the meaning.

---

## Voice-doc precedence in action

Meshberg's `brand-voice-v2` calls for short declarative fragments in post openers. Pattern 47 flags stacked fragments.

**Draft:**
> Three fields. One question. That's the whole form.

**Wrong response:** rewrite to "The form has three fields and one question."

**Right response:** leave it and report.

> Voice-doc conflict: pattern 47 (forced punchlines and dramatic fragments) flags the opener. `brand-voice-v2` specifies fragment openers for LinkedIn posts. Left as written.

The report goes to the human. The copy ships in the client's voice.

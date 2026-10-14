# Patterns

51 patterns in five groups. Each entry names its source:

- **[H§n]** humanizer, pattern n (github.com/blader/humanizer, derived from Wikipedia's "Signs of AI writing")
- **[SS]** stop-slop (Hardik Pandya)
- **[W]** Wikipedia "Signs of AI writing", a tell humanizer does not cover

One tell, one entry. Where the two source skills covered the same ground, the entries are merged and the extra watch phrases from each are folded in.

Counts: humanizer 35, stop-slop 11, Wikipedia 5.

---

## Content

Patterns about what the text claims and what backs the claim.

### 1. Inflated claims about importance and legacy [H§1]

**Watch:** stands/serves as, is a testament/reminder, a vital/significant/crucial/pivotal/key role/moment, underscores/highlights its importance, reflects broader, symbolizing its ongoing/enduring/lasting, contributing to the, setting the stage for, marking/shaping the, represents/marks a shift, key turning point, evolving landscape, focal point, indelible mark, deeply rooted

An ordinary detail gets dressed as a major change, a proven legacy, or a broad trend.

> The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution of regional statistics in Spain.

> The Statistical Institute of Catalonia was established in 1989, part of a wider decentralization of administrative functions in Spain.

### 2. Name-dropping to prove importance [H§2]

**Watch:** independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence, awards and recognition (as a section)

Publications and follower counts get listed to prove someone matters, with no context for any of them. Keep a citation that explains what was said and where. Do not invent context to justify keeping the rest.

> Her views have been cited in The New York Times, BBC, Financial Times, and The Hindu. She maintains an active social media presence with over 500,000 followers.

> Her views have been cited in The New York Times and the BBC.

### 3. Shallow analysis with -ing phrases [H§3]

**Watch:** highlighting/underscoring/emphasizing..., ensuring..., reflecting/symbolizing..., contributing to..., cultivating/fostering..., encompassing..., showcasing...

A trailing -ing clause makes a plain fact sound deeper than it is.

> The temple's color palette of blue, green, and gold resonates with the region's natural beauty, symbolizing Texas bluebonnets and the Gulf of Mexico, reflecting the community's deep connection to the land.

> The temple is painted blue, green, and gold, colors meant to evoke Texas bluebonnets and the Gulf of Mexico.

### 4. Vague sources [H§5]

**Watch:** industry reports, observers have cited, experts argue, some critics argue, studies show, several sources/publications, it is widely believed

A claim gets assigned to unnamed experts, critics, reports, or observers. Name a real source when the source text gives one. Otherwise cut the claim. Never invent a source.

> Experts believe it plays a crucial role in the regional ecosystem.

> Researchers and conservationists study the Haolai River for its unusual characteristics.

### 5. Vague expression of connection [W]

**Watch:** is associated with, has been linked to, is connected to, has ties to, is closely related to, in the context of, plays a part in

An abstract construction stands in for a stated relationship. Say what the relationship is, or cut it. This is the connective-tissue cousin of pattern 4: pattern 4 hides who says it, this one hides what the link actually is.

> The firm is closely associated with the region's manufacturing sector and has been linked to several infrastructure initiatives.

> The firm supplies steel fasteners to three regional auto plants. (If the source does not say more, stop there.)

### 6. Formulaic challenges and outlook sections [H§6]

**Watch:** Despite its... faces several challenges, Despite these challenges, Challenges and Legacy, Future Outlook, Looking Ahead

A stock section about challenges, prospects, or continued growth repeats vague claims instead of adding facts. Add dates or actions only when the source has them.

> Despite its industrial prosperity, Korattur faces challenges typical of urban areas, including traffic congestion and water scarcity. Despite these challenges, Korattur continues to thrive.

> Korattur has recurring traffic congestion and water shortages.

### 7. Knowledge-limit disclaimers and speculative gap-fill [H§21]

**Watch:** as of [date], up to my last training update, while specific details are limited/scarce, based on available information, not publicly available, maintains a low profile, prefers to stay out of the spotlight, likely [grew up/studied/began], it is believed that

The model states that it could not find something, then fills the gap with something plausible. State what the source does not show, or cut the sentence. Never present a guess as a fact.

> Information about her early life is not publicly available, suggesting she maintains a low profile. She likely grew up in a middle-class household, which shaped her later interest in education reform.

> Her early life is not documented in the available sources. (Or omit.)

### 8. Unverifiable or fabricated citations and links [W]

**Watch:** URLs that were never opened, DOIs and ISBNs that do not resolve, book citations with no page number, `utm_source=` tracking parameters left in a link, references listed but never cited in the body, a linked source whose content does not match the claim

Machine-written text produces citations shaped correctly and pointing nowhere. For client documents this is the most expensive failure in the list, because a bad citation survives review and reaches the reader. Verify every link and identifier or remove it. Strip tracking parameters.

### 9. Vague declaratives with no referent [SS]

**Watch:** the reasons are structural, the implications are significant, this is the deepest problem, the stakes are high, the consequences are real

A sentence announces that something is important, deep, or structural without naming the thing. Cut it, or replace it with the specific thing.

> The implications for the account are significant.

> Two of the five campaigns lose their audience targeting in November.

### 10. Telling instead of showing [SS]

**Watch:** this is genuinely hard, this is what leadership actually looks like, this is what X actually looks like, that actually matters

Difficulty or significance gets announced rather than demonstrated. Show the thing and let the reader judge.

### 11. Writing about the previous version [H§30]

Documentation and comments describe current behavior. Previous versions belong in change logs, release notes, and migration guides.

> This function was added to replace the previous approach of iterating through all items, which caused O(n²) performance.

> This function uses a hash map for O(1) lookups.

---

## Language

Patterns at the word and phrase level.

### 12. Overused AI words [H§7]

**Watch:** actually, additionally, align with, crucial, delve, emphasizing, enduring, enhance, fostering, garner, gate/gated/gating (figurative only; keep established technical usage), highlight (verb), interplay, intricate/intricacies, key (adjective), landscape (abstract), pivotal, quietly, showcase, tapestry (abstract), testament, underscore (verb), valuable, vibrant

These appear far more in machine text than in human writing, and they cluster. One is nothing. Four in a paragraph is the tell.

> Additionally, an enduring testament to Italian colonial influence is the widespread adoption of pasta in the local culinary landscape, showcasing how these dishes have integrated into the diet.

> Pasta dishes, introduced during Italian colonization, remain common, especially in the south.

### 13. Business jargon [SS]

| Avoid | Use |
|-------|-----|
| navigate (challenges) | handle, address |
| unpack (analysis) | explain, examine |
| lean into | accept, commit to |
| landscape (context) | situation, field |
| game-changer | significant, important |
| double down | commit, increase |
| deep dive | analysis, review |
| take a step back | reconsider |
| moving forward | next, from now |
| circle back | return to, revisit |
| on the same page | agreed, aligned |

Overlaps pattern 12 on *landscape*. Listed here for the substitution table.

### 14. Adverbs and empty intensifiers [SS]

**Watch:** really, just, literally, genuinely, honestly, simply, actually, deeply, truly, fundamentally, inherently, inevitably, interestingly, importantly, crucially, and most other -ly words

Also cut: at its core, in today's [X], it's worth noting, at the end of the day, when it comes to, in a world where, the reality is.

Default to deleting the adverb. Two carve-outs, both narrow:

- The adverb carries information rather than emphasis. *Quarterly*, *manually*, *remotely*, *retroactively* survive.
- The adverb is a hedge that a claim depends on. See the claim-fidelity note in SKILL.md. Deleting *may* or *approximately* is a fidelity failure, not a style fix.

**Source conflict:** stop-slop bans all adverbs. humanizer warns against simplifying every formal word (see [what not to flag](#what-not-to-flag)). Resolved toward stop-slop with the two carve-outs above.

### 15. Avoiding is and are [H§8]

**Watch:** serves as / stands as / marks / represents [a], boasts / features / offers [a]

Simple verbs get swapped for longer ones.

> Gallery 825 serves as LAAA's exhibition space. The gallery features four separate spaces and boasts over 3,000 square feet.

> Gallery 825 is LAAA's exhibition space. It has four rooms totaling 3,000 square feet.

### 16. Passive voice and missing subjects [H§13]

**Watch:** was created, it is believed that, mistakes were made, the decision was reached, results are preserved

The actor gets hidden or dropped. Find who acts and put them in front.

> No configuration file needed. The results are preserved automatically.

> You do not need a configuration file. The system preserves the results.

### 17. False agency [SS]

An inanimate noun takes a human verb. This reads as active voice while doing the same work as passive voice: it avoids naming who acted.

| Pattern | What actually happened |
|---------|------------------------|
| a complaint becomes a fix | someone fixed it |
| a bet lives or dies in days | someone killed the project or shipped it |
| the decision emerges | someone decided |
| the culture shifts | people changed their behavior |
| the conversation moves toward | someone steered it |
| the data tells us | someone read it and drew a conclusion |
| the market rewards | buyers paid for something |

Name the human. If no specific person fits, use "you" and put the reader in the seat.

### 18. Filler phrases [H§23]

| Before | After |
|--------|-------|
| in order to achieve this goal | to achieve this |
| due to the fact that | because |
| at this point in time | now |
| in the event that you need help | if you need help |
| has the ability to process | can process |
| it is important to note that the data shows | the data shows |

### 19. Too many qualifiers [H§24]

**Watch:** to be fair, it's also possible, could potentially, might arguably, in some cases it may, this is an inference

Successive edits stack hedges until every claim sounds uncertain. Remove caveats that exist only to repair an earlier overstatement. Keep a qualifier the source supports and the meaning needs.

> It could potentially possibly be argued that the policy might have some effect on outcomes.

> The policy may affect outcomes.

Note the surviving *may*. Cutting it would change the claim.

### 20. Lazy extremes [SS]

**Watch:** every, always, never, everyone, everybody, nobody, all, none

Sweeping words borrow authority the text has not earned, and they are usually false. Replace with the specific count or scope. This is also a fidelity trap in reverse: an extreme introduced during a rewrite is a new claim.

> Every client asks about attribution.

> Four of our seven retainer clients asked about attribution this quarter.

### 21. Too many hyphenated word pairs [H§26]

**Watch:** third-party, cross-functional, client-facing, data-driven, decision-making, well-known, high-quality, real-time, long-term, end-to-end

Keep the hyphen before a noun. Drop it after.

> The team is cross-functional, the report is high-quality, and the methodology is data-driven.

> The team is cross functional, the report is high quality, and the methodology is data driven.

### 22. Sales language [H§4]

**Watch:** boasts a, vibrant, rich (figurative), profound, enhancing its, showcasing, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning

Descriptions of places, products, teams, and organizations drift into advertising copy.

> Nestled within the breathtaking region of Gonder in Ethiopia, Alamata Raya Kobo stands as a vibrant town with a rich cultural heritage.

> Alamata Raya Kobo is a town in the Gonder region of Ethiopia.

---

## Style

Patterns in punctuation, typography, and formatting.

### 23. Em and en dashes: banned [H§14 + SS]

No em dashes (—), no en dashes (–), no spaced hyphens used as dashes, no double hyphens. Replace with a period, comma, colon, or parentheses, or rewrite. Search the output for `—` and `–` before returning it.

**Source conflict, resolved.** stop-slop bans the em dash. humanizer flags overuse and permits the dash when a supplied writing sample uses it. This skill takes the strict ban, including in the writing-sample case. Rationale: the em dash is the most recognizable surface tell of machine text, client-facing copy cannot carry it, and the replacement costs nothing. Recorded as a decision, not an accident of merging.

> The term is promoted by Dutch institutions—not by the people themselves—even in official documents.

> The term is promoted by Dutch institutions, not by the people themselves, including in official documents.

### 24. Too much bold text [H§15]

Words and phrases get bolded with no reason.

> It blends **OKRs (Objectives and Key Results)**, **KPIs (Key Performance Indicators)**, and visual tools such as the **Business Model Canvas (BMC)**.

> It blends OKRs, KPIs, and visual strategy tools like the Business Model Canvas.

### 25. Lists with bold mini-headings [H§16]

Every list item opens with a bold label and a colon. Usually the list wanted to be a sentence.

> - **User Experience:** The user experience has been significantly improved with a new interface.
> - **Performance:** Performance has been enhanced through optimized algorithms.

> The update improves the interface and speeds up load times.

### 26. Title case in headings [H§17]

> ## Strategic Negotiations And Global Partnerships

> ## Strategic negotiations and global partnerships

### 27. Heading hierarchy and decorative formatting [W]

Structural artifacts that no human editor produces:

- Skipped heading levels (H2 to H4)
- Stacked level-1 headings inside a document that already has a title
- Headings containing nothing but other headings
- Horizontal rules dropped between every section as decoration
- Tables used where two sentences would do, or a table with one column of prose

Fix the hierarchy. Delete decorative rules. Convert a decorative table to prose.

### 28. Emojis as formatting [H§18]

> 🚀 **Launch Phase:** The product launches in Q3
> 💡 **Key Insight:** Users prefer simplicity

> The product launches in Q3. User research showed a preference for simplicity.

### 29. Curly quotation marks [H§19]

Straight quotes unless the target format calls for curly. Weak on its own, since Word, Docs, and macOS auto-curl. Counts when stacked with other tells.

### 30. A heading repeated in the first sentence [H§29]

A heading is followed by a one-line paragraph restating the heading. Delete the restatement.

> ## Performance
>
> Speed matters.
>
> When users hit a slow page, they leave.

> ## Performance
>
> When users hit a slow page, they leave.

---

## Tone

Patterns in the stance the text takes toward its reader.

### 31. Chatbot text left in the answer [H§20]

**Watch:** I hope this helps, Of course!, Certainly!, You're absolutely right!, Would you like..., Want me to...?, Should I continue?, let me know, here is a...

A greeting, offer, or sign-off survives into text meant to stand alone.

### 32. Overly agreeable tone [H§22]

> Great question! You're absolutely right that this is a complex topic.

> The economic factors you mentioned are relevant here.

### 33. Collaborative "we" framing [W]

**Watch:** let's explore together, we can see that, as we discussed, feel free to, don't hesitate to, in this article we will, our journey

The text addresses the reader as a co-worker on a shared task rather than telling them something. Reference and client documents do not have a "we" doing anything. Cut the framing and state the content. Keep a genuine first-person plural when a real organization is the subject ("we ran the test in March").

### 34. Placeholder text and phrasal templates [W]

**Watch:** [insert X here], [Company Name], [Date], Lorem ipsum, "as an AI language model", a sentence whose structure only makes sense with a variable filled in

Template scaffolding survives into the final document. Search for `[` and `TODO` before delivering client-facing text.

### 35. Fake-candid openings [H§33]

**Watch:** Honestly?, Look, Here's the thing, The thing is, Let's be honest, Real talk, I'm going to be honest, Can we talk about, used as standalone hooks

A staged pause or a claim of honesty precedes a routine point. State the point.

> Is it worth the price? Honestly? It depends on how often you'll use it.

> Whether it's worth the price depends on how often you'll use it.

*Folds in stop-slop's throat-clearing openers list.* "Honestly" or "look" mid-sentence is ordinary. The tell is the theatrical standalone.

### 36. Announcing the next point [H§28 + SS]

**Watch:** let's dive in, let's explore, let's break this down, here's what you need to know, now let's look at, without further ado, heads up, quick note, before I forget, one thing that bit me, here's what/this/that/why [X], the real [X] is, it turns out, the uncomfortable truth is, let me be clear, I'll say it again

Also the document talking about itself: the rest of this essay explains, let me walk you through, in this section we'll, as we'll see, I want to explore, Hint:, Plot twist:, Spoiler:, But that's another post.

The next point gets announced instead of stated. Removing the formality is not enough. Remove the announcement.

> Let's dive into how caching works in Next.js. Here's what you need to know.

> Next.js caches data at multiple layers, including request memoization, the data cache, and the router cache.

*Folds in stop-slop's throat-clearing and meta-commentary lists.*

### 37. Rhetorical setups and granted permission [SS]

| Pattern | Problem |
|---------|---------|
| What if [reframe]? | Socratic posturing |
| Here's what I mean: | redundant preview |
| Think about it: | condescending prompt |
| And that's okay. | permission the reader did not ask for |
| You already know this, but | false modesty |

Make the point. Let the reader draw the conclusion.

### 38. Emphasis crutches and manufactured sincerity [SS]

**Watch:** Full stop. / Period., Let that sink in., This matters because, Make no mistake, Here's why that matters, I promise, They exist, I promise, creeps in

The sentence adds volume, not meaning. Delete it. If the point matters, the content shows it.

### 39. Pretending to reveal a deeper truth [H§27]

**Watch:** the real question is, at its core, in reality, what really matters, fundamentally, the deeper issue, the heart of the matter

An ordinary point gets staged as a hidden truth.

> The real question is whether teams can adapt. At its core, what really matters is organizational readiness.

> The question is whether teams can adapt. That depends on whether the organization will change its habits.

### 40. Narrator from a distance [SS]

**Watch:** nobody designed this, this happens because, this is why, people tend to, one might find that

The voice floats above the scene and lectures. Put the reader in the room. "You" beats "people". Specifics beat abstractions.

> Nobody designed this. People tend to accumulate process over time.

> You don't sit down one morning and decide to add four approval steps. You add one, and then a bad quarter adds three more.

### 41. Generic positive endings [H§25]

The text closes on vague optimism rather than the last useful fact.

> The future looks bright for the company. Exciting times lie ahead as they continue their journey toward excellence.

> (Cut it. End on the last concrete fact. If the source states real plans, use those.)

---

## Structure

Patterns in sentence and paragraph architecture.

### 42. Negative parallelism [H§9 + SS]

Three related shapes, one entry.

**Not X but Y:**

| Pattern |
|---------|
| not only X but also Y |
| it's not just X, it's Y |
| X isn't the problem, Y is |
| the answer isn't X, it's Y |
| the question isn't X, it's Y |
| it feels like X, it's actually Y |
| stops being X and starts being Y |
| doesn't mean X, but actually Y |
| X rather than Y (as a reversal) |
| X that isn't Y |

**Negative listing** stacks the negations before the reveal: "Not a X. Not a Y. A Z." The reader does not need the runway. State Z.

**Clipped tailing negation** ends a sentence with a fragment instead of a clause: "The options come from the selected item, no guessing."

State the positive claim directly. Drop the negation.

> It's not just about the beat riding under the vocals; it's part of the aggression and atmosphere.

> The heavy beat adds to the aggressive tone.

> The options come from the selected item, no guessing.

> The options come from the selected item, so the user does not have to guess.

*Folds in stop-slop's binary-contrast and negative-listing tables.*

### 43. Forced groups of three [H§10]

Ideas get packed into triads to sound complete. Two items usually carry the same meaning and read as a person wrote them.

> The event features keynote sessions, panel discussions, and networking opportunities. Attendees can expect innovation, inspiration, and industry insights.

> The event includes talks and panels, with time for informal networking between sessions.

### 44. False from X to Y ranges [H§12]

"From X to Y" where X and Y do not bound a range.

> Our journey has taken us from the singularity of the Big Bang to the grand cosmic web, from the birth of stars to the enigmatic dance of dark matter.

> The book covers the Big Bang, star formation, and current theories about dark matter.

### 45. Synonym cycling and repeated sentence openings [H§11]

Repetition gets handled by rule instead of by ear. The same subject gets renamed every sentence, or several sentences open the same way.

Use one name for one thing. For repeated openings, merge the sentences, change the subject, or open with the action. Do not ban the repeated word; fix the repeated pattern.

> The protagonist faces many challenges. The main character must overcome obstacles. The central figure eventually triumphs.

> The protagonist faces many challenges but eventually triumphs.

### 46. Wh- and "So" openers [SS]

Sentences opening with What, When, Where, Which, Who, Why, or How become a crutch. So do paragraphs opening with "So".

> What makes this hard is the approval chain.

> The approval chain has four steps and two of them sit with the same person.

### 47. Forced punchlines and dramatic fragments [H§31]

Each sentence gets turned into a closing line. One short sentence adds emphasis. A row of them reads as manufactured.

> Then AlphaEvolve arrived. It had no preference for symmetry. No aesthetic prior. No nostalgia for human taste.

> AlphaEvolve changed the search because it did not favor symmetry or human-looking designs.

Includes the "X. That's it. That's the Y." shape from stop-slop.

### 48. Metronomic rhythm [SS]

Beyond the fragment problem, machine prose settles into an even mid-length cadence.

| Pattern | Fix |
|---------|-----|
| Three or more consecutive sentences of similar length | Break one, or merge two |
| Every paragraph ends on a punchy one-liner | Vary the endings |
| A question asked and answered in the next clause | Let it breathe or cut it |
| Uniform paragraph length down the page | Merge and split by argument, not by eye |

Read it aloud. If the pulse never changes, the rhythm is the tell even when every sentence is clean.

### 49. Formulaic sayings and pull-quotes [H§32 + SS]

**Watch:** X is the Y of Z, X becomes a trap, X is not a tool but a mirror, the language of, the currency of, the architecture of, by the time X, I was Y

An ordinary claim gets shaped into an aphorism that sounds deep and adds nothing. The stop-slop version of this test: if a sentence reads like a pull-quote, rewrite it.

> Symmetry is the language of trust. Efficiency becomes a trap when teams forget the human layer.

> Symmetric layouts feel more predictable to users. Teams can over-optimize a workflow and miss how people use it.

### 50. Answering objections no one raised [H§34]

**Watch:** this isn't (mainly/really) about, I'm not saying/arguing/trying to, to be clear, don't get me wrong, this is not to say, you could argue this differently but, some might say... but

An objection that appears nowhere else in the text gets answered. Remove the unsupported defense. If it contains a real claim, state that claim. Keep an objection that names its source or gets a full answer. A direct statement like "the API is not thread-safe" is not this pattern.

> This isn't mainly about prompt length, and I'm not arguing that documentation doesn't matter. You could frame it another way, but the issue is whether the agent can use the instruction when it acts.

> The issue is whether the agent can use the instruction when it acts.

### 51. Rejecting fake alternatives [H§35]

**Watch:** a tempting option would be, one might be tempted to, an obvious approach would be, you might think... but, it would be easy to just, some would suggest

An option no reader would consider gets raised, dismissed in a clause, and never mentioned again. Usually a drafting note left in the final text.

> Session tokens rotate every 24 hours. A tempting approach would be to rotate them by restarting the auth service on a cron job, but that would drop every active session. Rotation happens in place.

> Session tokens rotate every 24 hours, in place, and clients refresh transparently.

One rejected option can be legitimate. Several short unrelated rejections is the stronger signal. Ask what each sentence adds.

---

## What not to flag

A person may write any of these. None is proof on its own.

- **Polish.** Clean grammar and consistent style mean an editor, not a model.
- **Mixed casual and formal register.** Reflects field, age, or habit.
- **Bland prose.** Machine text has specific tells. Dryness without them is dry writing.
- **Formal vocabulary.** Pattern 12 names specific overused words. Do not flatten every formal word.
- **Salutations and sign-offs on a message.** These predate chatbots by centuries.
- **A single transition word.** *Additionally*, *moreover*, *consequently* count when piled up. One *however* is nothing.
- **Curly quotes alone.** Auto-curl is a default in most tools.
- **One short sentence for emphasis.** Flag fragments only in a row.
- **Deliberate repeated openings.** "She came. She saw. She conquered." Change it only when the repetition adds nothing.
- **"Honestly" or "look" mid-sentence.** Ordinary in casual writing.
- **Real disclaimers.** Keep scope statements, legal and safety notices, corrections, named objections, and FAQ answers.
- **Real alternatives.** Keep options a reader would weigh in a design doc or tutorial.
- **Unsourced claims.** Most writing is unsourced.
- **Correct complex formatting.** Templates and visual editors produce clean output.
- **Secondhand text.** Never rewrite a watched phrase inside a quotation, a title, a proper name, or an example where the phrase is under discussion.
- **Text written before 30 November 2022.** ChatGPT's public launch.

When unsure, look for several patterns together in the same passage.

## Human details to keep

- Unusual specifics: a real address, an odd quote, "the lawyer who used to work upstairs from my dentist"
- Mixed feelings and unresolved tension
- Dated, era-bound references, slang, and in-jokes
- Deliberate choices the writer can explain
- Uneven sentence length
- Genuine asides and self-corrections

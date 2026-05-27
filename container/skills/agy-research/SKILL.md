---
name: agy-research
description: Conduct long-form research by delegating to agy via mcp__nanoclaw__query_agy, then save the result as a structured markdown file with frontmatter. Triggers on "/agy-research <topic>", "research <topic> with agy", "run a deep agy report on <topic>", or "do an agy research pass on <topic>".
---

# agy-research

A recipe for getting a long-form research answer out of agy and landing it as a durable, frontmattered markdown file. Single-shot per call — there's no follow-up turn with agy, so the framing prompt has to do the work upfront.

## Step 1 — Frame the topic

Restate the user's topic in one sentence and propose an angle. Build a `/goal`-style prompt with these exact sections in this order:

```
Goal: <one sentence>
Scope: <what to cover; what to leave out>
Required structure:
  - <heading 1 with one-line description>
  - <heading 2 with one-line description>
  - ...
Anti-goals: <what NOT to include — vague intros, marketing fluff, off-topic tangents>
```

Show the framed prompt to the user and **wait for an explicit "go" / "yes" / "approve"**. Agy calls take minutes and burn Google AI Pro budget — never call without approval.

If the user wants changes, iterate on the framed prompt and re-confirm. Don't skip this gate even if the topic seems simple.

## Step 2 — Pick output destination

Compute:
- `slug` = kebab-case of the topic, max 60 chars, lowercase, alphanumeric + hyphens only
- `date` = today as `YYYY-MM-DD`

Default path: `/workspace/agent/research/<date>-<slug>.md`. Always writable.

If `/workspace/extra/obsidian/` exists and is writable, prefer the Obsidian path:
`/workspace/extra/obsidian/50-Sources/<date>-<slug>.md`

Check with:
```bash
test -d /workspace/extra/obsidian && test -w /workspace/extra/obsidian && echo "use-obsidian"
```

Ensure the parent dir exists:
```bash
mkdir -p "$(dirname <chosen-path>)"
```

## Step 3 — Call query_agy

Call the MCP tool with the framed prompt as a single string:

```
mcp__nanoclaw__query_agy({
  prompt: "<the full framed prompt from Step 1, verbatim>"
})
```

Default timeout is 15 minutes — fine for research. Only override with `timeoutMs` if the user explicitly asks for a short cap.

If the tool returns `Error: agy binary not found …`, stop. Tell the user this group isn't enabled for agy sub-querying — they need to set `enableAgyTooling: true` in this group's `container.json` and restart the container. Don't retry.

If the tool returns an `isError` for any other reason (timeout, non-zero exit, empty stdout), report the error to the user verbatim and ask whether to retry with a different framing.

## Step 4 — Clean and save

The result text contains agy's tool-call narration ("I'll search for…", "Let me explore…") mixed with the actual answer. Find the body:

- Skip obvious leading preamble lines that aren't part of the answer ("I'll research…", "Let me think about…", numbered checklists from agy's planner).
- The substantive content is usually the longest contiguous block of markdown near the end.
- Don't strip aggressively — keeping some narration is safer than losing part of the answer. The frontmatter `source: query_agy` flags the noise for future readers.

Write to the chosen output path with this exact YAML frontmatter shape:

```yaml
---
type: agy-research
topic: <one-line topic>
generated: <YYYY-MM-DD>
source: query_agy
prompt: |
  <the framed prompt from Step 1, verbatim, indented with 2 spaces per line>
---
```

Followed by the cleaned response body.

## Step 5 — Report back

Single concise message to the user:
- File path
- One-sentence summary of what's in it
- If Obsidian-mounted: a wikilink-ready reference, e.g. `[[<date>-<slug>]]`

Example:
```
Saved research to /workspace/extra/obsidian/50-Sources/2026-05-26-nextjs-app-router-conventions.md (8 sections, ~1800 words on routing, layouts, parallel routes, intercepting routes, and middleware). Reference: [[2026-05-26-nextjs-app-router-conventions]]
```

## What you don't do

- **Don't skip the approval gate in Step 1.** Agy calls cost minutes + budget. Always show the framed prompt and wait for go.
- **Don't try to make it multi-turn with agy.** There's no follow-up. If the first result is wrong, iterate on the framing prompt and re-run.
- **Don't write to `50-Wiki/`.** Agy-research outputs are sources, not synthesized wiki pages. The `wiki` skill is what promotes a source into a wiki page.
- **Don't strip narration so aggressively you lose part of the answer.** Better to keep extra than to truncate the substantive content.
- **Don't echo the raw agy output back in chat.** Save it to the file; respond with a clean summary.

## Related

- **`mcp__nanoclaw__query_agy`** — the underlying tool. See `query-agy.instructions.md` for the calling contract.
- **`wiki` skill** — if the research output should be promoted into the wiki, drop the file into `50-Sources/` (already happens if Obsidian is mounted) and then run `/wiki ingest 50-Sources/<filename>`.

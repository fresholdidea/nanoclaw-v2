# Sub-querying agy (`query_agy`)

`mcp__nanoclaw__query_agy` spawns an ephemeral `agy -p` subprocess and returns the trimmed stdout. Single-shot per call — no conversation re-use, no shared state with you.

## When to use

- **Bulk drafting** — "draft 20 ad headline variations", "write a 2000-word first pass on X". Cost-efficient on Google AI Pro instead of Anthropic credits.
- **Broad exploratory research** — open-ended generation where you'll filter the output downstream anyway.
- **Second opinions** — get an alternative phrasing or angle on something you've already drafted.

## When NOT to use

- **Short factual lookups** — answering them inline is faster than spinning up a sub-query.
- **Anything that needs this conversation's context** — the sub-query starts with zero shared history. Either inline the relevant context in the prompt or do the work yourself.
- **Anything where output cleanliness matters end-to-end** — see "Output handling" below.

## Output handling

The result text contains agy's tool-call narration ("I'll search for…", "Let me read…") followed by the actual answer. **Skim past the leading chatter; the final answer is usually the longest contiguous block near the end.** Don't echo the full raw output back to the user — extract the answer and present it cleanly.

## Calling shape

```
mcp__nanoclaw__query_agy({
  prompt: "<self-contained prompt with all necessary context — agy has nothing else>",
  timeoutMs: 900000  // optional, default 15min, ceiling 30min
})
```

## Enablement errors

If the tool returns `Error: agy binary not found at …`, this group is not enabled for agy sub-querying. Tell the user; do not retry. Enablement requires either `provider: "agy"` or `enableAgyTooling: true` in the group's `container.json`.

## Cost / time

Each call takes 30s–several minutes wall-clock and burns Google AI Pro quota. Use deliberately; don't loop.

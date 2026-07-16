# Sub-querying opencode (`query_opencode`)

`mcp__nanoclaw__query_opencode` spawns an ephemeral `opencode run` subprocess and returns the trimmed stdout. Single-shot per call — no conversation re-use, no shared state with you. Routes through OpenRouter (DeepSeek, Qwen, GLM, etc.) via the OneCLI proxy, so it bills against OpenRouter credits rather than Anthropic.

## When to use

- **Bulk drafting** — "draft 20 ad headline variations", "write a 2000-word first pass on X". Cost-efficient on OpenRouter compared to Claude.
- **Cheap second opinions** — get an alternative phrasing or angle from a different model before committing.
- **Style A/B** — generate two versions of the same content (yours + a DeepSeek pass) and pick or merge.
- **Throw-away exploratory generation** — drafts you'll heavily edit anyway.

## When NOT to use

- **Anything that needs this conversation's context** — the sub-query starts with zero shared history and zero MCP tools. Inline all necessary context in the prompt or do the work yourself.
- **Client-facing copy without your own editing pass** — OpenRouter models drift from voice guidelines more than Claude does. Always edit before approval.
- **Tool-using work** — `query_opencode` runs with no MCP tools wired. If the task needs to read files, fetch URLs, or call an API, do it yourself and feed the result in.
- **Short factual lookups** — answering them inline is faster than spinning up a sub-query.

## Calling shape

```
mcp__nanoclaw__query_opencode({
  prompt: "<self-contained prompt — opencode has nothing else>",
  model: "openrouter/deepseek/deepseek-chat",   // optional; falls back to OPENCODE_MODEL
  timeoutMs: 300000                             // optional, default 5min, ceiling 30min
})
```

**Minimum useful prompt size.** Don't sub-query for tasks where the prompt would be under ~200 tokens. You pay twice — once on your provider to construct the prompt, once on OpenRouter to process it. Below that threshold, doing the work inline is cheaper end-to-end.

## Output handling

Raw `opencode run` stdout may include light formatting/decorations. Trim and present the answer cleanly — don't echo decorations back to the user.

## Enablement errors

If the tool returns `Error: opencode env vars not set...`, this group is not enabled for opencode sub-querying. Tell the user; do not retry. Enablement requires either `provider: "opencode"` or `enableOpencodeTooling: true` in the group's `container.json`.

## Cost / time

Each call typically takes 5–60 seconds and burns OpenRouter credits at the rate of the selected model. Much cheaper than a Claude turn, especially on DeepSeek/Qwen. Use deliberately — don't loop.

## Complement to `query_agy`

Both are sub-call tools that delegate generation off your main provider. Pick by where the budget pressure is:

| Tool | Bills | Best at |
|------|-------|---------|
| `query_agy` | Google AI Pro (flat) | Long-form research, structured docs, anything where Google's tool surface helps |
| `query_opencode` | OpenRouter (per-token) | Bulk text, cheap drafts, alternative-model second opinions |

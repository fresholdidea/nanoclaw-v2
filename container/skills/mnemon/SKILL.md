---
name: mnemon
description: Shared long-term memory used by all of Brad's agents (NanoClaw groups, Claude Code, Codex, Gemini). Use it to recall past decisions, preferences, and findings before answering, and to store durable ones afterward. Also covers the ID rules that decide whether `link` and `forget` actually succeed from inside a container. Triggers on "remember this", "what did we decide", past sessions, prior work on a client, or any `mnemon` command.
allowed-tools: Bash
---

# mnemon (container edition)

## How it works in this container

`mnemon` here is a shim over the shared store mounted at `/workspace/extra/mnemon`.

- **Reads** (`recall`, `search`, `related`, `status`, `log`) come from a snapshot the host refreshes after each batch of writes, and at least every 5 minutes. Something written in the last minute or two may not show up yet.
- **Writes** (`remember`, `link`, `forget`) are queued as files in `/workspace/extra/mnemon/queue/`. The host runs them about once a minute.
- The shim prints `queued for host import: ...`. That is NOT confirmation. It returns no ID and no candidates, and a write can still fail later on the host.

Your group's instructions win over this skill. If they say the group does not use Mnemon, do not write to it.

## Recall

```bash
mnemon recall "<focused keywords>" --limit 5
mnemon search "<exact phrase or name>" --limit 5
mnemon related <full-uuid> --edge causal
```

Build a short keyword query. Do not paste the raw user message.

## Remember

```bash
mnemon remember "<self-contained fact>" --cat <category> --imp <1-5> --entities "Entity A,Entity B" --source agent
```

- Categories: `preference` · `decision` · `fact` · `insight` · `context` · `general`
- Store durable things: decisions, preferences, root causes, conventions, and pointers to where the full work lives. Skip routine chatter and transient status. Do not copy whole documents or Wiki pages.
- Write each memory so it makes sense with no conversation around it. Include absolute dates.
- Never store secrets, passwords, tokens, or API keys. Max 8,000 characters.

## ID rules (most failed writes break one of these)

1. **Full 36-character UUIDs only.** `link`, `forget`, and `related` reject short prefixes like `3671aee0`. From a container, that failure is silent.
2. **Copy IDs from output, never from memory.** Take the `"id"` value from `mnemon recall` or `mnemon search` output in this turn. Do not retype, abbreviate, or reuse IDs from earlier sessions.
3. **A memory you just queued has no ID yet.** Do not try to link it in the same step. If a link really matters, wait about two minutes, then `mnemon search` for it and use the full `id` it returns. Otherwise skip the link, because entity and time edges are created automatically.
4. **IDs can go dead.** Near-duplicates are skipped, and a conflicting new fact replaces the older memory. Before linking or forgetting, re-run `search` and use whatever ID it returns now.
5. **`forget` takes only an ID.** `mnemon forget <full-uuid>`. There is no `--reason` flag, and passing one makes the write fail.

Link syntax, for genuinely related memories only:

```bash
mnemon link <full-uuid> <full-uuid> --type <semantic|causal> --weight <0-1> --meta '{"reason":"why they are related"}'
```

## Checking that a write landed

- After about two minutes, `mnemon search "<distinctive words>" --limit 3` should return the new memory.
- Failed writes are parked as `/workspace/extra/mnemon/queue/*.json.err`. These files contain only the command, not the error. `ls /workspace/extra/mnemon/queue/*.err` shows them, and the usual causes are the ID rules above.
- If you told the user something was stored, make sure it actually was.

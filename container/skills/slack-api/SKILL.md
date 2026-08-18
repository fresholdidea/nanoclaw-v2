---
name: slack-api
description: Read or post to Brad's Slack workspaces (Meadow, Cache, Miller7) via the Slack Web API. Use when the user asks to check Slack messages, list channels, search Slack, or post to a Slack channel. Outbound API only — does not receive inbound Slack events.
---

# /slack-api — Slack Web API via OneCLI

Outbound-only access to three workspaces. The OneCLI vault holds a separate user token per workspace, each scoped to that workspace's subdomain. **Hit the workspace subdomain** so OneCLI's `hostPattern` injection picks the right token automatically — never `slack.com`.

| Workspace | Base URL |
|---|---|
| Meadow | `https://meadowglobal.slack.com/api` |
| Cache | `https://usecache.slack.com/api` |
| Miller7 | `https://millermedia7.slack.com/api` |

No `Authorization` header needed in your `curl` — the proxy injects `Authorization: Bearer <token>` based on the host.

## Common calls

```bash
# List public channels in Meadow
curl -s "https://meadowglobal.slack.com/api/conversations.list?limit=50&types=public_channel"

# Resolve a channel name → id (then use the id for history)
curl -s "https://usecache.slack.com/api/conversations.list?limit=1000&types=public_channel,private_channel" \
  | jq '.channels[] | select(.name=="marketing") | .id'

# Recent messages in a channel
curl -s "https://usecache.slack.com/api/conversations.history?channel=C0123456&limit=50"

# Replies in a thread
curl -s "https://usecache.slack.com/api/conversations.replies?channel=C0123456&ts=1714500000.123456"

# Search messages (user-token only)
curl -s -G "https://usecache.slack.com/api/search.messages" \
  --data-urlencode 'query=from:@angus in:#marketing after:2026-04-01'

# Post a message
curl -s -X POST "https://millermedia7.slack.com/api/chat.postMessage" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"#general","text":"Hello from Zed"}'

# Resolve user id → display name
curl -s "https://usecache.slack.com/api/users.info?user=U0123456"
```

## Response handling

Slack always returns `{"ok": true|false, ...}`. On `ok:false`, surface the `error` field to Brad — common ones:

- `invalid_auth` — wrong workspace subdomain (token mismatched). Check the URL host.
- `not_in_channel` — token's user isn't a member of that private channel.
- `channel_not_found` — bad id, or channel is private and user isn't in it.
- `ratelimited` — back off; respect `Retry-After` header.

## Message formatting

These rules apply to **this** skill only — direct `chat.postMessage` calls that pass
a `text` field, which Slack renders as mrkdwn:

- `*bold*` (single asterisks)
- `_italic_` (underscores)
- `<https://url|link text>` — not `[text](url)`
- `:emoji:` shortcodes
- `>` for block quotes
- No `##` headings

Do **not** apply these to ordinary replies in a Slack conversation NanoClaw is wired
to. Those go out through the bridge as `markdown_text`, which renders *standard*
markdown — the opposite dialect. See `/slack-formatting`, which covers that path.
(If you pass `markdown_text` instead of `text` on a direct API call, follow
`/slack-formatting` for that call too.)

## What this is not

- **Not a channel adapter.** Slack messages do not arrive in your inbox. You only see Slack content when Brad asks you to fetch it.
- **Not an MCP.** Don't try to add `@modelcontextprotocol/server-slack` — it hits `slack.com` directly, which defeats the per-workspace `hostPattern` routing and fails with `invalid_auth`.

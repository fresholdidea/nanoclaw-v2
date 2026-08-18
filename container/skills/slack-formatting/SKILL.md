---
name: slack-formatting
description: Format replies for Slack. Slack renders standard markdown natively — write normal markdown, not legacy mrkdwn. Use when replying to a Slack destination (currently zed-dm-brad or nanoclaw).
---

# Slack message formatting

**Write standard markdown.** Slack renders it natively. The legacy mrkdwn dialect
(`*bold*`, `<url|text>`) is wrong here and renders badly — see the bottom section.

## How to tell you are in Slack

You never see `channel_type` or `platform_id` — the formatter strips routing fields
before messages reach you. The only signal is the `from="…"` attribute on the
incoming message, which names the destination:

| `from="…"` | Where |
|---|---|
| `zed-dm-brad` | Slack DM with Brad |
| `nanoclaw` | Slack `#nanoclaw` |
| `telegram-mg-…` | Telegram — not Slack |

Those Slack names are install-specific. `ncl destinations list` shows the
`channel_type` column if you need to confirm which destinations are Slack.

## Why standard markdown

Your reply travels as `{ markdown: … }` → the Slack adapter puts it in Slack's
`markdown_text` field → Slack parses **standard markdown**. Write exactly what you
would write anywhere else.

Supported: `**bold**`, `*italic*` / `_italic_`, `~~strikethrough~~`,
`[text](url)`, ordered lists (`1.`), unordered lists (`- `), headings (`#`…`######`),
`` `inline code` ``, fenced code blocks with language hints, `> blockquotes`,
`---` horizontal rules, tables, and task lists (`- [ ]` / `- [x]`).

Three caveats:

- **Nested lists are not supported** — flatten them, or use a heading per group.
- **Images render as links.** `![alt](url)` degrades to `[alt](url)`. To actually
  show an image, send it as a file instead of embedding a URL.
- **Headings all render at the same size**, so heading level conveys structure, not
  visual hierarchy. Don't rely on `#` vs `###` looking different.

## Slack-specific syntax (not markdown)

These are Slack entity references and pass through the markdown untouched. They are
the one place Slack's own syntax is still required:

```
<@U0B02HS2Z7S>    mention a user — must be the member ID, not a display name
<#C0BQZJN5BMJ>    link a channel — must be the channel ID
<!here>           notify active members in the channel
<!channel>        notify everyone in the channel
:white_check_mark:  emoji shortcodes work normally
```

Use `<!here>` and `<!channel>` sparingly — they notify real people.

## Not this skill: direct Web API posts

This skill covers replies in Slack conversations NanoClaw is wired to. Posting to a
client workspace yourself via `chat.postMessage` with a `text` field is a different
path with the *opposite* dialect — that one is mrkdwn. See `/slack-api`.

## Length limit

Slack caps `markdown_text` at **12,000 characters**, and the Slack bridge does
**not** auto-split long replies the way Telegram's does. A reply over the cap fails
to send rather than truncating. Keep messages well under it; if you have more to
say, send the long form as a file and summarize in the message.

## Do not use legacy mrkdwn

Slack's older mrkdwn dialect actively breaks in this pipeline:

| Don't write | Because | Write instead |
|---|---|---|
| `*bold*` | single asterisks mean *italic* in standard markdown | `**bold**` |
| `<https://x.com\|text>` | renders as literal junk | `[text](https://x.com)` |
| `~strike~` | needs doubled tildes | `~~strike~~` |
| `• manual bullets` | markdown lists render properly | `- item` |

If you find yourself reaching for mrkdwn because a message "looked wrong in Slack,"
the fix is almost never mrkdwn — check the length cap and the nested-list caveat
above first.

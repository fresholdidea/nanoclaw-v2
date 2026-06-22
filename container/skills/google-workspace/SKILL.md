---
name: google-workspace
description: Operate Google Workspace (Gmail, Calendar, Drive, Docs, etc.) for any of the user's allowed accounts via the gws CLI. Use when the user asks about email, calendar events, drive files, or anything in their Google Workspace.
---

# /google-workspace — Google Workspace via `gws-account`

Use the `gws-account` helper to run any `gws` CLI command against one of the user's authorized Google accounts.

## Quick reference

```bash
# List available accounts (no extra args)
gws-account

# Unread inbox summary (helper — best for triage)
gws-account jaybhess@gmail.com gmail +triage --max 10 --format table

# Recent emails (raw API — note the `users` resource)
gws-account jaybhess@gmail.com gmail users messages list --params '{"userId":"me","q":"in:inbox newer_than:1d","maxResults":10}'

# Upcoming calendar events (helper — handles relative time)
gws-account jaybhess@gmail.com calendar +agenda --week

# Drive search
gws-account jaybhess@gmail.com drive files list --params '{"q":"name contains \"proposal\"","pageSize":10}'
```

## How it works

- The helper reads `/workspace/extra/gws-config/accounts/<account>.json` (refresh token) and `/workspace/extra/gws-config/client_secret.json` (OAuth client) — both mounted read-only.
- It composes a temp credentials file (chmod 600 in `/tmp`), execs `gws`, and deletes the temp file on exit.
- The credentials file never enters environment variables and never lands in your home directory.

## Account selection

Per-account access is enforced by which JSON files are mounted into your container. Run `gws-account` with no args to see what you can use. If an account the user mentions isn't listed, tell them — don't try to guess or substitute.

## Common gws commands

`gws` is `@googleworkspace/cli` (v0.22.x — a rewrite; older `gws gmail messages list`-style syntax no longer works). Command shape: `<service> <resource> [sub-resource] <method>`. Services: `gmail`, `calendar`, `drive`, `docs`, `sheets`, `tasks`, `people`, `admin-reports`, etc.

- **Raw API** — `gws <service> <resource> <method> --params '<json>'`, e.g. `gmail users messages list`, `calendar events list`, `drive files list`. `--params` is URL/query params; `--json '<json>'` is the request body for create/update (POST/PATCH).
- **Helpers** (prefixed `+`) are the ergonomic path for common tasks and handle paging/threading/relative-time for you: `gmail +triage`, `gmail +send`, `gmail +read`, `gmail +reply`, `calendar +agenda`, `calendar +insert`, `drive +upload`, `docs +write`, `sheets +read`/`+append`. Run `gws <service> --help` to list them, `gws <service> +<helper> --help` for flags.
- **Discover** exact params for any raw method with `gws schema <service.resource.method>` (e.g. `gws schema gmail.users.messages.list`).

If a call returns lots of data, page or filter via `--params` (or `--page-all`) rather than dumping everything to chat.

## Relative time

There are no literal time tokens — use the calendar helper flags: `gws calendar +agenda --today | --tomorrow | --week | --days <N>`. For raw `events list`, `timeMin`/`timeMax` take RFC3339 timestamps.

## When to use

- User asks about their calendar, schedule, agenda, or upcoming events
- User asks about their inbox, recent emails, or specific senders/subjects
- User asks about files in their Drive, Docs, or Sheets
- User wants to send an email, create a calendar event, or draft a doc

## When NOT to use

- The user's question is general (e.g. "what's on the news today") — use web search instead
- The data lives in Obsidian or super-productivity, not Google Workspace
- The account they mention isn't in your mounted accounts list (tell them, don't substitute)

## Errors

- `gws-config not mounted` — this group's container.json doesn't mount a gws dir. Tell the user to wire it via `/manage-mounts`.
- `no account file for <email>` — that account isn't in this agent's allowlist. Show available accounts via `gws-account` (no args) and ask the user which to use.
- `invalid_grant` from gws — the refresh token is genuinely expired or revoked. Tell the user to re-authorize that account on the host (`gws auth login` from outside the container).
- `401 ... invalid authentication credentials` **but the token should be valid** — this is almost always the OneCLI gateway, **not** a token problem, so re-authorizing will not fix it. For agents in `mode all`, a vault secret that injects an `Authorization` header on a broad `*.googleapis.com` pattern overwrites gws's own OAuth bearer. Surface this to the user as a host-side fix: scope the offending secret to its real host (e.g. a Gemini key → `generativelanguage.googleapis.com`, not `*.googleapis.com`). Distinguishing tell: the call fails through the gateway but the underlying refresh token still mints a valid access token.

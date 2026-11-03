---
name: notebooklm
description: Create and query Google NotebookLM notebooks via the `nlm` CLI — add sources (URLs, files, YouTube, Drive, text), ask grounded/cited questions, and generate audio overviews, video, quizzes, flashcards, mind-maps, slide decks, infographics, and reports. Use when the user wants to build or research a persistent notebook of their own sources rather than re-scraping the web each turn.
---

# NotebookLM via `nlm`

Drive Google NotebookLM from the command line with `nlm`. NotebookLM is a
**research-with-your-own-sources** surface: dump a pile of URLs/docs into a
notebook once, then ask grounded questions and get short answers **with
citations** — without re-reading the sources every turn.

Run `nlm --ai` for full, always-current documentation, or `nlm <command> --help`
for any command's flags. This skill covers the common loop and the things that
are specific to running inside a NanoClaw container.

## Auth — one shared account, login is host-side only

- All groups share **one** Google account (`jaybhess@gmail.com`). Its cookies are
  bind-mounted read-write at `/workspace/extra/notebooklm` (the `NOTEBOOKLM_MCP_CLI_PATH`
  the CLI reads). Notebooks you create are visible to every group **and** to Brad's
  own NotebookLM UI — name them clearly.
- **You cannot log in from inside the container.** `nlm login` opens a real Chrome
  session, which only exists on Brad's Mac. Never run `nlm login` here — it will
  hang.
- Cookies usually stay valid for weeks and self-heal automatically. If they truly
  expire you'll see `Cookies have expired` / auth status `stale`. When that
  happens, **stop and tell Brad to run `nlm login` on his Mac** — that refreshes
  the shared cookie file and every container picks it up on the next call. Do not
  treat a network/proxy blip (`unverified`) as expired auth; retry the call first.

```bash
nlm login --check      # safe: verify the shared session is valid (does NOT open a browser)
```

## The common loop

```bash
# 1. Create (or reuse) a notebook — returns an ID; capture it
nlm notebook create "Q3 Competitor Research"
nlm notebook list                      # find an existing notebook's ID

# 2. Add sources (repeat flags for bulk; --wait blocks until processed)
nlm source add <nb-id> --url https://example.com/post --wait
nlm source add <nb-id> --url https://a.com --url https://b.com   # bulk URLs
nlm source add <nb-id> --youtube https://youtu.be/xyz
nlm source add <nb-id> --file ./report.pdf --wait
nlm source add <nb-id> --text "pasted notes" --title "Call notes"
nlm source add <nb-id> --drive <doc-id> --type doc
nlm source list <nb-id>

# 3. Ask — grounded, cited answer (this is the primary verb)
nlm query notebook <nb-id> "What do these sources say about pricing?"
nlm query notebook <nb-id> "And churn?" -c <conversation-id>   # follow-up
```

Use `nlm alias set <name> <uuid>` + `nlm alias list` to avoid pasting long UUIDs
(check `nlm alias list` first to avoid clobbering an existing alias).

## Studio generation (audio, video, quizzes, …)

Generation is **slow and async**, and some formats (especially video) are
quota-limited. Kick off, then poll — don't block waiting.

```bash
nlm audio create <nb-id> --confirm          # podcast / audio overview
nlm report create <nb-id> --confirm
nlm quiz create <nb-id> --confirm
nlm flashcards create <nb-id> --confirm
nlm mindmap create <nb-id> --confirm
nlm slides create <nb-id> --confirm
nlm infographic create <nb-id> --confirm
nlm video create <nb-id> --confirm          # quota-limited — confirm intent first
nlm data-table create <nb-id> "columns to extract" --confirm

nlm studio status <nb-id>                   # poll until ready
nlm download audio <nb-id> -o ./overview.m4a   # per-type: audio|video|slide-deck|report|
                                               # mind-map|data-table|quiz|flashcards|infographic
```

Generation and deletion require `--confirm`. Before generating, tell the user in
one line what you're about to make. **Before any `delete`, ask the user first —
deletions are irreversible.** Discover new sources with
`nlm research start "<query>" --notebook-id <nb-id>`.

## Rules

- **Never run `nlm login`** in the container (see Auth). Diagnose with
  `nlm login --check`; escalate real expiry to Brad.
- **Never run `nlm chat start`** — it's an interactive REPL you can't drive. Use
  `nlm query notebook` for one-shot Q&A.
- Prefer the default (compact) output for status; add `--json` only when you need
  to parse specific fields.
- Capture the IDs that `create`/`start` print — later commands need them.
- Ask before `delete`; state intent before generating.

## When something breaks

| Symptom | Cause | Do this |
|---|---|---|
| `Cookies have expired` / auth `stale` | Shared session rejected | Stop; ask Brad to run `nlm login` on his Mac |
| auth `unverified`, hangs, `nodename nor servname` | Network/proxy, not auth | Retry the call; if it persists, report the proxy failure — don't ask for re-login |
| `Notebook not found` | Stale/invalid ID | `nlm notebook list` |
| `Source not found` | Invalid source ID | `nlm source list <nb-id>` |
| Anything unclear | — | `nlm <command> --help` or `nlm --ai` |

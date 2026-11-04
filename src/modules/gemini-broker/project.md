# Gemini broker module

Lets any agent hand a big read to Gemini on the operator's Google AI Pro plan, and the Google sign-in never enters a container. The container tool `ask_gemini` writes a `gemini_request` system row. The host copies the named files, runs the Antigravity CLI (`agy`) headless, and sends the answer back as a chat message from `gemini-broker`, with the full text attached as Markdown and a wake.

`gemini` itself no longer signs in headless for Google-login users, since it stops at a browser prompt, so the broker drives `agy`, its successor.

## Flow

1. `handleGeminiRequest` (delivery action) validates the request:
   - It checks the sign-in and the `agy` binary before charging anything.
   - It resolves each path against the caller's own mounts and snapshots the files into a fresh workspace.
   - It reserves budget, writes `data/gemini-broker/jobs/<id>.json` and queues the job.

   The handler never throws, because a throw would re-enter delivery retries. A re-delivered row with the same session and request id is dropped, and each agent may have at most 3 requests pending. Every refusal goes back to the agent as a message.
2. A single worker runs one job at a time:
   - It runs `prepareBrokerHome`, which scrubs the home, then `runAgy` with `--sandbox --disable-slash-commands --output-format json` in its own process group.
   - It settles the reservation, or refunds it when agy produced nothing, and scrubs the home again.
   - If the answer contains any part of the sign-in token, it is withheld.
   - Otherwise the answer is delivered with every line of the preview quoted (`│ `), so Gemini's text cannot pass for a host line.
3. On host start, each job whose workspace survived is re-run. A job whose workspace is gone gets a "send it again" message.

## Isolation

- **HOME.** agy runs with `HOME` set to `data/gemini-broker/home`. The home is scrubbed before and after every run down to the token copy and agy's own binaries, so nothing one group's run leaves behind reaches the next. It holds a `settings.json` that denies `command(*)`, `mcp(*)`, `read_url(*)`, `execute_url(*)` and `write_file(*)`. agy auto-denies anything that would need an interactive approval, so reads outside the workspace fail too. The operator's own `~/.gemini` config, with its MCP servers for ad accounts, HubSpot and the rest, is never loaded.
- **Workspace.** The workspace lives under the OS temp dir. If it sat inside the checkout, agy would treat the git repo, and so `.env`, as its workspace. File copies get an index prefix, so no copy can become `AGENTS.md` or `.agents`.
- **Path resolution** (`paths.ts`):
  - Each path maps through the longest matching mount: `/workspace/agent`, `/workspace/inbox` and the validated `additionalMounts`. Masks therefore hide what they hide in the container.
  - Every segment opens through `AnchoredDir` with `O_NOFOLLOW`, so a symlink planted in an RW mount can't reach host files.
  - A denylist refuses credential paths the container can read but that shouldn't go to Google, such as `gws-config`, `.env`, keys and `*credentials*` files. It checks names, the directory segments on both the container and the host side, and file contents (private keys, OAuth refresh tokens and client secrets, provider API keys).
  - A configured mount that fails validation now, such as a missing mask dir, refuses everything under it. So does a mount whose host path resolves through a symlink.
- **Google Search grounding** still works. It runs server-side, so queries only go to Google.

## Configuration (`.env`, read on every request)

| Key | Default |
|---|---|
| `GEMINI_BROKER_ENABLED` | on (`false` turns it off) |
| `GEMINI_BROKER_GROUPS` | `*`, or a comma-separated list of agent folders |
| `GEMINI_BROKER_DAILY_REQUESTS` | 40 install-wide |
| `GEMINI_BROKER_GROUP_DAILY_REQUESTS` | 15 per agent group |
| `GEMINI_BROKER_DAILY_INPUT_TOKENS` | 8,000,000 |
| `GEMINI_BROKER_MAX_FILES` / `_MAX_FILE_BYTES` / `_MAX_TOTAL_BYTES` | 20 / 3 MB / 3 MB |
| `GEMINI_BROKER_TIMEOUT_SEC` | 600 |
| `GEMINI_BROKER_MODEL_PREFIX` | `gemini-3.8-flash` (the tool's effort setting adds `-low`, `-medium` or `-high`) |
| `GEMINI_BROKER_AGY_BIN` | `~/.local/bin/agy` |

Each reservation holds its token estimate until the run settles, so queued requests can't jointly overrun the cap. Settling and refunding only touch the reservation's own day. The day is the install-timezone date. Usage is in `data/gemini-broker/usage.json`. `requests.jsonl` holds one metadata line per request (no prompts or contents), which the steward can read.

## Operations

- **"sign-in has expired"**: run `agy` once on the Mac and sign in. The broker copies the newer token on its next run.
- **The broker home**: delete `data/gemini-broker/home` to reset it; it is rebuilt on the next request.
- **Check isolation after an agy upgrade**: a request asking Gemini to run `whoami`, fetch a URL and read a file outside the workspace must report all three as denied.

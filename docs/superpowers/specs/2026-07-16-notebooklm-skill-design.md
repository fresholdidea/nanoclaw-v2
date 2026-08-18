# `/notebooklm` Container Skill — Design

**Status:** In implementation (branch `notebooklm-skill`)
**Date:** 2026-07-16
**Author:** Brad (via brainstorm with Claude Code)

> **Implementation addendum (2026-07-16, post-discovery).** Two decisions in this
> design changed once the tool was actually installed and inspected on the host.
> The body below is preserved as the original design; the addendum at the end
> ([Implementation addendum](#implementation-addendum-discovery-findings)) is
> authoritative where they conflict.

## Goal

Give every NanoClaw agent group programmatic access to Google NotebookLM — create notebooks, add sources, ask grounded/cited questions, and generate Studio artifacts (audio overviews, video, quizzes, mind-maps, reports) — through a **CLI-backed global container skill**, matching the shape of `agent-browser`, `google-workspace`, and `vercel-cli`.

## Why

NotebookLM is the missing "research-with-my-own-sources" surface for Brad's agents. An agent can already browse the web (`agent-browser`) and operate Workspace (`gws`), but has no way to build a persistent, citation-backed knowledge notebook and query it. NotebookLM fills that gap: dump a pile of URLs/docs into a notebook once, then get short grounded answers with citations on demand — without re-scraping or burning context re-reading sources every turn.

## The hard constraint: no consumer API

Brad is on **Google One AI Pro** (consumer NotebookLM at `notebooklm.google.com`), not NotebookLM Enterprise. Consequences:

- **There is no official consumer API.** Google's official REST API (launched Sept 2025) is gated behind *NotebookLM Enterprise + a Google Cloud org*. Not available here.
- **Every viable tool drives a real browser session** authenticated with Google login cookies. Chromium is already baked into the agent image (`/usr/bin/chromium`, with `PLAYWRIGHT_*` env vars set), so this is feasible.
- The auth model is therefore **cookie/token-based, not API-key-based** — OneCLI vault injection does not apply (see OneCLI/proxy section).

## Decision 1 — CLI, not MCP

**Chosen: CLI.** For NanoClaw specifically:

- The container-skill pattern is CLI-over-Bash + a `SKILL.md`. Every existing container tool (`gws`, `agent-browser`, `vercel`, `deepline`, `mnemon`, `ncl`, `onecli`) follows this. A NotebookLM CLI drops straight in: install the binary in the Dockerfile, ship a `SKILL.md`. **No `container.json` MCP wiring per group.**
- An MCP server would add a persistent stdio process per session and load ~30+ tool schemas into every agent's context permanently — heavy for an occasionally-used tool. The unified upstream packages ship the CLI anyway; their MCP is a thin wrapper over identical operations.
- CLI output is greppable/pipeable and the agent already fluently uses the Bash + `SKILL.md` idiom.

MCP would only win if we wanted always-on zero-token grounded Q&A as a first-class tool call. We don't — occasional, explicit use fits the CLI model.

## Decision 2 — Tool: `teng-lin/notebooklm-py`

Two mature unofficial tools exist. Chosen: **`teng-lin/notebooklm-py`**.

| | teng-lin/notebooklm-py | jacob-bd/notebooklm-mcp-cli |
|---|---|---|
| Runtime | Python 3.10–3.14 | Python |
| Auth | **master-token: mints fresh cookies on demand, no per-session browser, self-heals expired sessions** | extracted browser cookies, expire 2–4 weeks, re-login needs a browser window |
| Interfaces | CLI + MCP + Python SDK + agent skill | CLI + MCP (35 tools) |
| Fit for `--rm` containers | **Strong** — headless, unattended | Weak — cookie jar expires, re-auth is interactive |

The decisive factor is **auth robustness in ephemeral containers**. NanoClaw containers are per-session and `--rm`; there is no place for an interactive re-login when cookies expire mid-run. teng-lin's `--master-token` mode is purpose-built for "servers, CI, and the remote MCP connector" and self-heals unattended. jacob-bd's cookie-jar model would silently die every few weeks and require a human at a browser.

## Architecture

Three artifacts, matching the `agent-browser`/`gws` precedent (host-side one-time auth → shared mount → in-container CLI):

### 1. Dockerfile install (pinned)

Add to `container/Dockerfile`, in the CLI-install region, pinned via an `ARG` like every other tool:

```dockerfile
ARG NOTEBOOKLM_PY_VERSION=0.7.3
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    /root/.local/bin/uv tool install "notebooklm-py[browser]==${NOTEBOOKLM_PY_VERSION}"
```

Pin: **0.7.3** is the latest stable (released 2026-06-30, well-aged). The `0.8.0aN/bN` pre-releases are deliberately avoided.

Notes:
- `uv` is not yet in the image; the single-binary installer is the lightest way to get `uv tool install`. (Alternative: `pipx`, also not present. `uv` is preferred — faster, self-contained, and the tool's own README lists it first.)
- The `[browser]` extra pulls Playwright. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` are already set in the image, so Playwright reuses the system Chromium instead of downloading its own ~300 MB copy. **Verify this holds** — if the master-token path never spawns Playwright at runtime, we may be able to install *without* `[browser]` and shrink the image; confirm during implementation.
- The image already has `python3` (Debian bookworm → 3.11, within the 3.10–3.14 range). `uv tool install` manages its own isolated environment regardless.
- Ensure the resulting `notebooklm` entrypoint is on the agent-runner's runtime `PATH` (uv installs to `~/.local/bin` / `/root/.local/bin`; the agent runs as the `node` user — install to a shared location or symlink into `/usr/local/bin`, the way `bun` and `deepline` are handled).

### 2. Auth model — one-time host login + shared mount

The master token needs a persistent home shared across all groups (Brad chose **global** scope, one Google account). Reuse the **exact `~/.mnemon` pattern**:

- **Host, one-time:** Brad runs `notebooklm login --master-token --account jaybhess@gmail.com` on his Mac (interactive browser once), writing the token/session into a host dir — call it `~/.notebooklm`.
- **Mount:** each group's `container.json` `additionalMounts` binds host `~/.notebooklm` (RW) into the container at a fixed path (e.g. `/workspace/extra/notebooklm`), and an env var points the CLI at it (mirroring `MNEMON_DATA_DIR=/workspace/extra/mnemon`).
- **Self-heal:** thereafter the master token mints fresh cookies on demand inside the container; no interactive re-login until the master token itself is revoked.

> **Open item (resolve in implementation):** the upstream README does not document the exact storage path or the env var that overrides it. Before writing the mount, confirm via `notebooklm login --help` / `docs/configuration.md` / `auth inspect` what directory holds the token and which env var (if any) relocates it. If it is not relocatable, the mount target must match the CLI's default (`$HOME/.config/notebooklm` or similar) and `HOME` in the container must line up.

Because scope is global, **one shared Google session backs every group** — acceptable and intended per Brad's choice. If per-group isolation is ever wanted, switch to per-group mount dirs + `profile` support (`notebooklm profile switch`).

### 3. The skill — `container/skills/notebooklm/SKILL.md` (global)

Global container skill (lives in `container/skills/`, bind-mounted into every group at `/app/skills`, effective on next container spawn). Frontmatter matches house style:

```markdown
---
name: notebooklm
description: Create and query Google NotebookLM notebooks — add sources (URLs, files, YouTube, Drive), ask grounded/cited questions, and generate audio overviews, video, quizzes, mind-maps, and reports. Use when the user wants to build or research a persistent notebook of their own sources.
---
```

Body documents the command surface the agent will actually use:

- **Auth check:** `notebooklm auth check` (diagnose), `notebooklm auth refresh` (keepalive)
- **Notebooks:** `create`, `list`, `use` (set active), `rename`, `delete`, `metadata`
- **Sources:** `source add <url|file|youtube|drive|text>`, `source add-research` (auto-import web/Drive research), `list`
- **Query:** `ask "<question>"` → grounded, cited answer (the primary verb)
- **Generate:** `generate audio|video|quiz|flashcards|slide-deck|infographic|mind-map|data-table|report`
- **Download artifacts:** `download <artifact-type>` → local file
- **Accounts:** `profile list`, `profile switch`

The `SKILL.md` will lead with the common loop (`create` → `source add` → `ask`), note that Studio generation (audio/video) is slow/async, and include a short Errors section (auth expiry → `auth check`; how to signal a needed host re-login).

## OneCLI / proxy interaction (gotcha to verify)

Agent containers route all outbound HTTP through the OneCLI gateway via `HTTP_PROXY`/`HTTPS_PROXY`. NotebookLM traffic hits `notebooklm.google.com` and other `*.google.com` hosts (undocumented internal Google endpoints), **not** `*.googleapis.com` — so the known `GEMINI_API_KEY` `Authorization`-clobber (memory: broad `*.googleapis.com` secret overwriting OAuth bearers) should not match. **But confirm:**

- No vault secret injects `Authorization` or cookies on a `*.google.com` pattern that would corrupt NotebookLM's own auth.
- Decide whether NotebookLM traffic should bypass the proxy entirely via `NO_PROXY` (its auth is cookie/token-based and needs no OneCLI injection). If the proxy interferes with cookie handling or TLS to Google's internal endpoints, add the relevant hosts to `NO_PROXY` for the container.

This is a verification step, not a known break — but it is the single most likely place this skill fails silently on first run, so it gets explicit test coverage.

## Non-goals

- **NotebookLM Enterprise / official API path.** Brad is consumer-tier; the official API is out of reach and out of scope. If he ever moves to Enterprise, a separate `nblm`-style skill using the real REST API would supersede this.
- **MCP server variant.** Explicitly rejected above. Not shipping one.
- **Per-group Google account isolation.** Global/single-account by choice. Multi-profile support is documented as a future switch, not built now.
- **An `/add-notebooklm` install skill on trunk.** Unlike channels/providers, this is a always-on global container skill baked into the image, not an opt-in per-group install. (Revisit only if we want it opt-in.)
- **Automated version upgrades.** Bumping `NOTEBOOKLM_PY_VERSION` + rebuild is manual and deliberate, matching every other pinned CLI.

## Risks / open items (carry into the plan)

1. **Auth storage path + env var** — undocumented upstream; must be discovered before wiring the mount (see Auth model open item).
2. **Playwright at runtime** — confirm whether master-token mode ever spawns a browser in-container. If not, drop `[browser]` extra to save image weight. If yes, confirm system Chromium is used (env vars already set) and that headless works under the container's user.
3. **Proxy/NO_PROXY** — verify OneCLI gateway does not corrupt Google cookie auth (see OneCLI section).
4. **PATH for the `node` user** — uv installs under `/root/.local/bin`; ensure the agent (running as `node`) can resolve `notebooklm` (symlink to `/usr/local/bin`, per the `bun`/`deepline` precedent).
5. **First-run auth bootstrap** — document the exact one-time host `notebooklm login --master-token` command and where it writes, so a fresh install is reproducible.
6. **Image size** — Python + uv + notebooklm-py (+ maybe Playwright deps) adds weight; measure and note in `docs/build-and-runtime.md`.

## Success criteria

- From any agent group, `notebooklm ask "<q>"` against a pre-populated notebook returns a cited answer with no interactive auth step.
- `notebooklm create` + `source add` + `ask` round-trips end-to-end inside a live container.
- After the master token's cookies naturally expire, the next `ask` self-heals without human intervention.
- Rebuild + restart is the only step needed to roll the skill to all groups.

## Implementation addendum (discovery findings)

Discovery was done against the tool **already installed on Brad's Mac**, so several
"open items" above are now resolved with facts rather than assumptions. Where this
addendum conflicts with the body, the addendum wins.

### Deviation 1 — tool is `jacob-bd/notebooklm-mcp-cli` (`nlm`), not `teng-lin/notebooklm-py`

Decision 2 in the body picked `teng-lin/notebooklm-py` (entrypoint `notebooklm`,
`--master-token`). What Brad actually installed and authenticated is
**`notebooklm-mcp-cli` v0.8.7** — entrypoint **`nlm`**, package on PyPI, installed via
`uv tool install`. Brad chose to standardize on this tool (it's the same one wired into
his Hermes agent and the Antigravity IDE). This design follows the installed tool.

The body's objection to jacob-bd (cookie jar dies in `--rm` containers, needs an
interactive re-login) **does not hold** for the container model we're building — see
Deviation 2. The tool has also grown well past the body's snapshot: a unified command
surface (`create`/`source`/`query`/`studio`/`download`/`research`/`batch`/`cross`/
`pipeline`), profiles, and a `--provider openclaw --cdp-url` external-browser mode.

### Deviation 2 — auth is a portable 20K cookie file; no browser/Playwright in-container

The load-bearing discovery. `nlm` stores everything under `~/.notebooklm-mcp-cli/`:

| Path | Size | Role | Needed in container? |
|------|------|------|----------------------|
| `profiles/<name>/cookies.json` + `metadata.json` | ~20K | The actual auth credential used for HTTP RPC queries | **Yes** |
| `chrome-profiles/<name>/` | ~71M | Chrome user-data dir used **only at interactive login time** (driven over CDP) | **No** |
| `cache/`, `chrome-port-map.json` | tiny | runtime scratch | No |

Verified on the host: `nlm list notebooks` returns real notebooks **purely from
`cookies.json` with no browser spawn**, and a **profiles-only 20K store at an arbitrary
path** (pointed to via `NOTEBOOKLM_MCP_CLI_PATH`) works identically. `notebooklm-mcp-cli`
does **not depend on Playwright** at all (deps: `fastmcp, httpx[socks], platformdirs,
pydantic, pyyaml, rich, typer, websocket-client`); login drives an external Chrome over
CDP. Since the container never logs in (login is a one-time host step), **the image needs
nothing browser-related for `nlm`.**

### Resolutions to the "open items" list

1. **Auth storage path + env var** — RESOLVED. Root: `~/.notebooklm-mcp-cli/`. Relocated
   via **`NOTEBOOKLM_MCP_CLI_PATH`** (`notebooklm_tools/utils/config.py:get_storage_dir`).
   Container mounts host `~/.notebooklm-mcp-cli` → `/workspace/extra/notebooklm` and the
   image bakes `ENV NOTEBOOKLM_MCP_CLI_PATH=/workspace/extra/notebooklm` — the exact
   `MNEMON_DATA_DIR` pattern.
2. **Playwright at runtime** — RESOLVED. Not a dependency; not needed in-container. No
   `[browser]` extra.
3. **Proxy/NO_PROXY** — still a verification step. `nlm` honors `http_proxy`/`https_proxy`/
   `NO_PROXY`. Traffic hits `notebooklm.google.com` (not `*.googleapis.com`), so the known
   `GEMINI_API_KEY` clobber shouldn't match — confirm during container e2e.
4. **PATH for `node`** — install must land in a `node`-readable location. `uv tool install`
   defaults under `/root/.local` (mode 0700, unreadable by `node`); use
   `UV_TOOL_DIR`/`UV_TOOL_BIN_DIR` pointed at world-readable paths (`/opt/uv/tools`,
   `/usr/local/bin`) so `/usr/local/bin/nlm` resolves — mirrors `bun`/`deepline`/`ncl`.
5. **First-run auth bootstrap** — one-time host command is `nlm login` (interactive Chrome
   once). Already done: profile `default: jaybhess@gmail.com`. Refresh-on-expiry = re-run
   `nlm login` on the host; the shared cookie file self-heals every container.
6. **Image size** — the `uv`-managed Python + deps adds **~73M** (no Playwright). Note in
   `docs/build-and-runtime.md`.

### Command-surface note

The container `SKILL.md` is adapted from the tool's own generated skill
(`nlm skill install` → 891-line `SKILL.md` + reference files), not the body's guessed
verb list, so it matches v0.8.7 exactly. Verbs the body listed under `notebooklm ask`
map to `nlm query`; `source add` → `nlm source add` / `nlm add`; Studio generation →
`nlm audio|video|quiz|...` or `nlm studio`.

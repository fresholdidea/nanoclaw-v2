# NanoClaw v1 → v2 Customization Inventory

Generated: 2026-04-29
Source repo: `/Users/bradhess/Documents/GitHub/nanoclaw` (v1, 444 commits ahead of `upstream/main`)
Target repo: `/Users/bradhess/Documents/GitHub/nanoclaw-v2` (fresh v2 install)

> v1 → v2 is a ground-up rewrite. This inventory captures *intent*, not diffs. Each item below
> needs to be reimplemented using v2 mechanisms (skills, OneCLI vault, groups/<folder>/CLAUDE.md,
> per-group container config), not mechanically replayed.

## Persona

- Assistant name: **Zed**
- Personal assistant role with elevated privileges in main groups
- Shared global context with channel-specific formatting rules (Slack, WhatsApp/Telegram, Discord)

## Active Channels & Groups (5 groups, 2 channels)

| Group | Trigger | Channel | Notes |
|---|---|---|---|
| `telegram_main` | `@Zed` | Telegram | main channel; richest integration set |
| `whatsapp_main` | `@Zed` | WhatsApp | paired with telegram_main |
| `whatsapp_home` | `Zed` (no @) | WhatsApp | separate workspace, no-@ trigger |
| `wiki` | `@Wiki` | Telegram | isolated knowledge-base agent |
| `ads` | `@Zed` | Telegram | ad-account management |

**v2 path:** `/add-telegram`, `/add-whatsapp`, then `/manage-channels` to wire groups.

**Gotchas:**
- v1 has flexible trigger syntax (allows `Zed` without `@`). Verify v2 supports this or pick `@`-prefix triggers.
- v1 has a Telegram bot pool (`TELEGRAM_BOT_POOL`). v2 architecture may not need this — review.

## Heavy Integrations (telegram_main)

1. **Google Workspace** — 6 GWS accounts with credential injection at container spawn. v1 uses a `/usr/local/bin/gws-account` helper baked into the image.
   - **v2 path:** OneCLI vault per-group. Custom helper script may need to be ported into container skill or baked into image.
2. **n8n webhook delegation** — 4 workflows: LinkedIn post creator, voice ingestion, newsletter builder, +1.
   - **v2 path:** custom MCP server or container-side fetch tool. No upstream skill yet.
3. **SolidTime time-tracking** — env-injected (`SOLIDTIME_URL`, `SOLIDTIME_ORG`, `SOLIDTIME_TOKEN`).
   - **v2 path:** OneCLI secret + per-group MCP server.
4. **Meta Ads + LinkedIn Ads + Google Ads MCP servers** — Python MCP servers + npm `meta-ads-mcp` baked into container.
   - **v2 path:** install via per-group `install_packages` self-mod tool, or port into a custom skill.
5. **Gemini CLI** — `@google/gemini-cli` global, `GEMINI_API_KEY` env.
   - **v2 path:** add to container Dockerfile pinned-package list, or install via `install_packages`.
6. **Obsidian vault mount** — `~/Documents/.../obsidian` → `/workspace/extra/obsidian`.
   - **v2 path:** `additionalMounts` in agent-group config; whitelist via `/manage-mounts`.
7. **Super-productivity client projects mount** — `~/projects/.../clients` → `/workspace/extra/clients`.
   - **v2 path:** same as above.
8. **Karpathy LLM Wiki** — knowledge base mounted at `/workspace/extra/wiki`.
   - **v2 path:** `/add-karpathy-llm-wiki` skill exists in v2.

## Scheduled Tasks — 16 cron jobs

Stored in v1 `store/messages.db` → `scheduled_tasks` table. Breakdown:
- `telegram_main`: 10 (daily 8am, every 30m, MWF 10am, etc.)
- `wiki`: 1 (Sunday 10am, likely weekly digest)
- `ads`: 1 (Monday 9am, likely ad report)
- Other: 4

**v2 path:** v2 has scheduling. Export rows from v1 DB and recreate in v2 via the scheduling skill or admin command. Preserve cron expressions, prompts, and `context_mode` (most are `isolated`).

## Custom Skills (29 user-authored)

High-value ports (not upstream in v2):
- `add-telegram-swarm` (Telegram bot pool — may not be needed in v2)
- `x-integration` (X/Twitter via browser automation)
- `qodo-pr-resolver` + `get-qodo-rules` (Qodo code review)
- `add-voice-transcription` + `use-local-whisper` (audio)
- `add-image-vision` + `add-pdf-reader`
- `add-reactions`
- `add-parallel`, `add-compact`

Already in v2 (skip): `add-discord`, `add-slack`, `add-gmail`, `add-emacs`, `add-macos-statusbar`, `add-ollama-tool`, `add-karpathy-llm-wiki`, `init-onecli`, `customize`, `debug`, `update-nanoclaw`, `update-skills`.

## Custom Source-level Logic (NOT directly portable)

These are commits that modified v1's architecture. They need to be re-evaluated against v2's design:
- Per-group MCP servers → v2 has this concept built in
- Per-group model selection → v2 has this concept built in
- Flexible trigger syntax (no @) → check v2 router
- replyTo override for admin transport → check v2 has equivalent
- Trust SDK isMention signal → check v2 router
- Unknown-channel registration with owner approval → v2 has unknown_sender_policy

## Credentials / .env (move to OneCLI vault)

Names only:
- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_POOL`
- `SOLIDTIME_URL`, `SOLIDTIME_ORG`, `SOLIDTIME_TOKEN`
- GWS service-account JSON (6 accounts)
- Meta Ads, LinkedIn Ads, Google Ads tokens (in MCP-server config)
- `ASSISTANT_NAME=Zed`, `LOG_LEVEL`, `TZ`

## Group-specific files to copy

- `groups/global/CLAUDE.md` — global behavior rules
- `groups/main/CLAUDE.md` — Zed persona (309 lines)
- `groups/telegram_main/CLAUDE.md` — extended persona w/ integration table (399 lines)
- `groups/wiki/CLAUDE.md` — knowledge-base persona (36 lines)
- `groups/ads/CLAUDE.md` — ads persona
- `groups/ads/ad-accounts.json` — ad account mappings

These copy as-is into v2's `groups/<folder>/` after groups are wired.

## Suggested phased migration

1. **Foundation (this session, ~done):** v2 base install via `nanoclaw.sh`. ✅
2. **OneCLI + identity:** `/init-onecli`, then `/init-first-agent` for Zed on Telegram.
3. **Channels:** `/add-whatsapp`. Wire whatsapp_main, whatsapp_home via `/manage-channels`.
4. **Group personas:** copy `groups/*/CLAUDE.md` over.
5. **Mounts:** Obsidian + clients + wiki via `/manage-mounts`.
6. **Integrations one at a time:** GWS → SolidTime → Meta Ads → Gemini → n8n → Wiki. Each via the right v2 mechanism (OneCLI secret, per-group MCP server, container `install_packages`, or custom skill).
7. **Scheduled tasks:** export v1 cron rows, recreate in v2.
8. **Custom skills:** port the high-value ones (`x-integration`, `qodo-*`, voice/vision, etc.).

Estimate: 2–3 focused sessions for steps 2–6; integrations and skills are open-ended.

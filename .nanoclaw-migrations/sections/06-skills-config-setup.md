# §06 — Customization: skills, config, setup, docs

## Container skills (copy verbatim → `container/skills/`)
Base already ships: `agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `slack-formatting`, `vercel-cli`, `welcome`, `whatsapp-formatting`. Fork adds these 13 — copy as-is (in-place upgrade → hardcoded IDs stay valid; listed for awareness):

| Skill | Purpose | Hardcoded refs |
|---|---|---|
| `agy-research` | research via `query_agy`, saved as frontmattered md | — |
| `conversion-cro` | CRO / landing / A-B / checkout | — |
| `draft-invoice` | invoice from Obsidian Company + SolidTime hours → PDF → Gmail (approval-gated) | `brad@demandgenguy.com`, `bradhess@usecache.com` (sender mailboxes); `100.69.48.89:8088` (SolidTime LAN IP) |
| `folder-audit` | folder size/similarity/staleness audit → `.folder-audit.md` | — |
| `google-workspace` (+ `gws-account` bash) | Gmail/Cal/Drive per authorized account; mount `/workspace/extra/gws-config` | `jaybhess@gmail.com` in examples |
| `linear-pm` | Linear issues labeled `agent:zed` | **Demandgenguy workspace UUIDs** (team `14f2750b`, states, labels, projects `demandgenguy/meadow/miller7/falcone-global`) |
| `linkedin-community` (+ `selectors.md`) | LinkedIn organic via agent-browser | DOM selectors dated 2026-05-12 — re-snapshot periodically |
| `marketing-copywriting` | direct-response copy | — |
| `marketing-strategy-analytics` | GTM/pricing/analytics | — |
| `nextjs-react-engineering` | Next.js/React full-stack | — |
| `seo-growth` | technical + on-page SEO | — |
| `slack-api` | outbound Slack Web API, Meadow/Cache/Miller7 | workspace subdomains `meadowglobal/usecache/millermedia7.slack.com` must match vault hostPatterns |
| `wiki` | Obsidian `50-Wiki`/`50-Sources`; mount `/workspace/extra/obsidian` | — |

## Host skills (`.claude/skills/`)
Fork-added (copy): `add-agy`, `audit-website`, `copy-grader`, `firecrawl`, `linkedin-ads`, `linkedin-community`, `reddit-research`, `serper-search`, `social-listening`.
In base but not on `origin/main` (keep as-is): `add-parallel`, `convert-to-apple-container`, `x-integration`.
Deleted intentionally (**do not restore**): `claw/` (D5, `f1c997f`).

## Config / setup deltas

### `.gitignore` — append
```
# Local-only scratch
.claude/worktrees/
.claude/scheduled_tasks.lock
nanoclaw-v2/
falcone-spawn.mjs
.upgrade-worktree/
.retired/
```

### `setup/index.ts` — remove signal-auth registration
```diff
-  'signal-auth': () => import('./signal-auth.js'),
```

### `setup/register.ts` — engage formula (verbatim, replaces upstream mention/pattern logic)
```typescript
const engageMode: 'pattern' | 'mention' = 'pattern';
const engagePattern: string | null = parsed.trigger
  ? (parsed.requiresTrigger ? parsed.trigger : `(${parsed.trigger}|.*)`)
  : '.';
```
No `--trigger` → `.` (match all). `--trigger` w/o requires → `(<trigger>|.*)`. `--trigger` + requires → trigger only.
> Cross-check MEMORY `register_step_drift`: new schema uses `engage_mode`/`engage_pattern`/`sender_scope`/`ignored_message_policy` — confirm upstream's current `register.ts` field names before pasting.

### `CLAUDE.md` — 4 additive gotchas (STOP banner + bulk are upstream; only these differ)
1. OneCLI secrets vault ref → `docs/onecli-secrets.md`.
2. Gotcha: broad `Authorization`-injecting secrets clobber app-managed OAuth (scope Gemini to `generativelanguage.googleapis.com`, not `*.googleapis.com`).
3. Troubleshooting row: host won't start if container runtime is down.
4. Gotcha: `docker exec bash -lc` login shell doesn't inherit agent PATH; diagnose with `tr '\0' '\n' < /proc/1/environ | grep ^PATH=`.
(Portable copies live in MEMORY; CLAUDE.md is canonical in-repo.)

## Patches & scripts
| File | Purpose |
|---|---|
| `patches/@nanoco__nanoclaw-dashboard@0.3.0.patch` | dashboard CSS layout fix (auto-applied via pnpm `patchedDependencies`) |
| `scripts/rebuild-agent-image.ts` | per-agent image drift reconciler; `<id>...` or `--all-customized`. **Under D1, reads config from DB** (§04.A.6) |
| `scripts/seed-agency-agents.ts` | one-shot agency-tier seeder. Hardcodes `ZED_ID = 'ag-1777506396678-rqprll'` — do not rerun without updating |
| `scripts/agy/auth-login.sh`, `scripts/spike/agy/*` | agy auth + spike (§01) |

## `hermes/specs/` (fork-added, docs only, copy verbatim)
`2026-07-01-hermes-mnemon-integration-design.md` — NanoClaw↔Hermes mnemon integration design. Warns against re-running `mnemon setup --target hermes --global`.

## `docs/` deltas
| File | Notes |
|---|---|
| `docs/SPEC.md` | minor: 2 lines removed from v1 file-tree diagram (cosmetic) |
| `docs/docker-sandboxes.md` | new, generic — copy verbatim |
| `docs/onecli-secrets.md` | new, **install-specific** (generated from `onecli secrets list` 2026-05-12) — **regenerate on the host**, don't trust the copy |

## Excluded from migration (data — rebuilt per install)
`groups/*/` (incl. deleted `groups/{global,main}/CLAUDE.md`), `.env`, `data/` (`v2.db`, session DBs), `store/`, `~/.mnemon` (outside repo), `.claude/scheduled_tasks.lock`, `.retired/`.

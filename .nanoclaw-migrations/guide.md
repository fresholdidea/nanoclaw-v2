# NanoClaw Migration Guide — local/main → origin/main

**Generated:** 2026-07-15
**Base (merge-base):** `b9141218`
**HEAD at generation:** `048b30f`
**Upstream HEAD (origin/main):** `a11ad11`
**Rollback anchor:** `pre-update-048b30f-20260715-112726` (tag + branch `backup/pre-update-048b30f-20260715-112726`)

> **Remote note:** In this repo, `origin` **is** the public upstream (`nanocoai/nanoclaw`). `fork` = `fresholdidea/nanoclaw-v2`. There is no remote literally named `upstream`. Everywhere the migrate-nanoclaw skill says `upstream/$BRANCH`, use `origin/main`. Never push to `origin`.

This guide re-extracts the fork's customizations so they can be reapplied on a **clean `origin/main`** checkout (worktree) instead of merging two divergent trees. Drift at generation time: **528 upstream commits**, **70 local commits**, 129 local files changed (+14,472 / −1,863), 40 files overlapping upstream changes.

This is an **in-place** upgrade — same machine, same `data/`, `groups/`, `store/`, `.env`. Hardcoded install IDs (Linear workspace UUIDs, `ZED_ID`, invoice mailboxes, Slack workspace subdomains) stay valid and are **not** re-parameterized.

---

## Decisions (locked)

| # | Topic | Decision | Rationale |
|---|-------|----------|-----------|
| D1 | **container-config storage** | **ADOPT upstream DB model** (reverses the 2026-05-17 "keep file-based" call) | Container side unaffected — upstream still `materializeContainerJson()` → `container.json` at spawn; only host storage changes. Fork is already half-on-DB (`self-mod/apply.ts`, `ncl groups config` write DB) → latent split-brain bug where `buildAgentGroupImage` reads the file. Ends permanent merge tax on the two highest-churn files. See **§04** for the task list. |
| D2 | **persistent memory** | **ADOPT upstream provider-agnostic memory AND keep mnemon** | User wants upstream's instrumented memory. mnemon stays (baked binary, shared `~/.mnemon` across 18 groups + host CC + hermes). Requires a reconciliation pass — see **Follow-ups**. |
| D3 | WhatsApp | Keep Baileys **v7**, dedicated-number mode (shared-number path stripped) | Already migrated to v7 (commit `da7a16c`); this install runs a dedicated bot number. |
| D4 | Slack | Webhook-only (Socket Mode stripped) | Intentional for this install. |
| D5 | `/claw` | Stays **removed** | Stale v1 code, never worked in v2 (commit `f1c997f`). Do not restore. |
| D6 | musl/glibc claude binary | Keep `resolveClaudeBinary()` | Load-bearing on Debian/glibc images; test after any SDK bump. |

---

## Migration Plan (staged)

Work in a worktree checked out at `origin/main`. Reapply in this order — later stages depend on earlier ones.

**Stage 1 — Providers installed from branches (prereq for everything else)**
1. Reinstall channels from `origin/channels` (`/add-telegram`, `/add-whatsapp`, `/add-slack`) — **§03**.
2. Reinstall opencode from `origin/providers` (`/add-opencode`) — **§02**.
3. Reinstall/copy agy provider files — **§01**.
4. Copy `src/attachment-safety.ts` from `origin/channels` (NOT auto-installed) — **§03**.

**Stage 2 — Type foundation (do before host-core edits; many sites depend on it)**
5. Apply the `McpServerConfig` stdio+http/sse union in `container/agent-runner/src/providers/types.ts` and `src/container-config.ts`; remove the `effort` field. Add `'url' in cfg` narrowing at every call site — **§02, §04, §05**.

**Stage 3 — Config storage: adopt DB model** (D1) — **§04 → "container-config: ADOPT DB"**
6. Keep upstream's `container-config.ts` / `db/container-configs.ts` DB model as-is.
7. New migration: add `enable_agy_tooling` + `enable_opencode_tooling` INTEGER columns; map in `configFromDb()` + `SCALAR_COLUMNS`.
8. Port `collectMcpEnvPassthrough` (storage-agnostic) into upstream `container-runner.ts`.
9. Ensure `buildAgentGroupImage` persists `imageTag` to **DB** (`updateContainerConfigScalars`), `rebuild-agent-image.ts` + `dashboard-pusher.ts` read from **DB**.

**Stage 4 — Host core** — **§04**
10. Reapply: OneCLI soft-fail, `killContainer` callback removal (+ call-site updates in `container-restart.ts`, `self-mod/apply.ts`, `cli/resources/groups.ts`, `router.ts`), multi-provider contributions array (`enableAgyTooling`/`enableOpencodeTooling`), `container-runtime.ts` two-pass orphan cleanup, dashboard wiring in `index.ts` + `dashboard-pusher.ts`, ncl socket-server import move.
11. Re-delete the obsolete tests/files (see §04 deletions) if upstream still ships equivalents that reference removed APIs.

**Stage 5 — Container agent-runner + infra** — **§05**
12. Reapply agent-runner changes: `expandMcpEnvPlaceholders`, `sanitizeMessageBody`, `turn-dedup.ts`, poll-loop wiring, `resolveClaudeBinary()`, mcp-tools registrations.
13. Dockerfile: mnemon bake, opencode install, deepline shim, PATH fix, ARGs; `entrypoint.sh` mnemon setup; deps in `package.json`/`bun.lock`/`pnpm-workspace.yaml` patch.

**Stage 6 — Skills, config, setup** — **§06**
14. Copy 13 container skills + fork host skills; `.gitignore`, `setup/register.ts` engage formula, `setup/index.ts` signal-auth removal, dashboard patch, `scripts/`, CLAUDE.md's 4 gotcha additions.

**Stage 7 — Memory reconciliation** (D2) — see Follow-ups.

**Validate after Stage 4 and again after Stage 6:** `pnpm install && pnpm run build && pnpm test`; container typecheck `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

---

## Applied components summary

**Channels** (from `origin/channels`): telegram (+ multi-bot), whatsapp (v7), slack. Barrel `src/channels/index.ts` appends `./telegram.js`, `./whatsapp.js`, `./slack.js`.
**Providers** (from `origin/providers`): opencode. Plus fork-authored **agy** provider. Barrels: `src/providers/index.ts` + `container/agent-runner/src/providers/index.ts` (dynamic loader).
**Custom container skills** (copy verbatim): agy-research, conversion-cro, draft-invoice, folder-audit, google-workspace (+gws-account), linear-pm, linkedin-community, marketing-copywriting, marketing-strategy-analytics, nextjs-react-engineering, seo-growth, slack-api, wiki.
**Fork host skills**: add-agy, audit-website, copy-grader, firecrawl, linkedin-ads, linkedin-community, reddit-research, serper-search, social-listening.

## Section files

| § | File | Covers |
|---|------|--------|
| 01 | `sections/01-agy-provider.md` | agy provider (4th provider) + query_agy |
| 02 | `sections/02-opencode-tooling.md` | opencode provider + query_opencode + McpServerConfig union |
| 03 | `sections/03-channels.md` | telegram multi-bot, whatsapp v7, slack, env helper |
| 04 | `sections/04-host-core.md` | src/ host core + **container-config DB adoption task list** |
| 05 | `sections/05-container-runner-infra.md` | agent-runner + Dockerfile + deps + mnemon bake |
| 06 | `sections/06-skills-config-setup.md` | skills, config, setup, docs, patches |

## Skill interactions / cross-cutting

- **`McpServerConfig` union** touches agy (§01), opencode (§02), channels (§03), host-core (§04), agent-runner (§05). Apply the union **once** in Stage 2, then narrow with `'url' in cfg` everywhere. A file copied from a sibling branch that assumes stdio-only will break the build.
- **Provider barrels** — both host and container `providers/index.ts` list `claude, mock, opencode, agy`. The container barrel is the fault-tolerant dynamic loader (§01/§02); missing a line silently drops that provider.
- **`enableAgyTooling` / `enableOpencodeTooling`** — new DB columns (§04) read by `resolveProviderContribution` in `container-runner.ts` (storage-agnostic). Both provider files must be installed or the host logs a "run /add-*" warning.
- **Per-group agent-runner overlays** — `data/v2-sessions/<group>/agent-runner-src/` overrides the baked image at runtime and is NOT auto-updated. After changing agent-runner provider files, propagate to overlays (script in §01).

## Follow-ups (post-upgrade)

- **[D2] Memory reconciliation** — upstream added provider-agnostic memory (~12 commits at tip, `feat/provider-agnostic-memory`). Decision is to adopt it **alongside** mnemon. After the upgrade builds green: (a) enable upstream memory per its CHANGELOG/settings-hook wiring; (b) confirm it does not double-register hooks against mnemon's `mnemon setup --target claude-code` in `entrypoint.sh`; (c) decide store boundaries (upstream memory store vs `~/.mnemon`) so the agent isn't writing the same facts to two systems. Track as its own task — do not block the code upgrade on it.
- **Per-agent image rebuild** — container-side changes need `./container/build.sh` + `scripts/rebuild-agent-image.ts --all-customized` to reach running containers.
- **`docs/onecli-secrets.md`** — install-specific inventory; regenerate from `onecli secrets list` rather than trusting the copied file.

## Rollback

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
cd /Users/bradhess/Documents/GitHub/nanoclaw-v2
git reset --hard pre-update-048b30f-20260715-112726
pnpm install && pnpm run build
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Verification checklist (fill during upgrade)

- [ ] Host build clean (`pnpm run build`)
- [ ] Host tests pass (`pnpm test`)
- [ ] Container typecheck clean (`tsc -p container/agent-runner/tsconfig.json --noEmit`)
- [ ] Container tests pass (`cd container/agent-runner && bun test`)
- [ ] New migration adds `enable_agy_tooling` / `enable_opencode_tooling` columns; existing rows backfilled to 0
- [ ] Container image rebuilds (`./container/build.sh`)
- [ ] Live round-trip from one channel confirmed
- [ ] Memory reconciliation (D2) tracked as follow-up

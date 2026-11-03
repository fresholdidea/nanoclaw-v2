# Rebuild report: Phase 2 (reapply + validate), 2026-11-03

Branch `rebuild/upstream-2026-11` on origin/main f7440e85. Nothing pushed, live checkout untouched, no service or stamp actions.

## Stages (commits)
1. Skills: 14e8ef9c OneCLI payload (+ onecli.test env isolation in src and payload); 4ddf0fd9 Codex 0.162.1; 10ea136a Telegram from origin/channels + merged asset, topic/unlinkable-URL files, upstream telegram-commands test; 8ae56590 add-slack, slack-a2a-rooms, slack-agent-flow + wire scripts, telegram-repoint-room.ts, slack-api skill.
2. Host core: 81c4ff79 candidate patch applied as-is (one conflict, package.json, kept both deps); 07433f86 trimmed per index.md: fallback-chain code, CLI flags and tests dropped, AGY/OpenCode tooling flags and doc gate dropped, ContainerConfigRow fields optional, db/container-configs.ts and backfill back to upstream, the 5 migrations registered after upstream's entries (files byte-identical to ed7eccd6, names unchanged).
3. Container: be458963 mnemon (Dockerfile block, shim, queue writer, skill); 7dec8455 python3, nlm, deepline, PATH, gws-account shim, gws CLI pin, container/CLAUDE.md, thread-pinned destinations, A2A session attribute, alwaysLoad + ENABLE_TOOL_SEARCH + turn-usage log, 13 container skills.
4. Scripts: 63e9f1c3 legacy `com.nanoclaw` plist detection + 2 tests, q.ts read-only outbound, rebuild-agent-image (opencode probe removed), smoke-mounts, reviewer-smoke, setup/container.ts await fix, .gitignore, docs. 1be77aae regenerated .github/skill-pins (the check failed on the gws pin).

## Validation
- `pnpm install --frozen-lockfile` ok. package.json +5 lines (ccusage script, @chat-adapter/slack and @chat-adapter/telegram 4.41.1, dashboard link, @onecli-sh/sdk 2.2.1); pnpm-lock +414/-0 (lines added only). agent-runner bun.lock unchanged.
- `pnpm run build` and host tsc clean. Container tsc clean. mailbox-model:generate leaves no diff. slash-command, format, skill-pins checks and the provider-contract verifier all pass.
- `pnpm test`: 366 files (360 pass, 3 fail, 3 skipped). 4990 tests: 4963 pass, 7 fail, 20 skipped. All 7 failures are zsh variants: scripts/add-tavily-tool-upgrade (1), add-vercel-onecli (4), migrate-openclaw-vault (2). They fail the same way when run alone and on a clean f7440e85 tree, so they come from this shell's environment, not from the migration.
- `bun test --isolate` (the package's test script): 699 pass, 3 skip, 0 fail. Plain `bun test`: 1 unhandled error, because rooms.ts extendTool runs twice when files are not isolated.
- Migrations on a read-only `.backup` copy: 28 registered, 28 applied, 0 pending. validate ok, and migrate on a second copy changes nothing.
- `./container/build.sh` ok: nanoclaw-agent-v2-c29297c8:latest (29289cc1). Versions: bun 1.4.4, mnemon 0.1.14, nlm 0.8.7, deepline 0.3.0, gws 0.22.5, codex 0.162.1, claude 2.1.296. The live image tag edb15411 was not touched.

## Deviations
- Skills were applied by hand from their nc: directives (`skill-apply.ts` only prints the plan). External, auth, operator and restart steps were skipped. Slack rooms/canvas bun tests ran locally with --preload instead of in docker.
- Dashboard and mnemon host code came in with the candidate (stage 2), not as a separate skill stage.
- Dropped the optional MarkdownV2 regression test: adapter 4.41.1 sends through sendRichMessage, so the 4.29-era assertions no longer hold. withTelegramMarkdownFallback is present (7 hits).
- Dropped container skill agy-research (it depends on query_agy). The falcone and wiki skill selections now name a missing skill. This is harmless: the composer skips it and only a dangling link is left.
- Not carried (optional): lint-only patch, onecli-files best-effort unlink, touchHeartbeat hooks, typecheck:tools/CI lint, register.ts shim, WhatsApp removal, migration `version:` bumps, slack-auto spinner fix.
- container/build.sh hung on `docker-credential-desktop get` (known credsStore hang). I killed it and rebuilt with a temporary DOCKER_CONFIG in the scratchpad that has no credsStore. ~/.docker was not changed.

## Landing notes
- The lock records the dashboard as `link:../../nanoclaw-dashboard`, which is relative to this worktree. Re-run `pnpm install` in the live checkout so it becomes `link:../nanoclaw-dashboard`.
- Build the image from the live checkout (slug edb15411), then run rebuild-agent-image. The stamp, a DB snapshot and the fleet-idle check are still needed (index.md Risks).
- slack-api skill copied verbatim. Its hostPattern wording is still unconfirmed (10-channels item 10). fork/channels was not refreshed (Path B), so running /update-skills with REGISTRY_REMOTE=fork would overwrite telegram.ts.

## Final state
`git log --oneline f7440e85..HEAD`: the 10 commits above (1be77aae … 14e8ef9c), then ebe6f844 (guide) and this report's commit.
`git diff --stat f7440e85 HEAD | tail -1` (before this report): 308 files changed, 54560 insertions(+), 573 deletions(-).

# 10 - Channels: Telegram and Slack

Scope: `src/channels/{telegram*,slack*}`, `patches/@chat-adapter__telegram@4.29.0.patch`, the Slack host modules
(`slack-agent-flow`, `slack-onboarding`, `slack-room-membership`, `canvas-actions`, `src/provisioning`), the
matching skills and container skills, wiring scripts, and the chat-adapter pins. Decision already made: KEEP all
Telegram and all Slack code.

Refs used (tips at time of writing): `BASE`=64706602, `origin/main`=f7440e85, `origin/channels`=c19e78fe,
`fork/channels`=0d7e4f05 (1 commit ahead of its merge-base 224827b9, 637 commits behind `origin/channels`).
Local `main` was at ed7eccd6.

## TL;DR

1. The only genuinely Brad-specific channel code is small: **Telegram forum-topic threads**, **unlinkable-URL
   code-wrapping**, a few **wiring/ops scripts**, one **container skill** (`slack-api`), and a one-line
   `thread_filter` field in `channel-defaults.ts`. Everything else under Slack/Telegram is a stale stock copy of
   skill payloads and must simply be re-installed from the skills (it will come in newer).
2. The 4.29.0 pnpm patch and `withPlainTextFallback` exist only because the install sat on chat adapters 4.29.0.
   Upstream `origin/main` now pins `chat@4.41.1` and the add-telegram / add-slack skills pin the adapters at
   4.41.1. Drop both (see items 3 and 4).
3. **Do not copy `telegram.ts` from `fork/channels` or from the old main tree.** Both lack upstream's
   `keepCommandsAsMessages` (adapters >= 4.31 route any `/command` to `onSlashCommand`, which the bridge does not
   register, so `/connect_group`, `/start connect`, and agent commands are silently dropped). On 4.29.0 that gap was
   invisible; on 4.41.1 it is a live regression. A ready-made merged `telegram.ts` (upstream + Brad deltas) is in
   the assets directory below.

Ready-made assets (verified: syntax-clean, and both patches `git apply --check` clean against the current
`origin/channels` copies):

- `/private/tmp/claude-501/-Users-bradhess-Documents-GitHub-nanoclaw-v2/ce1a8617-b5a8-46c0-a227-8feed37951d2/scratchpad/guide/10-channels.assets/telegram.ts` - full merged file (origin/channels c19e78fe + forum topics + code-wrap + lint `void`s; keeps `keepCommandsAsMessages`; no plain-text wrapper).
- `.../10-channels.assets/telegram.ts.vs-origin-channels.patch` - same as a patch (`git apply`, cwd = repo root).
- `.../10-channels.assets/lint-fixes.vs-origin-channels.patch` - lint-only fixes for 4 skill-installed files (item 7).

## Applied skills (reapply via skill)

Apply in this order on the clean `origin/main` worktree. Run only each skill's **Apply** section (copy, register,
dep, build/test). Skip every **Credentials** / pairing / restart / operator step: `.env` and `data/v2.db` carry the
bot tokens, pairings, messaging groups and wirings across, and the `env-set` fences are set-if-absent anyway.
`pnpm exec tsx scripts/skill-apply.ts .claude/skills/<name>` prints the plan without writing.

| # | Skill | Installs (all `from-branch:channels` unless noted) | Barrel line it appends | Dep pin |
|---|-------|-----------------------------------------------------|------------------------|---------|
| 1 | `/add-telegram` | `src/channels/telegram.ts`, `telegram-pairing.ts`, and tests `telegram-pairing`, `-registration`, `-connect-group`, `-instances-registration`, `-pairing-interceptor` | `src/channels/index.ts`: `import './telegram.js';` | `@chat-adapter/telegram@4.41.1` |
| 2 | `/add-slack` | `src/channels/slack.ts`, `slack-lib.ts`, `slack-a2a-guard.ts`, `slack-raw-text.ts` (+ their tests, `slack-registration.test.ts`, `slack-instances-registration.test.ts`), `src/provisioning/slack-app.ts` (+test), `container/skills/slack-formatting/SKILL.md` | `src/channels/index.ts`: `import './slack.js';` then `import './slack-a2a-guard.js';` | `@chat-adapter/slack@4.41.1` |
| 3 | `/slack-a2a-rooms` | `src/channels/slack-a2a.ts`, `slack-a2a.test.ts`, `scripts/open-a2a-room.ts` (payload shipped inside the skill dir on main) | `src/channels/index.ts`: `import './slack-a2a.js';` | none |
| 4 | `/slack-agent-flow` | channels branch: `src/env-file.ts`(+test), `src/modules/slack-room-membership/*`, `src/modules/canvas-actions/*`, `src/modules/slack-onboarding/*`, `container/agent-runner/src/mcp-tools/canvas.*`, `container/skills/{slack-construct,canvas-work}/`, `container/skills/welcome/addenda/slack.md`. Skill dir payload: `src/modules/slack-agent-flow/*`, `scripts/slack-agent-flow-finish.ts`, `container/agent-runner/src/mcp-tools/rooms.*`, `create-agent-slack.instructions.md`, `container/skills/slack-construct-agents/`, `container/skills/welcome/addenda/teams-tour.md` | `src/modules/index.ts`: `import './slack-room-membership/index.js';` `import './canvas-actions/index.js';` `import './slack-onboarding/index.js';` then `import './slack-agent-flow/index.js';`. `container/agent-runner/src/mcp-tools/index.ts`: `import './canvas.js';` then `import './rooms.js';` | none |

Notes:

- `chat` is already `4.41.1` in `origin/main` `package.json`; the adapters must match it exactly
  (`scripts/skill-conformance.test.ts` enforces lockstep, `pnpm run skill-pins:check` verifies). Do not carry over
  the local `"chat": "4.29.0"` / `"@chat-adapter/*": "4.29.0"` lines or the `pnpm-workspace.yaml`
  `patchedDependencies` block.
- I checked every trunk seam `/slack-agent-flow` step 2 greps for (startChannelAdapter, registerDeliveryBatchPreview,
  suppressCreatedNotify, createAgentHoldPayload, sender-approval `dedupeKey`/`declineText`/`fyiText`, `extendTool`,
  `registerChannelPreStep`, `instructions.md` compose, `await action.decide`): all present on `origin/main`. The
  skill applies cleanly with no trunk edits.
- `/slack-agent-flow` is only functional with `NANOCLAW_INSTALL_TOKEN` or `SLACK_MANAGER_TOKEN` in `.env` and a
  `slack:U...` owner/admin in `user_roles`. `.env` currently has neither token (it has `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN`, `SLACK_INSTANCES=dm-with-brad`, no `SLACK_A2A_ROOMS`), so the Slack provisioning leg reports
  `no-credentials` today as well. Install it anyway per the KEEP decision; behaviour is unchanged.
- Registry remote: skills resolve `from-branch:channels` through `NANOCLAW_REGISTRY_REMOTE` (else the first remote
  that has the branch). With `NANOCLAW_REGISTRY_REMOTE=fork` every payload above would come from the stale
  `fork/channels`. Either (A, durable) first refresh `fork/channels` as in item 1 "How to apply", or (B) run the
  skills against `origin` and overlay the assets afterwards. With B, a later `/update-skills` will overwrite
  `telegram.ts` unless the fork branch is refreshed.
- Local copies of all of these were never edited by Brad apart from the lint fixes (item 7). Status of every local
  file group vs upstream, so nothing is lost by re-installing:

| Local files | vs `fork/channels` | vs `origin/channels` / `origin/main` skill dir | Brad delta |
|-------------|--------------------|--------------------------------------------------|------------|
| `slack-lib*`, `slack-instances-registration.test`, `telegram-pairing.ts`, `telegram-registration/-connect-group/-instances/-interceptor tests`, `provisioning/slack-app*`, `slack-onboarding/index+onboarding.test`, `slack-room-membership/env-file*,index`, `canvas-actions/{handlers,index,test}`, `slack-agent-flow/{env-file*,guard,provision*,room-canvas*,slack-deps,types}`, `open-a2a-room.ts`, `slack-agent-flow-finish.ts`, `slack-formatting`, `slack-construct`, `welcome/addenda/slack.md` | identical | identical | none |
| `slack.ts` | identical except unused-import removal | upstream is newer (bot-author resolver, `slackRawTextExtractor`) | lint only |
| `slack-a2a-guard*`, `slack-raw-text*`, `slack-registration.test` | identical | upstream newer | none |
| `slack-a2a.ts`, `slack-agent-flow/{index,orchestrate*,room-actions*}`, `slack-construct-agents/SKILL.md` | identical to skill payload | skill payload on `origin/main` is newer | none |
| `slack-room-membership/membership.ts` + `.test.ts` | local is OLDER than fork/channels (installed 2026-08-26, never refreshed) | much newer upstream (cf7697c3 "keep unpaired DMs private", 1300308c) | none - do not port |
| `canvas-actions/canvas-api.ts`, `slack-onboarding/thread-title.test.ts`, `telegram-pairing.test.ts` | identical except lint fixes | identical except lint fixes | lint only |
| `.claude/skills/{add-telegram,add-slack,slack-agent-flow,slack-a2a-rooms,migrate-slack-agents}` | - | local == BASE; `origin/main` is newer | none |

## Customizations

### 1. Telegram forum-topic threads  - REAPPLY
**Intent.** Treat Telegram forum topics as threads so a supergroup with Topics enabled gets one session per
topic (per-client "rooms" such as the Daily Ops supergroup, topic-scoped wirings via `thread_filter`, thread-pinned
destinations). General topic / plain groups / DMs keep today's shared session and top-level replies.
Live use confirms it matters: 27 Telegram sessions, 13 of them threaded; 10 wirings with `thread_filter`; 11
destinations with `thread_id`.

**Files.** `src/channels/telegram.ts` (edits below), new `src/channels/telegram-topics.test.ts` (37 lines),
`scripts/telegram-repoint-room.ts` (item 9). History: fork/channels `0d7e4f05` (same telegram.ts change, but it
predates `keepCommandsAsMessages`), local `051e96f62`.

**Upstream overlap.** None. Upstream `origin/channels` telegram.ts still declares `supportsThreads: false` and group
`threads: false`. The 4.41.1 adapter still encodes a forum topic as `telegram:<chat>:<messageThreadId>` and the
bare chat as `telegram:<chat>` (read from the published 4.41.1 bundle), so the normalization stays valid. Core
`origin/main` bridge exposes `supportsThreads`, `transformOutboundText`, `extractReplyContext`, `maxTextLength`
(checked).

**How to apply.** Preferred: after `/add-telegram`, overwrite with the merged file, then add the two test/helper
files from the old main tree:

```
ASSETS=/private/tmp/claude-501/-Users-bradhess-Documents-GitHub-nanoclaw-v2/ce1a8617-b5a8-46c0-a227-8feed37951d2/scratchpad/guide/10-channels.assets
OLD=/Users/bradhess/Documents/GitHub/nanoclaw-v2          # main @ ed7eccd6
cp $ASSETS/telegram.ts            src/channels/telegram.ts
cp $OLD/src/channels/telegram-topics.test.ts      src/channels/
cp $OLD/src/channels/telegram-unlinkable-urls.ts  src/channels/     # imported by telegram.ts (item 2)
cp $OLD/src/channels/telegram-unlinkable-urls.test.ts src/channels/
# optional, upstream's own test for keepCommandsAsMessages (not in the skill copy list):
git show origin/channels:src/channels/telegram-commands.test.ts > src/channels/telegram-commands.test.ts
```

Equivalent patch form: `git apply $ASSETS/telegram.ts.vs-origin-channels.patch` on the skill-installed
`telegram.ts` (the patch also contains item 2 and the `void` lint edits). If `origin/channels` has moved and the patch
no longer applies, hand-apply these six edits to the upstream file and keep `keepCommandsAsMessages`:

1. Import: `import { codeWrapUnlinkableUrls } from './telegram-unlinkable-urls.js';`
2. `TELEGRAM_DEFAULTS.group`: `threads: false` -> `threads: true`; replace the "non-threaded platform" doc comment
   with the forum-topic one.
3. Add (before `keepCommandsAsMessages`):
   ```ts
   export function normalizeTelegramThreadId(platformId: string, threadId: string | null): string | null {
     if (threadId === null || threadId === platformId) return null;
     return threadId;
   }
   ```
4. In `createTelegramInboundInterceptor`: `return async (platformId, rawThreadId, message) => { const threadId = normalizeTelegramThreadId(platformId, rawThreadId);` (rest unchanged).
5. In `createTelegramBridge`: `supportsThreads: false` -> `supportsThreads: true`.
6. Same call: add `transformOutboundText: codeWrapUnlinkableUrls,` (item 2) and update the comment that said
   "No transformOutboundText".

Verify: `pnpm exec vitest run src/channels/telegram-topics.test.ts src/channels/telegram-registration.test.ts src/channels/telegram-connect-group.test.ts src/channels/telegram-pairing-interceptor.test.ts`, then a live smoke test: post in a forum topic, in General, and in a plain group; confirm `sessions.thread_id` is `telegram:<chat>:<topic>` for the first and NULL for the others, and that the reply lands in the same topic.

**Durable form (Path A).** To make `/update-skills` / `NANOCLAW_REGISTRY_REMOTE=fork` keep this: in a scratch
worktree of `fork/channels`, `git merge origin/channels` (dry run with `git merge-tree` shows exactly one conflict:
`src/channels/telegram.ts`), resolve by taking `$ASSETS/telegram.ts`, also commit `telegram-unlinkable-urls.ts`,
its test and `telegram-topics.test.ts` (note: today's `fork/channels` commit imports `telegram-unlinkable-urls.js`
but never added the file, so that branch alone does not compile), optionally apply the lint patch (item 7), then
fast-forward push to `fork` (never `origin`). That push is a decision for Brad.

### 2. Telegram unlinkable-URL code-wrapping  - REAPPLY (lower value than before)
**Intent.** Telegram rejects an entire MarkdownV2 message when a link entity points at a host it cannot resolve
(loopback, RFC1918, bare hostnames, `.local`): "can't parse entities: Can't find end of a URL". A pasted OneCLI
connect link (`http://127.0.0.1:10254/...`) killed whole replies. `codeWrapUnlinkableUrls` wraps such bare URLs in
inline code before the adapter sees them so the text survives, is copyable, and keeps its formatting.

**Files.** `src/channels/telegram-unlinkable-urls.ts` (43 lines), `telegram-unlinkable-urls.test.ts` (55 lines), wired in
via `transformOutboundText` in `telegram.ts`.

**Upstream overlap.** Partial. `origin/main` / `origin/channels` have no URL wrapping. But the 4.41.1 adapter now
retries a MarkdownV2 parse rejection once as plain text (item 4), so without this the failure degrades from
"message dropped" to "message delivered unformatted, URL not copyable as code". Still worth the 43 lines; it is a
pure function with tests and no dependency on the adapter.

**How to apply.** Copy the two files from the old main tree (commands in item 1); the `transformOutboundText` line
is already in the merged `telegram.ts`.

### 3. MarkdownV2 truncation on underscores in URLs: pnpm patch  - ALREADY-UPSTREAM (patch file OBSOLETE)
**Intent.** `@chat-adapter/telegram` 4.29.0 ran `trimToMarkdownV2SafeBoundary` on every send and counted raw `_`
inside link URLs as italic markers, chopping messages at the last "unpaired" underscore (20 dropped Zed replies,
Oct 16). Commit `d600e298` backported the >= 4.41 scanDelimiters fix as a pnpm patch.

**Files.** `patches/@chat-adapter__telegram@4.29.0.patch` (176 lines), `pnpm-workspace.yaml` `patchedDependencies`
block, `pnpm-lock.yaml` `patchedDependencies`/`patch_hash` entries.

**Upstream overlap.** Fixed in the adapter itself (4.32.0). `origin/main` commit `8281149a` ("bump chat core +
adapters to 4.38.1 for MarkdownV2 link fix", same root cause, found via OneCLI connect links) and `45196175` (4.41.1).
The published 4.41.1 bundle confirms `scanDelimiters` skips `](...)` link targets and the trim only runs when text
exceeds the length limit.

**How to apply.** Do nothing. Do not add `patchedDependencies` to `pnpm-workspace.yaml` and do not copy the patch:
the key `@chat-adapter/telegram@4.29.0` would not match 4.41.1, and pnpm treats an unused patch as an error.
The regression tests that reproduce the two dropped messages live in the plain-fallback test (item 4), which is
being dropped; if you want the regression coverage, keep just the first `describe('Telegram MarkdownV2 delivery of
URLs with underscores')` block from `telegram-plain-fallback.test.ts` as a new `telegram-markdown-urls.test.ts`
(it uses only `createTelegramAdapter` and `TelegramFormatConverter` from the adapter).

### 4. `withPlainTextFallback` (plain-text resend on "can't parse entities")  - ALREADY-UPSTREAM (recommend drop; Brad's call)
**Intent.** Last-resort delivery: if Telegram rejects MarkdownV2 with "can't parse entities", resend the
markdown/ast message once as plain text (also for edits), otherwise the host's retries repeat the same
deterministic rejection and the message is dropped. Raw and card messages rethrow.

**Files.** `src/channels/telegram-plain-fallback.ts` (76 lines) and `.test.ts` (171 lines); wrapped around
`createTelegramAdapter(...)` in `telegram.ts` (main only, not in fork/channels).

**Upstream overlap.** The 4.41.1 adapter has this built in: `withTelegramMarkdownFallback` wraps `sendRegularMessage`
(text posts), the document/attachment/media-group sends and `editRegular` (edits); when `parseMode` is MarkdownV2 and
the error is a telegram `ValidationError` matching `/can't parse (?:caption )?entities/i` it logs a warning and
retries with plain text derived from `markdownToPlainText`. (Evidence: published 4.41.1 `dist/index.js` read via
unpkg; not yet confirmed against a local 4.41.1 install.) Keeping the wrapper would double-retry, and the local test
"rethrows when the plain resend also fails" asserts exactly 2 HTTP calls, which would become 3.

**How to apply.** Drop: do not copy `telegram-plain-fallback.ts/.test.ts`, and the merged `telegram.ts` already has no
wrapper. First confirm after `pnpm install`:
`grep -c withTelegramMarkdownFallback node_modules/@chat-adapter/telegram/dist/index.js` (expect >= 1). If it is 0,
re-add by copying the two files from the old main tree and changing the adapter construction in `telegram.ts` to:
```ts
const telegramAdapter = withPlainTextFallback(createTelegramAdapter({ botToken: token, mode: 'polling' }));
keepCommandsAsMessages(telegramAdapter);
```
(plus `import { withPlainTextFallback } from './telegram-plain-fallback.js';`).

### 5. `telegram-markdown-sanitize.ts` (legacy-Markdown sanitizer)  - OBSOLETE
**Intent.** Pre-4.29 workaround that rewrote `**bold**` etc. for Telegram's legacy `Markdown` parse mode.
**Files.** `src/channels/telegram-markdown-sanitize.ts`, `.test.ts`. No importer anywhere (only its own test and
a stale mention in `.claude/skills/add-telegram/REMOVE.md`); upstream removed it in `8cfd96d1` because it turned bold
into italic. Do not carry over.

### 6. Chat adapter version pins at 4.29.0  - ALREADY-UPSTREAM
**Files.** `package.json`: `chat 4.29.0`, `@chat-adapter/slack 4.29.0`, `@chat-adapter/telegram 4.29.0`.
**Upstream.** `origin/main` pins `chat@4.41.1`; the skills install `@chat-adapter/{telegram,slack}@4.41.1`
(steps `nc:dep`). Let the skills add them (they also update `pnpm-lock.yaml`). The other new local dependencies in
`package.json` (`@nanoco/nanoclaw-dashboard` link, `@onecli-sh/sdk`, `@types/qrcode`, `pino`, `qrcode`) are not channel
dependencies (no `src/channels`, `setup`, or `scripts` importer); they belong to other sections.
After install, re-verify one adapter-shape assumption that is not mine but is Telegram-coupled: see Risks
"delivery-ambiguity".

### 7. Lint-only fixes to skill-installed channel files  - REAPPLY (optional, zero runtime effect)
**Intent.** Commits `e1708d495` and `f44364539` make `pnpm run lint` (`no-floating-promises`, `no-unused-vars`,
`preserve-caught-error`) pass on files that come from the channels branch.

**Files / edits (all still needed against current `origin/channels`; verified each pattern is still present):**
- `src/channels/telegram.ts`: `void` on the four pass-through `hostOnInbound(...)` calls (awaiting would re-route
  twice because the catch block calls it again). Already in the merged asset.
- `src/channels/slack.ts`: drop unused `ChannelContextDefaults` from the `./adapter.js` type import.
- `src/modules/canvas-actions/canvas-api.ts`: `{ cause: err }` on three rethrows (and `catch {` -> `catch (err) {`).
- `src/channels/telegram-pairing.test.ts`: `void` on four timer-driven `tryConsume(...)` calls.
- `src/modules/slack-onboarding/thread-title.test.ts`: `await sessionCreated(...)` at 12 call sites.

**Upstream overlap.** None; the channels branch is not linted by trunk CI.

**How to apply.** `git apply $ASSETS/lint-fixes.vs-origin-channels.patch` (cwd = repo root, run after the skills).
It covers the last four files. Skip entirely if lint is not a gate; re-run `pnpm run lint` after the skills to see
the same set of errors reappear and decide. Note these files are overwritten by every `/update-skills`, so either
fold the patch into `fork/channels` (item 1, Path A) or reapply after each refresh.

### 8. `EngageValues.thread_filter` in `channel-defaults.ts`  - REAPPLY (tied to a core feature)
**Intent.** `validateEngageAgainstChannel(w, mg)` takes an `EngageValues`; `ncl wirings create/update` passes
`thread_filter` through it for topic-scoped wirings.
**Files.** `src/channels/channel-defaults.ts`, +1 line in `interface EngageValues`.
**Upstream overlap.** None (`origin/main` interface still ends at `session_mode`).
**How to apply.** Add `thread_filter?: unknown;` after `session_mode?: unknown;` in `export interface EngageValues`.
Only meaningful together with migration `024-wiring-thread-filter`, router fan-out and `ncl wirings --thread-filter`
(owned by the router/DB sections; see Risks "cross-section").

### 9. Wiring and ops scripts  - REAPPLY (copy)
**Intent.** `wire-dedicated-room.sh`: wire an existing agent group to its own dedicated chat room with the standard
room profile (messaging group `is_group=1`, `unknown_sender_policy=strict`, wiring pattern `.`, `sender_scope=all`,
`ignored_message_policy=drop`, `session_mode=shared`, companion destination, routing note appended to the group's
`CLAUDE.local.md`/`instructions.prepend.md`). `wire-rooms-batch.sh`: wraps it, matching rooms by Telegram chat title
via a map. `telegram-repoint-room.ts`: after enabling Topics a Telegram group becomes a supergroup with a NEW chat
id (`-100...`); this moves the existing `messaging_groups.platform_id` in place so wirings, sessions and
destinations carry over (dry-run by default, `--apply` to write).
**Files.** `scripts/wire-dedicated-room.sh` (182), `scripts/wire-rooms-batch.sh` (105), `scripts/telegram-repoint-room.ts` (79).
**Upstream overlap.** None of the scripts exist upstream. The `ncl` surface they call exists on `origin/main`
(`messaging-groups create/update --is-group --unknown-sender-policy --instance`, `wirings create ...`,
`destinations add/list`); `wirings create` already writes the companion destination upstream and the script checks for
it before adding one, so no double-write.
**How to apply.** `cp` from the old main tree (`$OLD/scripts/...`), keep the executable bit on the two `.sh` files.
`telegram-repoint-room.ts` imports `../src/config.js`, `../src/db/connection.js` and `../src/types.js`: confirm
`CENTRAL_DB_PATH` and `getDb/initDb` still exist after the base switch (it is a one-off tool; run it with
`pnpm exec tsx scripts/telegram-repoint-room.ts` without `--apply` first).

### 10. Container skill `slack-api`  - REAPPLY (copy; has a content question)
**Intent.** Outbound-only Slack Web API access for Zed via OneCLI to Brad's three workspaces (Meadow, Cache,
Miller7), documented with mrkdwn rules for direct `chat.postMessage` calls.
**Files.** `container/skills/slack-api/SKILL.md` (77 lines). Not in any registry branch.
**Upstream overlap.** None (`slack-formatting` is the stock sibling and is referenced from this skill).
**How to apply.** Copy the file. **Flag:** it tells the agent to hit per-workspace subdomains
(`https://<ws>.slack.com/api`, "never `slack.com`"), while the memory note `feedback_slack_vault_hostpattern` says the
vault tokens need `hostPattern=slack.com` (DGG workspace is the Slack Connect host). Confirm against the current
vault before copying verbatim; the skill text may be out of date.

### 11. Slack stack (adapter, lib, guard, raw-text, provisioning, a2a rooms, agent flow, onboarding, room membership, canvas, container skills)  - REAPPLY via skills (no Brad deviation)
**Intent.** Slack channel plus the "agents" experience (create_agent -> own Slack bot, shared rooms, canvases, DM
onboarding, room membership/owner-presence policy). Decision: keep everything.
**Files.** See the table under "Applied skills". Every file is a stale stock copy (see the file-group status table).
**Upstream overlap.** Upstream is strictly ahead; `/add-slack`, `/slack-a2a-rooms`, `/slack-agent-flow` now live in-tree
on `origin/main` as the canonical source, with the runtime payload on `origin/channels`.
**How to apply.** Run the four skills. No snippet edits. Expect behaviour changes you are accepting by taking upstream:
unpaired 1:1 Slack DMs are now declined and kept private (cf7697c3, 1300308c), the bot-inbound guard has a DM-author
bot resolver, and `slack-raw-text` is a hook-based extractor. Barrel ordering is handled by the skills' append
directives (guard before a2a; room-membership/canvas/onboarding before agent-flow).

### 12. `scripts/update-skills.ts` channel-detection fix (Slack-motivated)  - ALREADY-UPSTREAM
**Intent.** Local `isChannelAdapterImport` (+ `providers.delete('mock')`) stopped `update-skills` from demanding a
non-existent `add-slack-a2a-guard` skill for the companion barrel imports.
**Upstream.** `origin/main` solved the same problem with `importOwners()` (barrel imports are attributed to the skill
whose `append to:` directive declares them). Drop the local hack. (Belongs to the scripts section; listed here because
it is Slack-triggered.)

## Risks

**Riskiest, in order:**

1. **`keepCommandsAsMessages` regression (high).** Copying `telegram.ts` from `fork/channels` or the old main tree onto
   4.41.1 silently drops every Telegram `/command` (`/connect_group`, `/start connect`, agent commands). Use the merged
   asset or the upstream file plus the six edits. Cheap guard: copy `src/channels/telegram-commands.test.ts` from
   `origin/channels` and run it.
2. **`fork/channels` is not self-consistent and is 637 commits stale.** Its `telegram.ts` imports
   `./telegram-unlinkable-urls.js`, which exists only in the main tree. With `NANOCLAW_REGISTRY_REMOTE=fork`, every
   `/add-*` and `/update-skills` run would install old Slack/Telegram payloads (including the stale
   `membership.ts` behaviour) and a non-compiling `telegram.ts`. Decide Path A (merge origin/channels into
   fork/channels, one conflict, push to `fork`) vs Path B (use origin, overlay assets).
3. **Forum-topic behaviour on a new base.** The feature rides on `supportsThreads: true` through the upstream
   `chat-sdk-bridge` (which gained DM-thread normalization and agent-mode surfaces since BASE) and on core features
   that are NOT in this section: migration `024-wiring-thread-filter` (commit 29a2560ef, router fan-out,
   `ncl wirings --thread-filter`), migration `025-destination-thread` (commit 36abb253f, `ncl destinations --thread`,
   delivery/poll-loop honoring `thread_id`). Note the local migrations reuse versions 24 and 25 next to upstream's
   `024-host-coordination` and `025-container-config-speed`; whoever owns the DB section must renumber/sequence them
   or the live DB (10 `thread_filter` wirings, 11 pinned destinations) will not load. The Telegram part alone is safe,
   but the Daily Ops topic routing breaks if those are missed. Smoke test after assembly (item 1).
4. **`delivery-ambiguity.ts` is tied to 4.29.0 adapter error shapes (medium).** It treats an adapter `NetworkError`
   as ambiguous when it carries `originalError` or its message matches `/failed to parse/` or `/returned no result/`
   (the 4.29.0 strings "Failed to parse Telegram API response for ..." and "... returned no result"). The 4.41.1 bundle
   has at least one new `NetworkError` wording ("Telegram postMessage did not return any sent messages"). A mismatch
   would turn "message may have landed" into a retry, i.e. duplicate Telegram replies. After install, grep
   `node_modules/@chat-adapter/telegram/dist/index.js` for `originalError`, `returned no result`, `Failed to parse` and
   adjust the delivery section's patterns. (Owner: delivery section; flagged here because the adapter bump causes it.)
5. **Adapter jump 4.29.0 -> 4.41.1 across 12 minors.** Beyond the items above, unverified: Slack mrkdwn/markdown_text
   rendering, Telegram streaming/draft behaviour, `createTelegramAdapter` option defaults. Mitigation: run the focused
   channel tests and a live DM + group + topic smoke test per bot before restarting launchd.
6. **Dead-by-design but live data.** `messaging_groups` has 2 rows with `channel_type='telegram-opencode'` (retired Q
   group); `.env` still has `TELEGRAM_BOT_TOKEN_OPENCODE` but no `TELEGRAM_INSTANCES`. Upstream's instance model keys
   by `instance`, not by a distinct channel type, so those rows stay orphaned (as today). Nothing to port; do not
   re-enable.
7. **`/slack-agent-flow` is dormant without credentials** (no `NANOCLAW_INSTALL_TOKEN`/`SLACK_MANAGER_TOKEN` in `.env`).
   Installed and registered, but `create_agent` from Slack reports `no-credentials`. Same as current behaviour.
8. **Cross-section coupling to Slack module names.** `src/project-doc-compose.ts` (token-spend plan) hard-codes
   `SLACK_ONLY_MODULES = {'canvas','rooms','create-agent-slack'}` to omit those instruction fragments for groups with
   no Slack wiring. They must keep matching the fragment names shipped by `/slack-agent-flow`
   (`canvas.instructions.md`, `rooms.instructions.md`, `create-agent-slack.instructions.md`). `origin/main` already
   composes `instructions.md`; this is a Brad-local optimization to re-apply in that section.
9. **Setup wizard spinner fix touches Slack setup.** `setup/channels/slack-auto.ts` locally replaces
   `s.stop(msg, 1)` with `s.error(msg)` (commit 66bf85ae6, "failed spinners render as failures again"); `origin/main`
   still has `s.stop(..., 1)`. It is a setup-section item; no runtime effect on the running host.
10. **Lint patch drift.** `lint-fixes.vs-origin-channels.patch` and `telegram.ts.vs-origin-channels.patch` are exact
    against `origin/channels` c19e78fe; a newer channels tip may need hand-applying (edits are enumerated above).

**Needs Brad's call:**
- Drop `withPlainTextFallback` (item 4)? Recommended yes, conditional on the one-line grep check after install.
- Keep `codeWrapUnlinkableUrls` (item 2)? Recommended yes.
- Path A (refresh and push `fork/channels`) or Path B (overlay only)?
- Lint-only patches (item 7): apply or skip?
- `slack-api` skill hostPattern wording vs the vault's actual `hostPattern` (item 10).

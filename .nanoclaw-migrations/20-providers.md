# 20 - Agent providers (Codex, fallback chain, AGY-as-tool, OneCLI provider bits)

Scope: `src/providers/**`, `container/agent-runner/src/providers/**`, `src/provider-contracts/**`, `setup/providers/**`, `src/gateway-providers/**`, provider scripts, provider skills, provider-related `container_configs` columns.
BASE = 64706602. Read-only analysis of `main` (225 ahead) vs `origin/main` (161 ahead of BASE). Live DB inspected read-only (`sqlite3 -readonly data/v2.db`), OneCLI vault inspected read-only (names/types/metadata only, no values).

Headline findings (all verified in the tree, not assumed):

1. Local Codex is NOT a customization. `main`'s Codex files are byte-identical to upstream's new `/add-codex` payload except a legacy archive fallback that upstream replaced. Rebuild = run upstream's skill.
2. The provider fallback chain is half-built and currently DEAD in `main`: the runner dispatch (`buildProvider` in `container/agent-runner/src/index.ts`) was lost in the 2026-08-25 merge (`a84a23351` / `46a1d6218`); `index.ts` calls `createProvider()` directly. It also never worked end-to-end even when wired (see `docs/superpowers/2026-07-17-provider-fallback-rollout-findings.md`), and upstream's new contract seam adds more breakage. Reapply needs real work, not a copy.
3. AGY-as-tool (`query_agy`) is also DEAD in `main`: the barrel imports in `mcp-tools/index.ts` and the `enableAgyTooling` mount layering in the container-runner were both lost in the same merges. `dm-with-brad` (Zed) has `enable_agy_tooling=1` but no running container mounts agy.
4. OneCLI: upstream pin is now 1.45.0 = live gateway 1.45.0, so the local "never downgrade" guard is obsolete. Nothing else local in `src/gateway-providers` matters except two tiny test/robustness edits.

---

## Applied skills

State in `main` (what was applied and how it relates to the rebuild):

| Skill | Applied in main | Rebuild action |
|---|---|---|
| add-codex | `94c31cdb0` 2026-07-17 from providers branch; refreshed 8/25, 9/23 (`26e845048`). Skill dir in main is stale (3 payload files, base version). | RE-RUN upstream's `/add-codex` (payload now ships the whole runtime: a46db607, 2594b86a, 4ce9cbe0, 6b4cd21a, 3eb10930). Pin `@openai/codex` 0.162.1. Skip the Authenticate step (vault already has the `Codex` openai/oauth secret, see Risks). |
| add-onecli | selected gateway, materialized `22415d21d`; `NANOCLAW_GATEWAY_PROVIDER` is set in `.env` | RE-RUN upstream's `/add-onecli` FIRST (it ships the ChatGPT workspace-id stand-in that Codex >= 0.156 needs: `onecli-chatgpt-stub.ts`, `onecli-provider-credentials.ts`; upstream SKILL.md says refresh both together). Upstream pin 1.45.0 equals the running gateway; setup "reuses any healthy gateway" so it must NOT reinstall. |
| add-opencode | applied (files in tree) | DROP BY DECISION. Do not re-run. |
| add-agy | applied from `fork/providers` (`fork/providers` = `origin/providers` + agy payload only; verified by diff stat) | DROP the provider. Keep only the tool pieces (see AGY section). Do not run the skill. |
| add-cursor | not applied (new upstream skill) | Out of scope; no decision made. |

Re-apply order: add-onecli, add-codex, then local pieces below (DB layer, container-config, fallback, AGY tool, claude.ts tweaks, reviewer-smoke).

Install mechanics for add-codex (from upstream SKILL.md): copy `payload/**` into the three trees, append `import './codex.js';` to 5 barrels (`src/providers/index.ts`, `src/provider-contracts/index.ts`, `container/agent-runner/src/provider-contracts/index.ts`, `container/agent-runner/src/providers/index.ts`, `setup/providers/index.ts`), json-merge `{ "name": "@openai/codex", "version": "0.162.1" }` into `container/cli-tools.json`, `pnpm run build`, `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, `./container/build.sh`. Equivalent one-shot: `pnpm exec tsx setup/index.ts --step provider-auth codex` (includes auth; prefer the manual steps to avoid re-auth).

---

## Customizations

Verdict table:

| # | Customization | Verdict |
|---|---|---|
| 1 | Codex provider (container + host + setup + contracts) | ALREADY-UPSTREAM (via skill payload); local legacy archive fallback OBSOLETE |
| 2 | Provider fallback chain (FallbackProvider, host chain resolution, CLI flags, columns) | REAPPLY WITH ADAPTATIONS (keep, drop opencode, fix 6 integration bugs) |
| 3 | AGY/Gemini as a callable tool (`query_agy`, `agy-research`, `enable_agy_tooling`) | REAPPLY (repair 3 broken links) |
| 4 | DB columns + migrations (`provider-tooling`, `provider-chain`) | REAPPLY (names are load-bearing) |
| 5 | claude.ts token-spend tweaks (tool search, usage log) | REAPPLY (partial; one line ALREADY-UPSTREAM) |
| 6 | container-config.ts extras (`NANOCLAW_DEFAULT_EFFORT`) | REAPPLY (cross-ref perf agent) |
| 7 | reviewer-smoke scripts | REAPPLY (copy) |
| 8 | OneCLI: gateway-version guard + doc edits + pin | OBSOLETE |
| 9 | OneCLI: onecli-files best-effort unlink; onecli.test env isolation | REAPPLY (optional, tiny) |
| 10 | OneCLI: 1.45 grants, argv secrets, ChatGPT stub, Dial fixes | ALREADY-UPSTREAM |
| 11 | Misc type/barrel oddities (`mock.js` import, duplicate `file` event) | OBSOLETE |

### 1. Codex provider

Intent: Codex (`gpt-5.6-*`) as a full agent provider for 4 groups. Live config (DB, untouched by rebuild): builder-1 `gpt-5.6-sol` effort high; reviewer-1 `gpt-5.6-terra` high; wiki `gpt-5.6-luna` medium; repo-librarian `gpt-5.6-luna` medium (all `container_configs.provider='codex'`; `agent_groups.agent_provider` is the legacy dashboard-only column, wiki shows `claude` there - ignore).

Files (main, all installed copies of the old payload): `src/providers/codex.ts`, `codex-agents-md.ts`(+tests), `src/provider-contracts/codex.ts`, `setup/providers/codex.ts`(+tests), `container/agent-runner/src/providers/codex.ts`, `codex-app-server.ts`(+tests), `container/agent-runner/src/provider-contracts/codex.ts`.

Upstream overlap: ALREADY-UPSTREAM. Measured line-diff of every main Codex file vs `origin/main:.claude/skills/add-codex/payload/**`: 0 for 12 of 16 files. The only differences:
- `container/agent-runner/src/providers/codex.ts`: main has an `onExchangeComplete` that calls the local `./exchange-archive.js` (legacy archive). Upstream moved archiving to core's shared `provider-contracts/exchange-archive.ts` via the contract `afterExchange` (2594b86a). OBSOLETE.
- `container/agent-runner/src/provider-contracts/codex.ts`: imports `../providers/exchange-archive.js` vs upstream `./exchange-archive.js`. OBSOLETE.
- `codex-contract-parity.test.ts`: upstream adds a test for the shared archive. Take upstream.
- `setup/providers/codex.ts` / `.test.ts`: comment wording, version string `0.155.1` -> `0.162.1`. Take upstream.
No local Codex behavior fix exists outside these files. The host-side auth fixes from Aug (a1813d65b, 058dd356d, 056d44d9c, "isolate writable auth refresh state / serialize auth stub / duplicate mount targets") touched `src/container-runner.ts`; those were superseded by the v2.4.0 provider-surfaces seam (no `codex` string remains in `main`'s container-runner) and `src/container-runner-codex-auth.test.ts` no longer exists. The 2026-07-17 "Codex bugs" (`materializeTemplateSkills` ENOENT, `.codex-shared` mount) are fixed in the current host `codex.ts`, which is identical to upstream's payload.

How to apply: run upstream add-codex steps (see Applied skills). Then verify with `git diff --stat origin/main` that the only non-skill changes in these files are none. Rebuild the agent image (`./container/build.sh`; Codex CLI 0.155.1 -> 0.162.1; the old `opencode-ai` and `@googleworkspace/cli` entries in `container/cli-tools.json` are separate decisions - drop opencode-ai, keep gws). Per-agent images: re-run `scripts/rebuild-agent-image.ts` if any group uses one (agent-runner `package.json` changes).

### 2. Provider fallback chain (claude -> codex, opencode removed)

Intent: when the primary provider returns a non-retryable quota/auth/billing error (shared Claude OAuth subscription hits its plan limit and every group 429s), the runner continues the turn on the next provider; sticky with 30-min cooldown re-probe; recap injected on switch. Spec: `docs/superpowers/specs/2026-07-17-provider-fallback-chain-design.md`; plan `.../plans/2026-07-17-provider-fallback-chain.md`; blockers `docs/superpowers/2026-07-17-provider-fallback-rollout-findings.md` (carry all three docs; the findings doc is the important one).

Files in `main` (copy-from-main-tree unless noted):
- Runner: `container/agent-runner/src/providers/{fallback.ts(172), fallback-state.ts(31), error-classification.ts(34), build-provider.ts(17)}` + tests `fallback.test.ts`, `fallback-state.test.ts`, `fallback.factory.test.ts`, `error-classification.test.ts`; `container/agent-runner/src/config.ts` (+`providerChain?: string[]`, `providerChainCooldownMinutes?: number` and two `runnerConfigFromRaw` lines; the `transcriptRotate*` fields in the same hunk belong to the perf agent).
- Host: `src/container-config.ts` (`resolveProviderChain`, `DEFAULT_PROVIDER_CHAIN`, `ContainerConfig.providerChain`, `configFromDb` line), `src/db/container-configs.ts` (columns in `SCALAR_COLUMNS`/`JSON_COLUMNS`, `updateContainerConfig({providerChain})`), `src/types.ts` (`ContainerConfigRow.provider_chain`), `src/cli/resources/groups.ts` (`--provider-chain <p1,p2>`, `--no-fallback`, mutually exclusive; 143-line diff is mostly the secret-redaction work owned by the CLI agent - take only the chain hunks), tests `src/container-config.provider-chain.test.ts`, `src/db/container-configs.provider-chain.test.ts`, `src/cli/resources/groups.test.ts` lines ~585-660.
- DB: migration `021-provider-chain.ts` (section 4).

Upstream overlap: none (`git grep` for FallbackProvider/providerChain/provider_chain on origin/main: 0 hits). Upstream's closest thing is the contract seam which this feature must now integrate with.

Current live state: DB `provider_chain` is set on atoz-am `["claude","codex","opencode"]`, meetings `["claude","codex","opencode"]`, repo-librarian `["claude", "codex", "opencode"]` (codex-primary, so it resolves to codex,claude,opencode). All other groups NULL, which `resolveProviderChain` expands to the default `claude,codex,opencode` in container.json (e.g. `groups/dm-with-brad/container.json`). Because dispatch is dead, no group has fallen back since 2026-08-25. atoz-am and meetings hold both Anthropic and Codex OneCLI grants (checked); no group holds `OPENCODE_GO`.

How to apply - mandatory adaptations (this is not a straight copy; each item is a verified defect against upstream's seam or a pre-existing gap):

a. Wire dispatch in `container/agent-runner/src/index.ts` (upstream file has `import { createProvider } from './providers/factory.js'` and registers the memory hook via the seam):
```ts
import { buildProvider } from './providers/build-provider.js';
import { FallbackProvider } from './providers/fallback.js';
// ...
const provider = buildProvider(config, providerName, { assistantName: ..., mcpServers, env: { ...process.env }, additionalDirectories: ..., model: config.model, effort: config.effort, speed: config.speed });
if (provider instanceof FallbackProvider) provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);   // composite registers each child itself
else registerProviderMemorySessionHook(providerName, provider, MEMORY_SESSION_HOOK);
```
`buildProvider` must take the validated `providerName` (upstream uses `requireProviderName(config.provider)`), build children ONLY through `createProvider` (so each child is contract-bound), and for non-primary links pass `{ ...options, model: undefined, effort: undefined, speed: undefined }`. Reason: main passes the same options to every child, so Codex would be handed `claude-opus-5-5` as its model.

b. Memory hook per child via the seam. Upstream `registerProviderMemorySessionHook(name, provider, hook)` (`provider-contracts/realize.ts`) sets `inputs.memory` and resolves the per-provider `memory` capability. The current `FallbackProvider.registerMemorySessionHook(hook)` calls `child.registerMemorySessionHook(hook)` directly, so (i) Codex's contract `beforeQuery` throws "Codex provider requires a registered memory hook before query" (the composite then logs "skipping unavailable provider" and the codex link never runs) and (ii) a Claude child would lose `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (upstream applies it via the `memory` arg, not the constructor). Fix: store `name -> child`, and in `child()`/`registerMemorySessionHook` call `registerProviderMemorySessionHook(name, c, hook)` from `../provider-contracts/realize.js`.

c. `isSessionInvalid` must delegate to the active child (`this.children.get(this.activeName)?.isSessionInvalid(err) ?? false`). Today it returns false, so a stale Claude session id inside the composite token is never cleared by the poll loop and every turn fails.

d. `onExchangeComplete` must also forward to the active child. Today it only feeds the recap buffer, so Codex's contract `afterExchange` (conversation archive, installed by `createProvider` on the child instance) never fires for exchanges served by a fallback Codex.

e. `error-classification.ts`: for `result` events read `event.error` as well as `event.text` (`classifyMessage(\`${event.error ?? ''}\n${event.text ?? ''}\`)`). Upstream's new `claude.ts` (SDK_NOTICES) returns `text: null` and puts "Not logged in / Invalid API key / Credit balance is too low" in `error`, so the current classifier would never trigger on them. Add a test case.

f. Host must spawn containers with the union of chain members' host contributions (finding #1 of the rollout doc; never built). Rename the upstream `resolveProviderContribution` body to a private helper and wrap it in `src/container-runner.ts`:
```ts
export async function resolveProviderContribution(session, agentGroup, containerConfig) {
  const primary = await resolvePrimaryProviderContribution(session, agentGroup, containerConfig); // upstream body, unchanged
  const ctx = { sessionDir: sessionDir(agentGroup.id, session.id), agentGroupId: agentGroup.id,
    groupDir: path.resolve(GROUPS_DIR, agentGroup.folder), selectedSkills: selectedSkillNames(containerConfig), hostEnv: process.env };
  const extra: ProviderContainerContribution[] = [];
  const names = [ ...(containerConfig.providerChain ?? []).slice(1), ...(containerConfig.enableAgyTooling ? ['agy'] : []) ]
    .filter((n) => n !== primary.provider);
  for (const name of new Set(names)) {
    const fn = getProviderContainerConfig(name);
    if (!fn) { log.warn('chain/tooling provider has no host config', { name, agentGroupId: agentGroup.id }); continue; }
    try { extra.push(await fn(ctx)); } catch (err) { log.warn('secondary provider contribution failed; spawning without it', { name, err }); }
  }
  if (extra.length === 0) return primary;
  return { ...primary, contribution: mergeContributions(primary.contribution, extra) }; // mounts: concat, dedupe by containerPath, primary first; env: primary wins
}
```
Do NOT pass `coreOwnsProviderSurfaces` to the secondary fn: upstream `src/providers/codex.ts` returns `{}` when it is set, and the legacy path is what mounts `.codex-shared` -> `/home/node/.codex` (RW), `AGENTS.md`, `.agents`. This is new, untested code; also unverified: whether OneCLI's container config serves the ChatGPT `auth.json` stub into a claude-primary container whose agent holds the Codex grant (it should, since stubs are per granted secret, but test it). Claude as a SECONDARY in a codex-primary group (repo-librarian) lacks `/home/node/.claude`, composed CLAUDE.md and skill links (codex `providesAgentSurfaces` skips them) - recommend `--no-fallback` for repo-librarian instead of supporting that direction.

g. Default must become opt-in. `DEFAULT_PROVIDER_CHAIN = ['claude','codex','opencode']` makes every Claude group (19 of them) fall back to Codex once dispatch is live, but most lack a Codex grant (upstream 1.45 grants give new groups only their model credential), so the fallback would 401 and surface Codex's error instead of Claude's. Change `resolveProviderChain` to return `[primary]` when no explicit chain is stored, strip `opencode` defensively, keep "explicit chain forces chain[0]=primary":
```ts
export function resolveProviderChain(provider: string | undefined, json: string | null): string[] {
  const primary = provider ?? 'claude';
  let chain: string[] = [];
  if (json) { try { const p: unknown = JSON.parse(json); if (Array.isArray(p) && p.every((e) => typeof e === 'string')) chain = p.filter((e) => e !== 'opencode'); } catch { chain = []; } }
  if (chain.length === 0) return [primary];
  return chain[0] === primary ? chain : [primary, ...chain.filter((e) => e !== primary)];
}
```
Update `container-config.provider-chain.test.ts` ("claude with no override -> [claude]", drop opencode cases) and `fallback.test.ts` (opencode used as the "unregistered link" fixture - rename to e.g. `'ghost'`).

h. Known limits to document, not fix: the poll loop takes `textDelivery`/command formatting from the PRIMARY's contract (claude: `mid-turn-complete`/native; codex: `result`/xml), so a Claude->Codex switch delivers text under Claude's semantics; `FallbackProvider` is not created through `createProvider`, so `bindProviderRuntimeInputs` has no entry for the composite (harmless, children are bound individually).

Data/config: after rebuild run (via `ncl`, approval-gated, or host stopped + SQL) `UPDATE container_configs SET provider_chain='["claude","codex"]' WHERE agent_group_id IN ('ag-d876b255-db5a-400c-adc4-06021b87d49d','ag-94d7c242-f6a5-4dfa-8b38-93041aeb7822');` (atoz-am, meetings) and `NULL` or `["codex"]` for repo-librarian `ag-f737e5de-8c41-4ab2-838a-06612e7468cf`. The defensive opencode filter makes this non-urgent. Validate on atoz-am with a forced failure before trusting it. Cheaper alternative if the above is too much: the findings doc's "Path A" (same-provider credential fallback inside claude: subscription OAuth -> Anthropic API key already in the vault), which avoids all host-contribution work.

Effort: M-L (runner 0.5 day incl. tests; host union 0.5 day; live validation separate).

### 3. AGY/Gemini as a callable tool (provider dropped)

Intent: let a Claude/Codex group delegate bulk drafting / big-context reads to Gemini via `agy -p` without switching the group's provider.

What already exists in `main` (and works as code):
- `container/agent-runner/src/mcp-tools/query-agy.ts` (165 lines): registers MCP tool `query_agy({prompt, timeoutMs?})`; spawns `agy -p <prompt> --dangerously-skip-permissions --print-timeout <s> --add-dir <unique cwd>` (cwd under `/workspace/agent/.agy-subquery/<id>`), returns trimmed stdout, 15-min default / 30-min ceiling, structured errors. Single-shot, no conversation reuse. Depends only on `./server.js` and `./types.js` - NOT on `agy.ts`/`mcp-to-agy.ts` (those are provider-only and are dropped).
- `query-agy.instructions.md` (36 lines, composed into the group's project doc) and `query-agy.test.ts`.
- `container/skills/agy-research/SKILL.md`: approval-gated research recipe that calls `query_agy` and files the result. It is listed in the `skills` selection of `falcone` and `wiki` and covered by `"all"` for Zed; if the directory is removed those selections dangle, so keep it.
- Host mounts: `src/providers/agy.ts` registers `registerProviderContainerConfig('agy', ...)` returning mounts `~/.local/bin/antigravity-linux-arm64|amd64` (host has the arm64 binary) -> `/usr/local/bin/agy` RO and `~/.gemini` -> `/home/node/.gemini` RW, env `AGY_BIN`, `AGY_CLI_DATA_DIR`, `AGY_MCP_CONFIG_PATH`, `AGY_LAST_CONVS_PATH`.
- Flag: `container_configs.enable_agy_tooling` (migration `provider-tooling`), `ContainerConfig.enableAgyTooling`, doc gating `TOOLING_GATED_MODULES` in `src/project-doc-compose.ts`. Live: only `dm-with-brad` = 1.

What is broken in `main` today (all three must be repaired):
1. `container/agent-runner/src/mcp-tools/index.ts` no longer has `import './query-agy.js';` (dropped in the 8/25 merge; `registration.test.ts` would fail). Re-add after `./self-mod.js`.
2. `src/container-runner.ts` no longer layers the agy contribution for `enableAgyTooling` (it did at `2aab2907a`: "Layer agy tooling enabler"). The v2.4.0 rewrite of `resolveProviderContribution` lost it. Covered by the wrapper in 2.f (it handles `agy` when `enableAgyTooling`).
3. `src/providers/index.ts` host barrel must still `import './agy.js'` (the file stays; only its role changes). Update its header comment to say it is a tooling mount provider; there is no `agy` container provider any more, so `provider: 'agy'` must never be set (no group does).

Minimal carry list: `query-agy.ts`, `query-agy.instructions.md`, `query-agy.test.ts`, `container/skills/agy-research/SKILL.md`, `src/providers/agy.ts` (unchanged), barrel line, migration `provider-tooling`, `enable_agy_tooling` in `types.ts`/`db/container-configs.ts`, `enableAgyTooling` in `container-config.ts`, the 2.f wrapper, and this gate in `project-doc-compose.ts` (inside the module loop, next to the `cliDisabled` check):
```ts
const TOOLING_GATED_MODULES: Record<string, 'agy'> = { 'query-agy': 'agy' };
// in the loop:
if (TOOLING_GATED_MODULES[moduleName] === 'agy' && configRow?.enable_agy_tooling !== 1) continue;
```
(plus the `query-agy` assertions at `src/project-doc-compose.test.ts` ~464-516; drop the opencode ones). Gating matters for Codex groups: the composed AGENTS.md is capped at 32 KB (`CODEX_PROJECT_DOC_MAX_BYTES`), reviewer-1 was 28.8 KB; the 2 KB agy doc must not land in Codex groups.

Optional hardening: (a) register the tool only when the binary is mounted (`fs.existsSync('/usr/local/bin/agy')`) so groups without tooling do not see a dead tool in their MCP list; note `agyBinExists('agy')` returns true for non-absolute names, so the current "not enabled" message never fires, a missing binary shows up as `failed to spawn agy`. (b) Security: the RW `~/.gemini` mount puts Google OAuth state (`google_accounts.json`, antigravity-cli token) inside the container, which contradicts the vault-only credential rule; it is only on Zed. If that is unacceptable, use Option B.

Option B (no binary, no OAuth in container): a ~60-line `query_gemini` MCP tool that POSTs to `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` through the OneCLI proxy. The vault already has `GEMINI_API_KEY` (hostPattern `generativelanguage.googleapis.com`), but it is configured as `Authorization: Bearer {value}`; Gemini API keys normally need `x-goog-api-key`, so it would need `onecli secrets update` with `--header-name x-goog-api-key --value-format '{value}'` and a grant to the groups (verify with `secrets list`; `secrets create` drops those flags, per memory). Unverified end-to-end; Option A reuses working code.

Effort: S for Option A (3 repairs + tests), S-M for Option B.

### 4. DB columns and migrations

Live schema facts (`schema_version`, name-keyed): `18 provider-tooling`, `19 provider-chain`, `27 container-config-speed`, `28 agent-group-architecture`. Columns on `container_configs`: `enable_agy_tooling INTEGER NOT NULL DEFAULT 0`, `enable_opencode_tooling INTEGER NOT NULL DEFAULT 0`, `provider_chain TEXT` (JSON array or NULL). `speed` is upstream (`025-container-config-speed`) and is NULL on every row. Data that depends on the schema: `provider_chain` on 3 rows, `enable_agy_tooling=1` on dm-with-brad.

Runner is keyed on migration `name` (`SELECT name FROM schema_version`; unknown applied names are ignored; `version` is only an ordering hint; duplicate version numbers are already tolerated, e.g. two "20"s in main).

How to apply:
- Copy `src/db/migrations/020-provider-tooling.ts` and `021-provider-chain.ts` verbatim (names `'provider-tooling'`, `'provider-chain'`; both `async`/portable, so they pass `portability.test.ts`). Import with aliases as in main and APPEND after upstream's last entry in the `migrations` array (do not touch the `migration019` anchors that `portability.test.ts` checks). Do NOT rename them and do not renumber: a new name re-runs `ALTER TABLE ... ADD COLUMN` on the live DB and fails with "duplicate column name", crash-looping the host at `initDb`.
- Keep `enable_opencode_tooling` inside the `provider-tooling` migration (changing the migration body is harmless to the live DB, but then a fresh DB differs from live; simplest is leave the file untouched). Never `DROP COLUMN` it; no code reads it after the drop.
- Make the new row fields OPTIONAL in `ContainerConfigRow` (`enable_agy_tooling?: number; provider_chain?: string | null;`) so upstream test fixtures that build a `ContainerConfigRow` still typecheck. Do not add the columns to `createContainerConfig`'s INSERT list (the defaults apply; main's `backfill-container-configs.ts` edit is unnecessary). Do add `'enable_agy_tooling'` and `'provider_chain'` to `SCALAR_COLUMNS` (and `'provider_chain'` to `JSON_COLUMNS`, as main has) so `updateContainerConfigScalars` accepts them.
- Verified no upstream migration/table recreate touches `container_configs` columns, so the extra columns survive upstream updates. Other local migrations (`wiring-thread-filter`, `destination-thread`, `agent-group-architecture`) belong to other sections but follow the same name rule.

### 5. claude.ts token-spend tweaks

Diff vs BASE (`container/agent-runner/src/providers/claude.ts`, commit `3bb929168`, perf plan Phase 1; spec `docs/superpowers/specs/2026-09-08-performance-and-token-spend-scope.md` §8):
- `ENABLE_TOOL_SEARCH` env (default `'true'`, override via host env) into `this.env` in the constructor; paired with `alwaysLoad?: boolean` on `McpServerConfig` in `providers/types.ts` and `alwaysLoad: true` on the built-in `nanoclaw` MCP server in `index.ts`. REAPPLY. `shimCwd` preserves extra fields via spread, so `alwaysLoad` flows through the contract's `resolveClaudeMcpServers`.
- Per-turn `Turn usage: in= out= cache_read= cache_write= turns= cost_usd=` log line on the `result` message. REAPPLY (no in-repo consumer found; read from container logs). Upstream's new `result` branch (SDK_NOTICES) replaces the same lines, so apply on top of it.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'` in the constructor env: ALREADY-UPSTREAM via the contract (`resolveClaudeMemoryRuntime` handed to `registerMemorySessionHook(hook, memory)`). Do not re-add (but see 2.b: the composite must register children through the seam or this is lost).
- `touchHeartbeat()` in the pre/post tool-use hooks: likely redundant (upstream poll-loop touches the heartbeat on activity events; upstream has `claude.liveness.test.ts`). OPTIONAL; verify with a long Bash tool before adding.
- Duplicate `{ type: 'file'; path: string }` member in `ProviderEvent` and the `import './mock.js'` line in `providers/index.ts`: OBSOLETE (upstream already has the `file` event and Codex's `generated_images` path uses it; tests import the mock explicitly - `fallback.factory.test.ts` already does).
Cross-reference: `alwaysLoad` / tool search is owned by the perf agent; coordinate so it is applied once.

### 6. container-config.ts extras

`DEFAULT_EFFORT` (`NANOCLAW_DEFAULT_EFFORT`, set to `medium` in `.env`) from `src/config.ts`, `ContainerConfigDefaults` and `row.model || defaults.model` (empty string treated as unset, upstream uses `??`). Every live row already has an explicit effort, so this is a convenience for new groups. REAPPLY if the perf agent keeps it; otherwise `ncl groups config update --effort` per group suffices. The `isSecretQueryKey` / `redactMcpServerSecrets` / `warnSecretShapedEnv` hunks in the same file are the CLI/secret-redaction agent's.

### 7. reviewer-smoke

Intent: live smoke check for reviewer-1 (Codex adversarial reviewer): sends a golden fixture as a one-shot task via `pnpm run -s ncl tasks create/run`, polls the per-task session's outbound DB, scores the reply against `reviewer-golden-expected.json`.
Files (copy from main, self-contained; depends on `DATA_DIR` from `src/config.ts`, `better-sqlite3`, and the upstream `ncl` script): `scripts/reviewer-smoke.ts`, `scripts/reviewer-smoke.test.ts`, `scripts/fixtures/reviewer-golden-case.md`, `scripts/fixtures/reviewer-golden-expected.json`. Upstream overlap: none. Hard-coded `GROUP_ID = 'ag-1779729652625-n3m1xl'` matches reviewer-1 in the live DB (verified). Related docs: `docs/superpowers/2026-08-01-reviewer-1-reliability-findings.md`, `specs/2026-07-30-codex-adversarial-review-design.md`, `plans/2026-08-01-codex-adversarial-review.md` (copy if docs are kept).

### 8. OneCLI: gateway-version guard, doc edits, pins

Intent (commit `09a458d1d`): the add-onecli pin was deliberately 1.41.0 (< live 1.45.0) and a fresh `setup.ts` run could have reinstalled the older gateway; `gateway-version.ts` kept a newer `ONECLI_VERSION` from `~/.onecli/.env`, the local `onecli-upgrades.md` edits added "never downgrade / 1.43.1 floor for ChatGPT OAuth", `versions.json` cli pin 2.2.5 -> 2.11.0, a comment in `provider-credentials.ts`.
Upstream overlap: OBSOLETE. `origin/main` `versions.json` is `onecli-gateway 1.45.0, onecli-cli 2.11.0, onecli-sdk 2.2.1`, and `~/.onecli/.env` has `ONECLI_VERSION=1.45.0`: the pin is no longer behind live, so the guard is a no-op and the doc edits are superseded by upstream's own (much longer) upgrade guide. Drop `scripts/gateway-version.ts(+test)`, the `setup.ts` hook, the `onecli-upgrades.md` edits, the `provider-credentials.ts` comment. If upstream later pins above live, the correct behavior is the upstream upgrade guide, not a guard.

### 9. OneCLI: tiny robustness/test edits (optional)

- `onecli-files.ts` `stageOnecliFile` `finally`: unlink of the temp file made best-effort (a throw there masked the publish result / in-flight error) + a test. Upstream still has the strict `ENOENT`-only rethrow. REAPPLY optionally: edit the PAYLOAD copy under `.claude/skills/add-onecli/payload/src/gateway-providers/onecli-files.ts` (+`.test.ts`) AND the installed copy `src/gateway-providers/onecli-files.ts`, or the next `/add-onecli` refresh will overwrite it. Snippet: replace the `catch (error) { if (code !== 'ENOENT') throw error; }` with `catch { /* best effort */ }`.
- `onecli.test.ts`: `vi.hoisted(() => { for (const k of ['ONECLI_URL','ONECLI_API_KEY','ONECLI_GATEWAY_CONTAINER','ANTHROPIC_BASE_URL','ONECLI_CONSOLE_URL']) vi.stubEnv(k, undefined) })` + `afterAll(() => vi.unstubAllEnvs())`, because `onecli.ts` prefers `process.env` over `.env` and a Claude Code shell exports `ANTHROPIC_BASE_URL` (commit `f8a66f1c4`). Upstream's test (707-line rewrite) has no such isolation. REAPPLY only if tests are run from a Claude Code shell; otherwise `env -u ANTHROPIC_BASE_URL pnpm test`.

### 10. OneCLI items already covered upstream (no action)

- OneCLI 1.45 grants; new groups get only their model credential (`047457247` / #4094): in upstream `onecli.ts` (`grantProviderCredentials`). Consequence: any group that needs a second provider (fallback) needs an explicit grant (Brad-only, classifier-blocked).
- No secrets on argv + failed-command redaction (`68458298` / #4187): upstream add-onecli scripts (`secret-input.ts`, `credential-store.ts`, `auth.ts`). Local host-side `ncl` argv/log redaction (`1cfe0648`, `53395ecb0`, `55c071b8f`) is the CLI agent's.
- ChatGPT stand-in workspace id (`6b4cd21a`, #4133): `onecli-chatgpt-stub.ts`, `onecli-provider-credentials.ts`. Verified the vault `Codex` openai secret already carries `metadata.accountId` + `authMode: oauth`, so Codex >= 0.156 will find its workspace id.
- Dial fixes, check-grants/post-upgrade/pre-upgrade scripts, `ONECLI_GATEWAY_CONTAINER`: upstream.
- `ONECLI_API_KEY` / Caddy shim on :10254 / `onecli-egress-fwd`: infrastructure outside the repo (containers `onecli`, `onecli-shim`, `onecli-egress-fwd` running). Code side is upstream: `new OneCLI({ url, apiKey })` and Bearer headers. Post-rebuild check: `.env` still has `ONECLI_URL` and `ONECLI_API_KEY`, and the host `onecli` CLI needs `ONECLI_API_KEY` in its env (a few upstream shell helpers, e.g. `dial-key-check.sh`, `pre-upgrade-check.sh`, do not send the key and would 401 through the shim - only matters when running upgrade checks).

---

## Drops

Remove / do not re-add (all verified present in `main`):

OpenCode - container: `providers/opencode.ts`, `opencode-auth(.test).ts`, `opencode-config.ts`, `opencode-memory.ts`, `opencode-turn.ts`, `mcp-to-opencode(.test).ts`, `opencode-registration.test.ts`, `opencode.{attachments,compaction,config,conformance,empty-resume,factory,memory,native,question,shared-runtime,sse-cleanup}.test.ts`, `provider-contracts/opencode.ts`, `mcp-tools/query-opencode.{ts,instructions.md,test.ts}`; host: `src/providers/opencode.ts`, `opencode-auth-stub.ts`, `opencode-registration.test.ts`, `src/provider-contracts/opencode.ts`, `src/opencode-cli-tools.test.ts`, `setup/providers/opencode(.test).ts`; scripts: `scripts/opencode-{auth,auth-config.test,auth.test,gateway.test,host,host.test,model-config,models,models.test,vault,vault.test}.ts`, `scripts/tsconfig.opencode-auth.json`; barrels: remove `opencode` lines from the 5 provider/contract barrels and `mcp-tools/index.ts`; `registration.test.ts` list entry `query-opencode`; `project-doc-compose.ts` opencode gate and tests; `container_configs.enable_opencode_tooling` usage in `container-config.ts`/`types.ts`/`db/container-configs.ts`/`backfill-container-configs.ts`/`cli`/`groups.test.ts`/`db-v2.test.ts`; `container/cli-tools.json` entry `opencode-ai` 1.18.25; `container/agent-runner/package.json` `@opencode-ai/sdk` 1.18.25 (then `cd container/agent-runner && bun install` to refresh `bun.lock`; keep the unrelated `cron-parser` dependency and take upstream's `@anthropic-ai/claude-agent-sdk ^0.3.296` over main's `^0.3.280`). Skill dir `.claude/skills/add-opencode` is upstream's; just never run it.

AGY provider (keep the tool pieces from section 3): `container/agent-runner/src/providers/agy.ts`, `agy.factory.test.ts`, `mcp-to-agy.ts`, `mcp-to-agy.test.ts`, `import './agy.js'` in the container providers barrel, `.claude/skills/add-agy/` (SKILL.md, refresh-compat.mjs). `src/ccusage.ts` reads `~/.gemini/antigravity-cli` host-side for usage reporting and keeps working.

Fallback/legacy: local `container/agent-runner/src/providers/exchange-archive.ts(+test)` (replaced by core's shared `provider-contracts/exchange-archive.ts`; used only by Codex-legacy/opencode/agy), `import './mock.js'` in the providers barrel, `.claude/skills/add-onecli/scripts/gateway-version*`.

DB / config / disk cleanup (do after the rebuild is verified; items marked B are Brad-only because the permission classifier blocks them for Claude):
- DB: `provider_chain` values containing `"opencode"` (atoz-am, meetings, repo-librarian) -> `["claude","codex"]` / NULL as in 2.g. Leave `enable_opencode_tooling` column and both schema_version rows in place. Do not drop columns.
- `.env`: remove `OPENCODE_PROVIDER`, `OPENCODE_MODEL`, `OPENCODE_SMALL_MODEL`, `OPENCODE_BASE_URL` (lines 9-12). Nothing in the rebuilt tree reads them.
- OneCLI (B): vault secret `OPENCODE_GO` (opencode.ai/zen/*) and the orphan OneCLI agent `OpenCode` (`ag-1778790057983-opncde`) are unused; `OPENROUTER` and `GEMINI_API_KEY` secrets may be reused (Option B), decide separately. Group `Q (opencode)` is already retired (`.retired/2026-10-13-opencode`).
- Disk: `~/.config/opencode/` on the host (antigravity-accounts.json, bun.lock); leftover `groups/falcone/.agy-subquery` and `groups/dm-with-brad/.agy-subquery` scratch dirs (safe to leave; retire to `_attic` if tidied, never `rm`).
- Docs: `docs/superpowers` opencode/fallback docs can stay as history; optionally mark them superseded.

---

## Risks

1. DB schema (highest). Migrations are name-keyed. The two provider migrations MUST be registered under the exact names `provider-tooling` and `provider-chain` or the live DB hits "duplicate column name" at `initDb` and the host crash-loops (same failure class as the Node-ABI crash loop in memory). The extra columns (`enable_agy_tooling`, `enable_opencode_tooling`, `provider_chain`) are NOT NULL DEFAULT 0 / nullable, so upstream INSERTs that omit them are fine; there is no upstream migration that recreates `container_configs`. Existing data that depends on them: `provider_chain` (3 rows), `enable_agy_tooling=1` (dm-with-brad). Snapshot `data/v2.db` before the first start of the rebuilt host (existing `data/v2.db.bak-*` convention).
2. Fallback is a feature that has never run in production. Six adaptations in 2.a-2.f are required before it can work; shipping the old files as-is gives silent no-ops (Codex child fails its `beforeQuery`, wrong model passed to Codex, classifier misses the new Claude notices, stale sessions never cleared). If scope must shrink, ship nothing for the chain (leave `provider_chain` column + CLI flag inert) rather than ship it half-wired.
3. Default-on chain would affect 19 Claude groups the moment dispatch is re-wired, mostly without Codex grants. Keep the opt-in default (2.g).
4. `query_agy` has been silently dead since 8/25 (barrel + mount layering). After reapply, confirm in a live Zed session: tool listed, `docker inspect` shows `/usr/local/bin/agy` + `/home/node/.gemini`, one tiny `query_agy` call returns. The RW `~/.gemini` mount exposes Google OAuth material to the container (Zed only today).
5. Codex upgrade jump 0.155.1 -> 0.162.1: image rebuild required; Codex >= 0.156 needs the workspace-id stand-in, so add-onecli must be refreshed in the same rebuild (upstream says so). Vault secret already has `accountId` (verified), so no re-auth should be needed; do not run the skill's Authenticate step blindly. `data/v2-sessions/<group>/.codex-shared` (config.toml, thread metadata) persists across the upgrade and `config.toml` is rewritten every query by the contract `beforeQuery`.
6. Codex `AGENTS.md` 32 KB cap (`CODEX_PROJECT_DOC_MAX_BYTES`): reviewer-1 was 28.8 KB; composed doc size depends on the project-doc/perf agent's slimming (Slack-only module gating, tooling gating). Check `groups/{reviewer-1,builder-1,wiki,repo-librarian}/AGENTS.md` size after the first spawn on the rebuilt tree; keep `query-agy` gated off Codex groups.
7. OneCLI: pin == live (1.45.0). `/add-onecli` setup must reuse the healthy gateway; verify `~/.onecli/.env` `ONECLI_VERSION` is unchanged after the run. Gateway/Caddy shim/egress forwarder are outside git and must not be touched. A restart of Docker can strand `onecli-shim` (memory: stale port forward) - unrelated to the rebuild but shows up as "agents mute".
8. Live-tree safety: `/app/src` is bind-mounted into running containers from the working tree; do all of the above in a separate worktree and land with ff + stamp + build + kickstart (memory: skipping `scripts/upgrade-state.ts set` crash-loops the host). `CHANGELOG`/stamping is another section's job, but the provider barrels and migrations list are the conflict hot spots with other agents (`migrations/index.ts`, `providers/index.ts`, `mcp-tools/index.ts`, `container-config.ts`, `project-doc-compose.ts`, `groups.ts`, `container-runner.ts`).
9. Test debt on reapply: `registration.test.ts` currently fails in `main` (expects barrel imports that are gone); `fallback.test.ts` and `container-config.provider-chain.test.ts` need opencode removed; `db-v2.test.ts`/`groups.test.ts` fixtures reference `enable_*`; the agent-runner tests use `bun:test` (`cd container/agent-runner && bun test`), host tests use vitest.
10. Cursor: upstream's new `/add-cursor` is not part of this plan; if wanted later it is independent of everything above.

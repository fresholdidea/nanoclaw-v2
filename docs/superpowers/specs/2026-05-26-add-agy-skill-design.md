# `/add-agy` Installation Skill — Design

**Status:** Design
**Date:** 2026-05-26
**Author:** Brad (via brainstorm with Claude Code)

## Goal

Productize the agy (Google Antigravity) provider install as a single-command skill, mirroring the `/add-opencode` pattern. The skill takes a user from "agy not installed" to "Cache (or any chosen group) is responding through agy" with one slash command.

## Why

The current install requires: manually downloading the Linux binary, hand-editing `groups/<folder>/container.json`, running a bespoke `auth-login.sh` from `scripts/spike/`, rebuilding the host, and remembering to propagate the new provider files into per-group `agent-runner-src` overlays. A future install on a fresh clone — or by anyone else — would replay the smoke-test debugging that this skill removes from the critical path.

## Non-goals

- **Multi-arch automation.** The skill detects arch (arm64 vs amd64) and downloads the right tarball; it does not maintain a cross-arch cache or build a fat binary.
- **Automated upgrade path.** Bumping agy versions is `rm ~/.local/bin/antigravity-linux-arm64 && /add-agy` — manual and deliberate, matching the pinned-CLI pattern in `/add-opencode`.
- **OAuth token refresh inside the skill.** Agy's CLI manages its own token refresh from the file at `~/.gemini/antigravity-cli/antigravity-oauth-token`. The skill checks for presence only; it does not validate or refresh.
- **Channel wiring or messaging-group setup.** Out of scope. /add-agy switches an existing group's provider; messaging-group binding is `ncl wirings` work.
- **Cleanup of the spike folder.** Spike scripts and `findings.md` stay as historical decision record; only the auth-login script moves.

## Context

The agy provider was added in PR #1 on `fork`, merged into `local/main` on 2026-05-26. The provider is functional end-to-end (smoke-tested against Cache via Telegram). Current install state requires manual steps because the smoke test was a one-off; this skill productizes those steps.

### Existing artifacts that inform the design

- `.claude/skills/add-opencode/SKILL.md` — the template pattern (source-from-providers-branch, append barrels, propagate per-group overlays, build, verify).
- `scripts/spike/agy/auth-login.sh` — the interactive Docker auth flow that runs `agy auth login` inside the nanoclaw agent image, persisting the OAuth token to the mounted `~/.gemini/antigravity-cli/`.
- `scripts/spike/agy/findings.md` — full record of issues found during the smoke test, including the four root causes the skill must avoid re-introducing.
- `src/providers/agy.ts` — current `resolveAgyBin` candidates include the spike path. To be cleaned up.

## Architecture

Two artifacts ship as part of this work:

1. **`.claude/skills/add-agy/SKILL.md`** — user-runnable skill on trunk (`local/main`). Same shape as `/add-opencode`. Idempotent: re-runs are safe, missing pieces are surfaced and patched.
2. **`providers` branch additions on `fork`** — one-time push of the 5 agy provider source files so the skill can `git show fork/providers:<path>` them on a fresh clone. Files involved:
   - `src/providers/agy.ts`
   - `container/agent-runner/src/providers/agy.ts`
   - `container/agent-runner/src/providers/mcp-to-agy.ts`
   - `container/agent-runner/src/providers/mcp-to-agy.test.ts`
   - `container/agent-runner/src/providers/agy.factory.test.ts`

Two key divergences from `/add-opencode`:

- **Binary install instead of Dockerfile npm install.** `/add-opencode` adds `opencode-ai@<pinned>` to the global pnpm install in `container/Dockerfile`. agy ships as a standalone Go binary distributed via Google's GCS bucket, not as an npm package. `/add-agy` downloads `cli_linux_arm64.tar.gz` (or `_amd64`) from `storage.googleapis.com/antigravity-public/`, verifies the sha512 against the manifest at `antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<arch>.json`, extracts the `antigravity` binary, and installs to `~/.local/bin/antigravity-linux-<arch>`. No image rebuild needed for this step; the host container-config bind-mounts the binary at spawn time.
- **Out-of-band OAuth dance instead of OneCLI proxy injection.** OpenCode auth is OneCLI-managed: keys land in OneCLI, get injected via `HTTPS_PROXY`. Agy's CLI insists on its own file-based OAuth token (detected as "container environment", per `token_storage.go`) and provides no API-key shortcut path. The skill therefore runs `agy auth login` in a one-off interactive Docker container with `~/.gemini` mounted, persisting the resulting token file to the host. The user completes OAuth in their normal browser; the token then becomes visible to every agy-backed agent container that mounts `~/.gemini`.

## Skill flow

The agent reading SKILL.md walks the user through these steps in order, skipping any whose precondition is already met.

### 1. Pre-flight scan

Check and report:

| Check | Skip step if true |
|---|---|
| `src/providers/agy.ts` exists | step 2 (code sync) |
| `container/agent-runner/src/providers/agy.ts` exists | step 2 |
| `container/agent-runner/src/providers/mcp-to-agy.ts` exists | step 2 |
| `import './agy.js';` in `src/providers/index.ts` | step 3a |
| `import './agy.js';` in `container/agent-runner/src/providers/index.ts` | step 3b |
| Linux binary at `~/.local/bin/antigravity-linux-<arch>` is executable | step 4 |
| OAuth token at `~/.gemini/antigravity-cli/antigravity-oauth-token` exists | step 7 |

Print a summary so the user sees what will happen.

### 2. Code sync from `fork/providers`

```bash
git fetch fork providers
git show fork/providers:src/providers/agy.ts > src/providers/agy.ts
git show fork/providers:container/agent-runner/src/providers/agy.ts > container/agent-runner/src/providers/agy.ts
git show fork/providers:container/agent-runner/src/providers/mcp-to-agy.ts > container/agent-runner/src/providers/mcp-to-agy.ts
git show fork/providers:container/agent-runner/src/providers/mcp-to-agy.test.ts > container/agent-runner/src/providers/mcp-to-agy.test.ts
git show fork/providers:container/agent-runner/src/providers/agy.factory.test.ts > container/agent-runner/src/providers/agy.factory.test.ts
```

Same rule as `/add-opencode`: these files are owned by the skill. Hand edits don't survive a re-run; that's the contract.

### 3. Append barrel imports

Skip if the line is already present.

`src/providers/index.ts`:

```ts
import './agy.js';
```

`container/agent-runner/src/providers/index.ts`:

```ts
import './agy.js';
```

The container barrel uses the dynamic `loadProvider('agy')` pattern; the host barrel uses a plain `import`.

### 4. Binary install

```bash
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) AGY_ARCH=arm64 ;;
  x86_64|amd64)  AGY_ARCH=amd64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac

MANIFEST_URL="https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_${AGY_ARCH}.json"
DL_URL=$(curl -fsSL "$MANIFEST_URL" | jq -r '.downloadUrl // .url // .download_url')
EXPECTED_SHA=$(curl -fsSL "$MANIFEST_URL" | jq -r '.sha512 // .checksum')

TMP=$(mktemp -d)
curl -fsSL "$DL_URL" -o "$TMP/cli.tar.gz"
ACTUAL_SHA=$(shasum -a 512 "$TMP/cli.tar.gz" | awk '{print $1}')
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || { echo "sha512 mismatch"; exit 1; }

tar -xzf "$TMP/cli.tar.gz" -C "$TMP"
mkdir -p "$HOME/.local/bin"
mv "$TMP/antigravity" "$HOME/.local/bin/antigravity-linux-${AGY_ARCH}"
chmod +x "$HOME/.local/bin/antigravity-linux-${AGY_ARCH}"
```

Manifest field names (`downloadUrl`/`url`/`sha512`/`checksum`) — exact names verified empirically during install. SKILL.md instructs the agent to print the manifest JSON if `jq` extraction fails so the user (or agent) can correct the field name.

### 5. Per-group overlay propagation

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/agy.ts "$overlay"
  cp container/agent-runner/src/providers/mcp-to-agy.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

Same gotcha as `/add-opencode` step 7. Live overlays under `data/v2-sessions/*/agent-runner-src/` override the image at runtime; existing groups need the new files pushed in manually.

### 6. Build

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

Same build-cache gotcha as `/add-opencode` — note it in SKILL.md (`docker builder prune -f && ./container/build.sh` if the rebuild misses the new files).

### 7. Auth-login dance

Skip if `~/.gemini/antigravity-cli/antigravity-oauth-token` exists.

Otherwise, print the exact command for the user to run in their own terminal (the OAuth flow needs a browser + interactive paste-back, which can't be driven from the skill's bash):

```bash
bash scripts/agy/auth-login.sh
```

The script (moved from `scripts/spike/agy/auth-login.sh`) launches a one-shot interactive Docker container that mounts `~/.gemini` r/w, runs `agy auth login`, and exits when the user completes OAuth. The token persists to `~/.gemini/antigravity-cli/antigravity-oauth-token` on the host.

After the user confirms, the skill re-checks the token file:

```bash
test -f ~/.gemini/antigravity-cli/antigravity-oauth-token \
  && echo "auth token present" \
  || { echo "auth token still missing — please re-run auth-login"; exit 1; }
```

### 8. Optional group flip

List groups, prompt the user to choose one (or skip):

```bash
ncl groups list  # display current groups
# Prompt: "Which group should run on agy? Type a folder name, or 'skip' to leave all on claude."
```

If user picks a group:

```bash
GROUP=<chosen-folder>
GROUP_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups WHERE folder='$GROUP'")
jq '. + {provider: "agy"}' groups/$GROUP/container.json > /tmp/c.json && mv /tmp/c.json groups/$GROUP/container.json
ncl groups restart --id "$GROUP_ID"
```

If user types "skip", emit a one-liner reminder of how to flip a group later:

```
To flip any group later: edit groups/<folder>/container.json to add "provider": "agy", then run `ncl groups restart --id <group-id>`.
```

### 9. Verify

```bash
grep -q "./agy.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./agy.js" src/providers/index.ts && echo "host barrel: OK"
ARCH=$(uname -m); case "$ARCH" in arm64|aarch64) A=arm64;; *) A=amd64;; esac
test -x "$HOME/.local/bin/antigravity-linux-${A}" && echo "binary: OK"
test -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" && echo "auth token: OK"
cd container/agent-runner && bun test src/providers/ && cd -
```

## Bundled cleanup (in scope, in same skill commit)

- **Move** `scripts/spike/agy/auth-login.sh` → `scripts/agy/auth-login.sh`. Update the path reference in `scripts/spike/agy/findings.md` (it currently mentions the spike path).
- **Clean `src/providers/agy.ts`** `DEFAULT_AGY_LINUX_BIN_CANDIDATES`:
  - Drop `scripts/spike/agy/cache/antigravity` (spike path — bad permanent home, and the spike cache is gitignored).
  - Keep `~/.local/bin/antigravity-linux-arm64` and `~/.local/bin/antigravity-linux-amd64` as the canonical defaults (replace the legacy `agy-linux-arm64` name with `antigravity-linux-arm64` — matches what `/add-agy` installs).
- **Leave** `scripts/spike/agy/{00-binary-check.sh, 01-print-stream.sh, 02-conversation-id.sh, findings.md, cache/.gitignore}` in place as historical decision record.

## Sibling prep (one-time, before `/add-agy` is runnable on fresh clones)

This must happen before the skill works for anyone re-running it on a clean checkout. Outside the skill itself; a manual one-time task. Uses `git worktree` so the main working tree never switches branches mid-operation.

```bash
# From local/main with the agy files present
git fetch fork providers
git worktree add /tmp/providers-tree fork/providers

# Copy the 5 files from local/main into the providers worktree
for f in \
  src/providers/agy.ts \
  container/agent-runner/src/providers/agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.test.ts \
  container/agent-runner/src/providers/agy.factory.test.ts; do
  mkdir -p "/tmp/providers-tree/$(dirname "$f")"
  cp "$f" "/tmp/providers-tree/$f"
done

cd /tmp/providers-tree
git add \
  src/providers/agy.ts \
  container/agent-runner/src/providers/agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.test.ts \
  container/agent-runner/src/providers/agy.factory.test.ts
git commit -m "providers(agy): add agy provider files for /add-agy skill"
git push fork HEAD:providers
cd -

git worktree remove /tmp/providers-tree
```

The implementation plan covers exact steps and verification.

## Success criteria

A fresh-clone install (no prior agy state on the machine other than a Google account) must:

1. `/add-agy` walks the user through code copy + binary download + sha512 verify + auth-login + (optional) one group flip, with clear status output at each step.
2. After completion, sending a message to the flipped group elicits an agy-generated response (cost on Google AI Pro).
3. Re-running `/add-agy` on the same install is a no-op (pre-flight detects every step is satisfied).
4. Removing the binary OR the token file and re-running `/add-agy` only repeats the missing step(s). Removing a barrel import re-appends it. Removing one of the 5 source files re-copies it.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Manifest URL or JSON field names change | Medium | Step 4 SKILL.md instructs the agent to print the manifest JSON if `jq` extraction returns empty, so the user/agent can pick the right field. Pinned URLs documented in `scripts/spike/agy/findings.md` for reference. |
| User runs auth-login but token doesn't land where expected | Medium | Skill re-checks for the file and fails loudly if missing. Most likely cause: container ran as wrong UID, file owned by root. Script already passes `--user $(id -u):$(id -g)`. |
| `fork/providers` doesn't exist or is missing the 5 files | High (blocks fresh install) | One-time sibling prep step above. Documented as a precondition in SKILL.md. |
| User runs `/add-agy` against `origin/providers` instead of `fork/providers` | Low | SKILL.md hard-codes `fork` in the `git fetch` / `git show` commands. |
| Per-group overlay propagation misses a new group spawned after install | Medium | Inherent to the overlay pattern; affects /add-opencode the same way. Same remediation: re-run the loop manually, or re-run `/add-agy` (idempotent). |

## Decision record

- **Code source: match /add-opencode pattern** (decided 2026-05-26). Portable + idempotent + future-fresh-clone friendly. One-time push to `fork/providers` required.
- **Binary location: `~/.local/bin/antigravity-linux-<arch>`** (decided 2026-05-26). Persistent across repo clones, overridable with `AGY_LINUX_BIN` env, follows xdg-ish convention.
- **Auth flow: out-of-band script invoked by user** (decided in design). Skill detects token absence and prints the exact command. Interactive Docker can't be driven from inside another agent's bash.
- **Group flip: included as optional final step** (decided 2026-05-26). Proves install end-to-end; differs from /add-opencode's "configuration is separate" pattern because agy has higher first-use friction (binary + OAuth) and benefits from a working endpoint as proof.

## Out of scope, deferred to follow-ups

- The two `result.text` known issues from the smoke test (narration leak, conv-id 30s window) are agy provider bugs, not install-skill bugs. Tracked in `scripts/spike/agy/findings.md`.
- A `query_agy` MCP tool (cross-provider sub-query) is the second skill in the ranked list — separate spec.
- An `/agy-research` recipe skill is the third — separate spec.

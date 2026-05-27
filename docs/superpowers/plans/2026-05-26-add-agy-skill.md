# /add-agy Installation Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the agy (Google Antigravity) provider install as `/add-agy` — a single-command skill mirroring `/add-opencode`, including a one-time push of the 5 agy provider files to `fork/providers` so the skill is portable to fresh clones.

**Architecture:** Three artifacts shipped on `local/main`: (1) a one-time sync of the 5 agy provider files from local/main → fork/providers via `git worktree`, (2) bundled cleanup that moves `scripts/spike/agy/auth-login.sh` to `scripts/agy/` and cleans the candidate-paths array in `src/providers/agy.ts`, (3) the `.claude/skills/add-agy/SKILL.md` skill itself — markdown instructions the agent follows interactively.

**Tech Stack:** bash, git worktrees, jq, sha512sum, Docker (for one-off interactive auth container), existing NanoClaw infra (`ncl`, `pnpm exec tsx scripts/q.ts`, `./container/build.sh`).

**Spec:** `docs/superpowers/specs/2026-05-26-add-agy-skill-design.md` (commit `7203394`).

---

## File Structure

### Created on `local/main`

| Path | Purpose |
|---|---|
| `.claude/skills/add-agy/SKILL.md` | The skill itself. Markdown instructions the agent walks the user through. Idempotent. |
| `scripts/agy/auth-login.sh` | Moved from `scripts/spike/agy/auth-login.sh`. Permanent home for the interactive OAuth helper. |

### Modified on `local/main`

| Path | Change |
|---|---|
| `src/providers/agy.ts` | `DEFAULT_AGY_LINUX_BIN_CANDIDATES` cleanup: drop spike path, rename `agy-linux-arm64` → `antigravity-linux-arm64`, add `_amd64` variant. |
| `scripts/spike/agy/findings.md` | Update the one path reference to the moved auth-login script. |

### Created on `fork/providers` (via worktree, one-time)

| Path | Source |
|---|---|
| `src/providers/agy.ts` | Copy from local/main |
| `container/agent-runner/src/providers/agy.ts` | Copy from local/main |
| `container/agent-runner/src/providers/mcp-to-agy.ts` | Copy from local/main |
| `container/agent-runner/src/providers/mcp-to-agy.test.ts` | Copy from local/main |
| `container/agent-runner/src/providers/agy.factory.test.ts` | Copy from local/main |

---

## Tasks

---

### Task 1: Bundled cleanup — move auth-login script and update reference

**Files:**
- Move: `scripts/spike/agy/auth-login.sh` → `scripts/agy/auth-login.sh`
- Modify: `scripts/spike/agy/findings.md` (update the one path reference)

- [ ] **Step 1: Move the script with git**

```bash
mkdir -p scripts/agy
git mv scripts/spike/agy/auth-login.sh scripts/agy/auth-login.sh
```

- [ ] **Step 2: Update the path reference in findings.md**

The findings file references the old path in the issue resolution section. Update it.

```bash
sed -i.bak 's|scripts/spike/agy/auth-login\.sh|scripts/agy/auth-login.sh|g' scripts/spike/agy/findings.md
rm -f scripts/spike/agy/findings.md.bak
```

- [ ] **Step 3: Verify the script still works (sanity check)**

```bash
bash scripts/agy/auth-login.sh --help 2>&1 | head -5 || true
test -x scripts/agy/auth-login.sh && echo "executable OK"
grep -c "scripts/spike/agy/auth-login" scripts/spike/agy/findings.md
```

Expected: `executable OK`, and the grep count is `0` (no stale references).

- [ ] **Step 4: Commit**

```bash
git add scripts/agy/auth-login.sh scripts/spike/agy/findings.md
# git mv handles the deletion of the old path
git commit -m "chore(agy): move auth-login.sh out of spike folder

scripts/spike/agy/auth-login.sh is needed by the productized /add-agy
skill — moving to scripts/agy/ as the permanent home. Updated the
one path reference in findings.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Bundled cleanup — clean `DEFAULT_AGY_LINUX_BIN_CANDIDATES` in src/providers/agy.ts

**Files:**
- Modify: `src/providers/agy.ts:24-28` (the `DEFAULT_AGY_LINUX_BIN_CANDIDATES` array and surrounding comment)

The current array references the spike cache path as the FIRST candidate and uses two legacy names. After this change:
- Spike path is removed (the spike binary stays in `scripts/spike/agy/cache/` as historical artifact but is no longer the canonical default).
- Both arch variants are named consistently as `antigravity-linux-<arch>`.

- [ ] **Step 1: Read the file to confirm exact current text**

```bash
sed -n '24,32p' src/providers/agy.ts
```

Expected output (confirming what we're editing):

```ts
// Candidate paths for the Linux agy binary, in priority order.
// The binary inside the tarball is named `antigravity`, not `agy`.
// Override with AGY_LINUX_BIN env if you keep it elsewhere.
const DEFAULT_AGY_LINUX_BIN_CANDIDATES = [
  path.join(process.cwd(), 'scripts/spike/agy/cache/antigravity'),
  path.join(os.homedir(), '.local/bin/antigravity-linux-arm64'),
  path.join(os.homedir(), '.local/bin/agy-linux-arm64'),
];
```

- [ ] **Step 2: Edit the array**

Replace those three lines (the array body) with the new canonical list:

```ts
// Candidate paths for the Linux agy binary, in priority order.
// The binary inside the tarball is named `antigravity`, not `agy`.
// `/add-agy` installs to `antigravity-linux-<arch>`. Override via AGY_LINUX_BIN.
const DEFAULT_AGY_LINUX_BIN_CANDIDATES = [
  path.join(os.homedir(), '.local/bin/antigravity-linux-arm64'),
  path.join(os.homedir(), '.local/bin/antigravity-linux-amd64'),
];
```

Use the Edit tool with `old_string` being the comment + array body (lines 24-30 inclusive) and `new_string` being the new comment + array body.

- [ ] **Step 3: Typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: clean (no errors).

- [ ] **Step 4: Run host tests touching providers (must still pass)**

```bash
pnpm test -- src/providers 2>&1 | tail -5
```

Expected: pass count unchanged from baseline (no failing tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/agy.ts
git commit -m "refactor(agy): clean DEFAULT_AGY_LINUX_BIN_CANDIDATES

Drop the spike path (scripts/spike/agy/cache/antigravity) from the
fallback list — it was a temporary location during the spike, and
the /add-agy skill now installs to ~/.local/bin/antigravity-linux-<arch>.
Renamed the legacy 'agy-linux-arm64' fallback to match what the skill
writes ('antigravity-linux-arm64'), and added the amd64 variant for
non-Apple-Silicon hosts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Sibling prep — push 5 agy provider files to fork/providers

**Files (in the fork/providers worktree, NOT in local/main):**
- Create: `src/providers/agy.ts`
- Create: `container/agent-runner/src/providers/agy.ts`
- Create: `container/agent-runner/src/providers/mcp-to-agy.ts`
- Create: `container/agent-runner/src/providers/mcp-to-agy.test.ts`
- Create: `container/agent-runner/src/providers/agy.factory.test.ts`

Uses `git worktree` so the main checkout never switches off `local/main`.

> **Note for the executor:** This task pushes to `fork` remote. The user (Brad) has explicitly authorized `fork` pushes (see `feedback_never_push_origin` memory). Do NOT under any circumstances push to `origin` here.

- [ ] **Step 1: Fetch the latest providers branch**

```bash
git fetch fork providers
```

Expected: either `* branch providers -> FETCH_HEAD` (updated) or no output (already up-to-date).

- [ ] **Step 2: Create the worktree**

```bash
git worktree add /tmp/providers-tree fork/providers
```

Expected: `Preparing worktree (detached HEAD at <sha>)` then file checkout.

- [ ] **Step 3: Copy the 5 files into the worktree**

```bash
for f in \
  src/providers/agy.ts \
  container/agent-runner/src/providers/agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.test.ts \
  container/agent-runner/src/providers/agy.factory.test.ts; do
  mkdir -p "/tmp/providers-tree/$(dirname "$f")"
  cp "$f" "/tmp/providers-tree/$f"
done
```

- [ ] **Step 4: Verify the files landed correctly**

```bash
for f in \
  src/providers/agy.ts \
  container/agent-runner/src/providers/agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.test.ts \
  container/agent-runner/src/providers/agy.factory.test.ts; do
  if diff -q "$f" "/tmp/providers-tree/$f" >/dev/null; then
    echo "OK: $f"
  else
    echo "MISMATCH: $f"; exit 1
  fi
done
```

Expected: 5 lines of `OK:`.

- [ ] **Step 5: Commit in the worktree (creates a new commit on the providers branch tip)**

```bash
cd /tmp/providers-tree
git add \
  src/providers/agy.ts \
  container/agent-runner/src/providers/agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.ts \
  container/agent-runner/src/providers/mcp-to-agy.test.ts \
  container/agent-runner/src/providers/agy.factory.test.ts
git -c user.name="Brad Hess" -c user.email="bradhess@usecache.com" commit -m "providers(agy): add agy provider files for /add-agy skill

Adds the 5 source files needed by .claude/skills/add-agy/SKILL.md
to install the agy (Google Antigravity) provider on fresh clones.
Sourced verbatim from local/main commit on 2026-05-26.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
cd -
```

> **Why explicit user.name/email:** the worktree may not inherit the per-repo config; setting these explicitly ensures the commit attribution matches.

- [ ] **Step 6: Push to fork/providers**

```bash
cd /tmp/providers-tree
git push fork HEAD:providers
cd -
```

Expected: `<old-sha>..<new-sha>  HEAD -> providers` (fast-forward push).

If the push is rejected (non-fast-forward), STOP — someone else updated the branch and the worktree base is stale. Do NOT force-push. Re-do steps 1-5 from a fresh worktree.

- [ ] **Step 7: Verify the push landed**

```bash
git fetch fork providers
git ls-tree -r fork/providers --name-only | grep -E "providers/(agy|mcp-to-agy)" | sort
```

Expected output (5 lines):
```
container/agent-runner/src/providers/agy.factory.test.ts
container/agent-runner/src/providers/agy.ts
container/agent-runner/src/providers/mcp-to-agy.test.ts
container/agent-runner/src/providers/mcp-to-agy.ts
src/providers/agy.ts
```

- [ ] **Step 8: Tear down the worktree**

```bash
git worktree remove /tmp/providers-tree
git worktree list  # confirm /tmp/providers-tree is gone
```

Expected: the main worktree at `/Users/bradhess/Documents/GitHub/nanoclaw-v2` is the only one listed.

- [ ] **Step 9: No local commit to make**

This task makes a commit on `fork/providers` (already pushed in step 6). Nothing to commit on `local/main`. Move to Task 4.

---

### Task 4: Create `.claude/skills/add-agy/SKILL.md`

**Files:**
- Create: `.claude/skills/add-agy/SKILL.md`

This is the largest single task. The file is ~280 lines of markdown. Write the full body verbatim.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p .claude/skills/add-agy
```

- [ ] **Step 2: Write SKILL.md with the full content below**

Write the file `.claude/skills/add-agy/SKILL.md` with this exact content:

```markdown
---
name: add-agy
description: Install the agy (Google Antigravity) agent provider. Productizes a binary download + sha512 verify, one-time in-container OAuth dance, and optional group flip. Cost-stacking complement to /add-opencode and /add-codex — routes selected groups to Google AI Pro subscription tokens instead of Anthropic credits.
---

# agy (Google Antigravity) agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`agent_provider`** in `container.json` (`claude` | `opencode` | `agy` | `mock`).

Trunk ships with only the `claude` provider baked in. This skill copies the agy provider files in from the `providers` branch, wires them into the host and container barrels, installs the Linux binary, runs the one-time OAuth dance, and optionally flips a chosen group to use agy.

## Install

### Pre-flight

If all of the following are already present, jump directly to **Step 7 (auth-login)** or **Step 8 (group flip)** as needed:

- `src/providers/agy.ts`
- `container/agent-runner/src/providers/agy.ts`
- `container/agent-runner/src/providers/mcp-to-agy.ts`
- `import './agy.js';` line in `src/providers/index.ts`
- `import './agy.js';` line in `container/agent-runner/src/providers/index.ts`
- Linux binary at `~/.local/bin/antigravity-linux-arm64` (or `_amd64`) is executable

Detect what's already present and report a summary to the user before doing destructive work. All steps below are idempotent; re-running is safe.

```bash
echo "=== /add-agy pre-flight ==="
for f in src/providers/agy.ts \
         container/agent-runner/src/providers/agy.ts \
         container/agent-runner/src/providers/mcp-to-agy.ts; do
  test -f "$f" && echo "  source: $f ✓" || echo "  source: $f MISSING"
done
grep -q "./agy.js" src/providers/index.ts && echo "  host barrel: ✓" || echo "  host barrel: MISSING"
grep -q "./agy.js" container/agent-runner/src/providers/index.ts && echo "  container barrel: ✓" || echo "  container barrel: MISSING"

ARCH=$(uname -m); case "$ARCH" in arm64|aarch64) A=arm64;; x86_64|amd64) A=amd64;; *) A=unknown;; esac
test -x "$HOME/.local/bin/antigravity-linux-${A}" && echo "  binary: ✓" || echo "  binary: MISSING"
test -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" && echo "  oauth token: ✓" || echo "  oauth token: MISSING"
```

### 1. Fetch the providers branch

```bash
git fetch fork providers
```

> **Why `fork` not `origin`:** in this install, `origin` points to the upstream public repo and is off-limits for personal-install work. `fork` (`github.com/fresholdidea/nanoclaw-v2`) holds the agy provider files on its `providers` branch.

### 2. Copy the agy source files (skip per file if already present)

Wholesale copies (owned entirely by this skill — user edits to these files won't survive a re-run, as designed):

```bash
git show fork/providers:src/providers/agy.ts                                    > src/providers/agy.ts
git show fork/providers:container/agent-runner/src/providers/agy.ts             > container/agent-runner/src/providers/agy.ts
git show fork/providers:container/agent-runner/src/providers/mcp-to-agy.ts      > container/agent-runner/src/providers/mcp-to-agy.ts
git show fork/providers:container/agent-runner/src/providers/mcp-to-agy.test.ts > container/agent-runner/src/providers/mcp-to-agy.test.ts
git show fork/providers:container/agent-runner/src/providers/agy.factory.test.ts > container/agent-runner/src/providers/agy.factory.test.ts
```

### 3. Append the self-registration imports

Each barrel gets one line appended at the end — skip if the line is already present.

`src/providers/index.ts`:

```typescript
import './agy.js';
```

`container/agent-runner/src/providers/index.ts`: add a new `loadProvider('agy')` call to the existing `Promise.all` block:

```typescript
await Promise.all([
  loadProvider('claude'),
  loadProvider('mock'),
  loadProvider('opencode'),
  loadProvider('agy'),
]);
```

### 4. Install the Linux binary

The binary is bind-mounted at container spawn time, not baked into the image. Install via Google's official auto-updater manifest + GCS bucket.

```bash
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) AGY_ARCH=arm64 ;;
  x86_64|amd64)  AGY_ARCH=amd64 ;;
  *) echo "unsupported arch: $ARCH (expected arm64 or x86_64)"; exit 1 ;;
esac

MANIFEST_URL="https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_${AGY_ARCH}.json"

# Fetch the manifest. Field names verified empirically during the spike;
# if jq returns empty, print the raw JSON so we can pick the right field.
MANIFEST=$(curl -fsSL "$MANIFEST_URL")
DL_URL=$(echo "$MANIFEST" | jq -r '.downloadUrl // .url // .download_url // empty')
EXPECTED_SHA=$(echo "$MANIFEST" | jq -r '.sha512 // .checksum // .sha512sum // empty')

if [ -z "$DL_URL" ] || [ -z "$EXPECTED_SHA" ]; then
  echo "Could not extract download URL or sha512 from manifest. Raw JSON:"
  echo "$MANIFEST"
  echo "Update the jq field path in this skill and retry."
  exit 1
fi

TMP=$(mktemp -d)
echo "Downloading $DL_URL ..."
curl -fL "$DL_URL" -o "$TMP/cli.tar.gz"

ACTUAL_SHA=$(shasum -a 512 "$TMP/cli.tar.gz" | awk '{print $1}')
if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "sha512 mismatch — refusing to install"
  echo "  expected: $EXPECTED_SHA"
  echo "  actual:   $ACTUAL_SHA"
  exit 1
fi
echo "sha512 OK"

tar -xzf "$TMP/cli.tar.gz" -C "$TMP"
# The binary inside the tarball is named `antigravity`, not `agy`.
mkdir -p "$HOME/.local/bin"
mv "$TMP/antigravity" "$HOME/.local/bin/antigravity-linux-${AGY_ARCH}"
chmod +x "$HOME/.local/bin/antigravity-linux-${AGY_ARCH}"
rm -rf "$TMP"

file "$HOME/.local/bin/antigravity-linux-${AGY_ARCH}"
```

Expected last line: `ELF 64-bit LSB pie executable, ARM aarch64, ...` (or `x86-64` for amd64).

### 5. Propagate to existing per-group overlays

Each agent group has a live source overlay at `data/v2-sessions/<group-id>/agent-runner-src/providers/` that **overrides the image at runtime**. This overlay is created when the group is first wired and never auto-updated by image rebuilds. Any group that already existed before this skill ran needs the new files copied in manually.

```bash
for overlay in data/v2-sessions/*/agent-runner-src/providers/; do
  [ -d "$overlay" ] || continue
  cp container/agent-runner/src/providers/agy.ts "$overlay"
  cp container/agent-runner/src/providers/mcp-to-agy.ts "$overlay"
  cp container/agent-runner/src/providers/index.ts "$overlay"
  echo "Updated: $overlay"
done
```

### 6. Build

```bash
pnpm run build                                                   # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
./container/build.sh                                             # agent image
```

> **Build cache gotcha:** The container buildkit caches COPY steps aggressively. If the rebuild seems to ignore the new files (e.g. you see "Unknown provider: agy" later), prune the builder and rebuild:
> ```bash
> docker builder prune -f && ./container/build.sh
> ```

### 7. One-time OAuth dance (agy auth login)

agy detects the container environment and uses file-based token storage at `~/.gemini/antigravity-cli/antigravity-oauth-token`. The host's macOS keychain (where host-side `agy` keeps tokens) is NOT portable into the container, so a one-time `agy auth login` must run inside a container with `~/.gemini` mounted so the resulting token persists back to the host.

This step is interactive — it needs the user's browser. The skill cannot drive it; print the command and have the user run it in their own terminal.

**Skip this step if `~/.gemini/antigravity-cli/antigravity-oauth-token` already exists.**

Tell the user:

> The agy CLI needs a one-time OAuth login that writes a token file to `~/.gemini/antigravity-cli/`. Run this in your own terminal — it'll open a browser, you complete Google sign-in, and the token persists on the host:
>
> ```bash
> bash scripts/agy/auth-login.sh
> ```
>
> Tell me when you're done and I'll verify the token landed.

After the user confirms:

```bash
if [ -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]; then
  echo "auth token present — install complete"
else
  echo "auth token still missing"
  echo "If the script errored, common causes:"
  echo "  - TLS error (x509) — script must use the nanoclaw agent image, not node:22-slim"
  echo "  - Permission denied — check container ran as $(id -u):$(id -g)"
  exit 1
fi
```

### 8. Optional: flip a group to use agy

If the user wants to start using agy on a specific group right now, do this. Otherwise emit the reminder snippet and stop.

```bash
# List groups for the user to choose from
ncl groups list
```

Prompt: *"Which group should run on agy? Type a folder name (e.g. `cache`), or `skip` to leave all groups on claude."*

If user picks a group folder (e.g. `cache`):

```bash
GROUP=cache  # whatever the user typed
GROUP_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups WHERE folder='$GROUP'")
if [ -z "$GROUP_ID" ]; then
  echo "no agent group found with folder '$GROUP'"; exit 1
fi

# Snapshot the current container.json so revert is one command
cp "groups/$GROUP/container.json" "/tmp/$GROUP-container.json.before-agy"

# Flip provider to agy
jq '. + {provider: "agy"}' "groups/$GROUP/container.json" > /tmp/c.json
mv /tmp/c.json "groups/$GROUP/container.json"

ncl groups restart --id "$GROUP_ID"
echo "Flipped $GROUP to agy. To revert:"
echo "  cp /tmp/$GROUP-container.json.before-agy groups/$GROUP/container.json"
echo "  ncl groups restart --id $GROUP_ID"
```

If user types `skip`:

```
To flip any group to agy later: edit groups/<folder>/container.json to add `"provider": "agy"`, then run `ncl groups restart --id <group-id>`.
```

## Configuration

agy reads its OAuth credentials and config from `~/.gemini/antigravity-cli/`. The host bind-mounts `~/.gemini` r/w into the container at `/home/node/.gemini`. No `.env` configuration is required — Google AI Pro subscription billing applies automatically once the OAuth token is in place.

### MCP server passthrough

Existing MCP servers in `groups/<folder>/container.json` (`mcpServers` block) are translated to agy's `mcp_config.json` format on each turn. No additional configuration needed.

### Per-agent images

If you have agent groups built with per-agent image tags (e.g. `nanoclaw-agent:ag-<id>-<slug>` from a self-mod rebuild), those images won't include the agy provider until you rebuild them. Use `scripts/rebuild-agent-image.ts <group-id>` per the per-agent image drift memory, or temporarily clear the `imageTag` field in the group's container.json to fall back to `nanoclaw-agent-v2-*:latest`.

## Operational notes

- agy `-p` mode emits incremental stdout but has no "final answer starts here" marker; the provider currently passes the full concatenated stdout as `result.text`. A stray `</internal>` close-tag from agent narration can leak into the delivered message (see `scripts/spike/agy/findings.md`, "Known issues #1"). Fix candidates noted there; tracked as a follow-up.
- First turn after a fresh container spawn logs `[agy-provider] Failed to discover conversation id within 30s — proceeding without continuation`. This is benign for the first turn; continuation resumes on the next turn.
- Token usage shows on https://aistudio.google.com/usage, NOT in the Anthropic console.

## Verify

```bash
grep -q "./agy.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./agy.js" src/providers/index.ts && echo "host barrel: OK"
ARCH=$(uname -m); case "$ARCH" in arm64|aarch64) A=arm64;; *) A=amd64;; esac
test -x "$HOME/.local/bin/antigravity-linux-${A}" && echo "binary: OK"
test -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" && echo "auth token: OK"
cd container/agent-runner && bun test src/providers/agy.factory.test.ts && cd -
```
```

- [ ] **Step 3: Verify the file is syntactically valid markdown with the right frontmatter**

```bash
test -f .claude/skills/add-agy/SKILL.md
head -4 .claude/skills/add-agy/SKILL.md
wc -l .claude/skills/add-agy/SKILL.md
```

Expected: file exists, head shows the YAML frontmatter (`---`, `name: add-agy`, `description: ...`, `---`), wc shows approximately 280 lines.

- [ ] **Step 4: Run host tests to confirm nothing accidentally broke**

```bash
pnpm test 2>&1 | tail -5
```

Expected: pass count matches baseline.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/add-agy/SKILL.md
git commit -m "feat(skills): add /add-agy installation skill

Productizes the agy (Google Antigravity) provider install in a
single command. Sources the 5 provider files from fork/providers,
appends barrel imports, downloads + sha512-verifies the Linux
binary into ~/.local/bin/antigravity-linux-<arch>, propagates to
per-group overlays, rebuilds, walks the user through the one-time
OAuth dance, and optionally flips a chosen group to use agy.

Follows the /add-opencode pattern. Idempotent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dry-run verification against the current install

**Files:**
- None modified. Read-only validation.

This task verifies the skill's pre-flight checks correctly detect the existing install state. Since /add-agy is idempotent and Brad already has agy installed, the dry-run should report everything as ✓ and not propose any destructive actions.

- [ ] **Step 1: Run the pre-flight check block from the skill verbatim**

Copy the bash from SKILL.md "Pre-flight" section and run it:

```bash
echo "=== /add-agy pre-flight ==="
for f in src/providers/agy.ts \
         container/agent-runner/src/providers/agy.ts \
         container/agent-runner/src/providers/mcp-to-agy.ts; do
  test -f "$f" && echo "  source: $f ✓" || echo "  source: $f MISSING"
done
grep -q "./agy.js" src/providers/index.ts && echo "  host barrel: ✓" || echo "  host barrel: MISSING"
grep -q "./agy.js" container/agent-runner/src/providers/index.ts && echo "  container barrel: ✓" || echo "  container barrel: MISSING"

ARCH=$(uname -m); case "$ARCH" in arm64|aarch64) A=arm64;; x86_64|amd64) A=amd64;; *) A=unknown;; esac
test -x "$HOME/.local/bin/antigravity-linux-${A}" && echo "  binary: ✓" || echo "  binary: MISSING"
test -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" && echo "  oauth token: ✓" || echo "  oauth token: MISSING"
```

Expected output: 3 lines of `source: ... ✓`, 1 line of `host barrel: ✓`, 1 line of `container barrel: ✓`, 1 line of `oauth token: ✓`.

The `binary` line is the one that may NOT be ✓: the current install has the binary at `scripts/spike/agy/cache/antigravity` (from the spike), NOT at `~/.local/bin/antigravity-linux-arm64`. After Task 2's candidate-paths cleanup, the host config no longer falls back to the spike path. Either:
- (a) Binary line shows MISSING — expected for this dry-run; user needs to copy or re-download per skill step 4. The skill is correctly detecting the missing canonical install.
- (b) Binary line shows ✓ — only possible if the user manually copied or symlinked. Fine either way.

Report which one it is so the user knows what to do next.

- [ ] **Step 2: Verify the source-from-fork commands work without errors**

Test that the `git show fork/providers:<path>` commands resolve correctly. Don't actually overwrite files — pipe to /dev/null.

```bash
for f in src/providers/agy.ts \
         container/agent-runner/src/providers/agy.ts \
         container/agent-runner/src/providers/mcp-to-agy.ts \
         container/agent-runner/src/providers/mcp-to-agy.test.ts \
         container/agent-runner/src/providers/agy.factory.test.ts; do
  if git show fork/providers:"$f" > /dev/null 2>&1; then
    echo "  fork/providers:$f ✓"
  else
    echo "  fork/providers:$f MISSING — Task 3 push failed"
    exit 1
  fi
done
```

Expected: 5 lines of `✓`. If any are MISSING, Task 3's push to fork/providers did not include that file.

- [ ] **Step 3: No commit. This is verification only.**

Report status to the user.

---

## Self-Review

Spec coverage:
- §Architecture (2 artifacts + bundled cleanup) → Tasks 1, 2, 3, 4 ✓
- §Skill flow steps 1-9 → Task 4's SKILL.md body covers all 9 steps ✓
- §Bundled cleanup → Tasks 1 and 2 ✓
- §Sibling prep → Task 3 ✓
- §Success criteria #1-4 → Tasks 4 (the SKILL.md fulfills criteria 1-2 by design) and Task 5 (verifies idempotency criterion 3 against the current install). Criterion 4 (selective re-install on missing pieces) is exercised by Task 5 if any pre-flight check is MISSING.
- §Risks → All risks have mitigations in either Task 3 (worktree avoids branch swap, no-force-push rule) or Task 4 (manifest field name fallback, agent image for auth-login, build cache gotcha note) ✓
- §Decision record → Encoded in the SKILL.md and Task 2 (drop spike path) ✓

Placeholder scan: no TBDs, no "add appropriate error handling", no skipped code. Tasks reference exact line numbers + file paths.

Type consistency: SKILL.md uses `agy.js`, `agy.ts`, `mcp-to-agy.ts`, `antigravity-linux-arm64`/`_amd64` consistently across all sections. Variable names (`ARCH`/`A`, `GROUP`/`GROUP_ID`) match within each step. The 5 source files are listed identically in pre-flight, code copy, overlay propagation, and Task 3.

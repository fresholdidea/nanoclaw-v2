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

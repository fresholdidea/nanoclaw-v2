---
name: add-rtk
description: Install rtk token-compression proxy into agent containers. Routes Bash tool calls through rtk for 60–90% token savings on dev commands (git, cargo, pytest, docker, kubectl, etc.).
---

# Add rtk

Install [rtk](https://github.com/rtk-ai/rtk) — a CLI proxy delivering 60–90% token savings on common dev commands (git, cargo, pytest, docker, kubectl, etc.) — and wire it transparently into agent containers via the Claude Code `PreToolUse` hook.

## What this sets up

- A **Linux** rtk binary at `~/.local/share/nanoclaw/rtk-linux/rtk` on the host
- That binary mounted read-only at `/workspace/extra/rtk` inside the target agent group's containers
- `PreToolUse` hook in the agent group's `settings.json` calling `/workspace/extra/rtk hook claude`, so every Bash call is automatically filtered through rtk — no CLAUDE.md instructions needed

**Two things about this that are easy to get wrong** — both produce silent failures:

- The mounted binary must be built for **Linux**, matching the container's architecture — not the host's. Agent containers are Linux even when the host is macOS, so `install.sh` (which detects the *host* platform) is the wrong source for the mount. See Step 1.
- The mount's `--container` path must be **relative**. Additional mounts always land under `/workspace/extra/`; an absolute path is rejected by the mount validator and the mount silently never happens. See Step 3.

## Integration tests

This skill has **no in-tree integration test** by design. Its only functional reach-ins are runtime operator actions — the host-only `ncl groups config add-mount` (Step 3) and the `settings.json` `PreToolUse` hook write (Step 4) — neither of which leaves a line in the source tree whose deletion a test could catch. There are no package dependencies or Dockerfile edits to guard either. Conformance is idempotent apply + `REMOVE.md`; the mount and hook are verified at runtime by container probe (see Verify).

## Step 1 — Download a Linux rtk binary on the host

The container executes this binary, so it must match the **container's** OS and architecture. Do not use `install.sh` here: it resolves the *host* platform, so on macOS it fetches a Mach-O build that cannot run inside a Linux container.

Containers are built for the host's Docker platform, so the architecture is taken from `uname -m` while the OS is always Linux:

```bash
RTK_VERSION=v0.43.0
RTK_DIR=~/.local/share/nanoclaw/rtk-linux

case "$(uname -m)" in
  arm64|aarch64) TRIPLE=aarch64-unknown-linux-gnu ;;
  x86_64|amd64)  TRIPLE=x86_64-unknown-linux-musl ;;
  *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
esac

mkdir -p "$RTK_DIR" && TMP=$(mktemp -d) && cd "$TMP"
BASE="https://github.com/rtk-ai/rtk/releases/download/$RTK_VERSION"
curl -fsSL -O "$BASE/rtk-$TRIPLE.tar.gz"
curl -fsSL -O "$BASE/checksums.txt"

# Verify before trusting the binary (upstream's own installer refuses without this).
EXPECTED=$(grep "[[:space:]]rtk-$TRIPLE.tar.gz\$" checksums.txt | awk '{print $1}')
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "rtk-$TRIPLE.tar.gz" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "rtk-$TRIPLE.tar.gz" | awk '{print $1}')
fi
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "checksum mismatch — aborting"; exit 1; }

tar -xzf "rtk-$TRIPLE.tar.gz"
install -m 0755 rtk "$RTK_DIR/rtk" && cd - && rm -rf "$TMP"
```

Pin `RTK_VERSION` to an exact tag — never `latest`. Check [releases](https://github.com/rtk-ai/rtk/releases) for newer versions.

Confirm you got a Linux binary (this will *not* run on a macOS host — that is the expected result):

```bash
file ~/.local/share/nanoclaw/rtk-linux/rtk
# Expect: ELF 64-bit LSB ... (not Mach-O)
```

If you also want rtk on the host for your own shell, install it separately with upstream's `install.sh`. That copy is for host use only — never mount it into a container.

## Step 2 — Identify the target agent group

```bash
ncl groups list
```

Note the group ID (e.g. `ag-1776342942165-ptgddd`). Repeat Steps 3–5 for each group.

## Step 3 — Mount rtk into the container config

Mount the Linux binary read-only with the host-only `add-mount` verb. It is idempotent — re-running skips the entry if it is already present:

```bash
ncl groups config add-mount --id <group-id> \
  --host ~/.local/share/nanoclaw/rtk-linux/rtk \
  --container rtk \
  --ro
```

`--container` is **relative on purpose**. Every additional mount is placed under `/workspace/extra/`, so `--container rtk` lands the binary at `/workspace/extra/rtk`. An absolute path (`/usr/local/bin/rtk`) fails `isValidContainerPath` and the mount is dropped at spawn with an `Additional mount REJECTED` warning in `logs/nanoclaw.error.log` — the container starts fine and the hook simply never works.

This verb is operator-only and runs host-side (via `/setup`, `/customize`, or `/manage-mounts`); it is rejected from inside a container.

The host root (`~/.local/share/nanoclaw`) must also be in the external mount allowlist at `~/.config/nanoclaw/mount-allowlist.json` for the mount to take effect at spawn. Add it there if it isn't already — read-only is sufficient.

Verify:

```bash
ncl groups config get --id <group-id>
# Look for the mount with containerPath "rtk"
```

## Step 4 — Add the PreToolUse hook to settings.json

Each agent group has a `settings.json` at:

```
data/v2-sessions/<group-id>/.claude-shared/settings.json
```

This file is mounted at `/home/node/.claude/settings.json` inside the container and is read by Claude Code for hooks, env, and model config.

The mounted binary is **not on `PATH`**, so the hook must invoke it by full path. Add the `PreToolUse` entry with `jq`. This drops any existing rtk Bash hook first (including one from an older version of this skill that used a bare `rtk`), then appends a fresh one, so it is safe to re-run without creating duplicates:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      | map(select((.hooks // []) | any((.command // "") | test("rtk hook claude")) | not)))
    + [{"matcher":"Bash","hooks":[{"type":"command","command":"/workspace/extra/rtk hook claude"}]}]' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

## Step 5 — Restart the container

```bash
ncl groups restart --id <group-id>
```

## Verify

Confirm the binary is present and executable inside the container, so a rejected mount or a wrong-platform binary surfaces immediately rather than as a silent hook failure:

```bash
docker exec "$(docker ps --filter "name=<group-id>" --format '{{.Names}}' | head -1)" \
  /workspace/extra/rtk --version
```

A version string means the mount landed and the binary matches the container's platform.

Then ask the agent to run `git status` or any other supported command. rtk intercepts it silently.

To check savings, run `rtk gain` **inside the container** — rtk records stats in the container's own home directory, not on the host, so the host copy of rtk (if you installed one) will not show the agent's usage:

```bash
docker exec "$(docker ps --filter "name=<group-id>" --format '{{.Names}}' | head -1)" \
  /workspace/extra/rtk gain
```

Containers run with `--rm`, so these stats reset when the container exits.

## Troubleshooting

### `exec format error` or `cannot execute binary file`

The mounted binary is built for the wrong platform — almost always because it came from `install.sh` on a macOS host. Re-do Step 1 to fetch the Linux build:

```bash
file ~/.local/share/nanoclaw/rtk-linux/rtk   # must say ELF, not Mach-O
```

### `no such file or directory` for `/workspace/extra/rtk`

The mount was rejected or the container wasn't restarted. Check the config, then the log:

```bash
ncl groups config get --id <group-id>       # containerPath must be "rtk", not an absolute path
grep "Additional mount REJECTED" logs/nanoclaw.error.log | tail -5
ncl groups restart --id <group-id>
```

A rejection also means the host root isn't in `~/.config/nanoclaw/mount-allowlist.json` (Step 3).

### Hook not firing

Verify the hook is in `settings.json` and points at the full path:

```bash
jq '.hooks.PreToolUse' data/v2-sessions/<group-id>/.claude-shared/settings.json
```

If it shows a bare `rtk hook claude`, it predates the full-path fix — re-run Step 4.

### Binary won't execute — permission denied

```bash
chmod +x ~/.local/share/nanoclaw/rtk-linux/rtk
```

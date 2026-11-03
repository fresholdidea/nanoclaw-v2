---
name: add-mnemon
description: Add persistent graph-based memory via mnemon. Agents recall past context before responding and remember insights after each turn.
---

# Add Mnemon — Persistent Memory

Installs [mnemon](https://github.com/mnemon-dev/mnemon) in the agent container image. On each container start, `mnemon setup` registers Claude Code hooks that surface relevant memory before the agent responds and store new insights after each turn. Memory is written to the per-agent-group `.claude/` mount and survives container restarts.

> **This install is customized.** The host and every group that uses mnemon share one store, reached through a read-only mount plus a writable queue mount. There is no per-group store and no entrypoint hook. Read **This Install: Shared Store + Shim Architecture** below before applying anything; where it disagrees with the stock steps, it wins.

## Provider Compatibility

mnemon hooks fire only under `--target claude-code`. Use this skill on agent groups that run the default Claude provider. The provider is the materialized `provider` key in each group's `container.json` (absent or `claude` = default Claude provider). Confirm it before applying:

```bash
grep -H '"provider"' groups/*/container.json 2>/dev/null   # no match, or "provider": "claude" = Claude
```

If a group sets a different provider (e.g. `"provider": "opencode"`), it spawns its own process and never invokes the `claude` CLI, so the hooks registered by `mnemon setup` do not run for that group.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'MNEMON_VERSION' container/Dockerfile && echo "Already applied" || echo "Not applied"
```

If already applied, re-run Phase 2 anyway — every step is idempotent and skips work that is already in place — then continue to Phase 3 (Verify).

### Check latest mnemon version

```bash
curl -fsSL https://api.github.com/repos/mnemon-dev/mnemon/releases/latest | grep '"tag_name"'
```

Note the version (e.g. `v0.1.1`) — use it as `MNEMON_VERSION` in the next step.

## Phase 2: Apply Changes

### 1. Dockerfile — install mnemon binary

Insert the mnemon block immediately above the `# ---- Bun runtime` section of `container/Dockerfile` (skip if `grep -q 'MNEMON_VERSION' container/Dockerfile` already matches):

```dockerfile
# ---- mnemon — persistent agent memory ----------------------------------------
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

`MNEMON_DATA_DIR` points into the per-agent-group `.claude/` mount, so memory persists across container restarts.

### 2. Entrypoint — run mnemon setup on each container start

**This install: skip this step.** The entrypoint must not run `mnemon setup` (see This Install below), and `src/mnemon-entrypoint.test.ts` fails if the line comes back.

`mnemon setup` is idempotent. Run it once per `container/entrypoint.sh`. First check whether the line is already present:

```bash
grep -q 'mnemon setup' container/entrypoint.sh && echo "Already wired" || echo "Wire it"
```

If it prints `Wire it`, add the setup call right after `set -e`, before the `cat` that captures stdin, so the result looks like:

```bash
#!/bin/bash
# NanoClaw agent container entrypoint.
#
# ...existing header comment...

set -e

mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
```

`>/dev/stderr 2>&1` routes all mnemon output to stderr (docker logs) so it doesn't interfere with the JSON stdin handshake between host and agent-runner.

### 3. Copy the integration tests

Both reach-ins are into container build/runtime files that aren't importable or typed (a GitHub-release binary in the Dockerfile, a shell line in the entrypoint), so structural tests guard them. Copy them into the host test tree:

```bash
cp .claude/skills/add-mnemon/mnemon-dockerfile.test.ts src/mnemon-dockerfile.test.ts
cp .claude/skills/add-mnemon/mnemon-entrypoint.test.ts src/mnemon-entrypoint.test.ts
pnpm exec vitest run src/mnemon-dockerfile.test.ts src/mnemon-entrypoint.test.ts
```

`mnemon-dockerfile.test.ts` asserts the `MNEMON_VERSION` ARG and `MNEMON_DATA_DIR` ENV are present (red if the install layer is dropped on an upgrade). On this install `mnemon-entrypoint.test.ts` is inverted: it asserts the entrypoint does **not** run `mnemon setup` (red if step 2 is ever applied).

### 4. Rebuild and smoke-test the image

```bash
./container/build.sh
docker run --rm --entrypoint mnemon nanoclaw-agent:latest --version
```

## Phase 3: Restart and Verify

### Restart the service

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

### Confirm mnemon hooks are registered

After the next container starts, check that setup ran:

```bash
docker logs $(docker ps --filter label=nanoclaw-session --format "{{.Names}}" | head -1) 2>&1 | grep -i mnemon
```

Then inspect the hooks inside the running container:

```bash
docker exec $(docker ps --filter label=nanoclaw-session --format "{{.Names}}" | head -1) \
  cat /home/node/.claude/settings.json | grep -A5 mnemon
```

### Test memory recall

Have a conversation with the agent, then start a new session and reference something from the earlier one. Mnemon should surface the relevant context automatically without you restating it.

## This Install: Shared Store + Shim Architecture (customized 2026-07-21)

This install diverges from the stock skill. The host and every group that uses mnemon share one store, `~/.mnemon`, which containers see at `/workspace/extra/mnemon`. Since 2026-09-30 the root is mounted read-only and only `queue/` is writable (see [Mounting the store into a group](#mounting-the-store-into-a-group)). mnemon >= 0.1.14 forces SQLite WAL mode on every read-write open. WAL needs mmap'd shared memory, which fails across the macOS Docker file-sharing mount (`SQLITE_CANTOPEN (14)`), so containers can never open the live DB directly — in either RW or `--readonly` mode.

The working architecture:

- **Container**: `/usr/local/bin/mnemon` is a shim (`container/mnemon-shim.sh`); the release binary lives at `mnemon-real`. Read verbs (`recall`, `search`, `related`, `status`, `log`, `viz`, `receipt`) run `mnemon-real --readonly` against `/workspace/extra/mnemon/snapshot/`. Write verbs (`remember`, `link`, `forget`) queue their argv as a JSON file in `/workspace/extra/mnemon/queue/` via `container/mnemon-queue.mjs`.
- **Host**: `src/mnemon-sync.ts` (started from `src/index.ts`) replays queued argv through the host mnemon CLI every 60s and refreshes the snapshot (`VACUUM INTO`, DELETE journal, atomic rename) every 5 minutes or after a drain.
- Failed/invalid queue files are parked as `*.err` in `~/.mnemon/queue/` — check there if agent memories go missing.

Agents learn the commands from the curated container skill `container/skills/mnemon/SKILL.md`, not from hooks. Recall is up to ~5 min stale, and remembers land on the next drain.

### What differs from the stock steps above

- **Phase 2 step 1:** this install's Dockerfile block installs the release binary as `mnemon-real`, copies in the shim and queue writer, and sets `MNEMON_DATA_DIR=/workspace/extra/mnemon`. `src/mnemon-dockerfile.test.ts` guards it.
- **Phase 2 step 2: skip it** (the line was removed on 2026-09-30). Live spawns bypass the image entrypoint (`bash -c 'exec bun …'` in `src/container-runner.ts`), so it could only run on a bare `docker run`. If it did, `mnemon setup` would write `prompt/{guide,skill}.md` and `data/default/mnemon.db` under `MNEMON_DATA_DIR`, which is the shared store, and install hooks that duplicate the container skill.
- **Phase 3 hook checks, Memory Storage, Troubleshooting:** these describe the stock per-group store and hooks. Nothing is registered in `settings.json` here. Memory lives in `~/.mnemon` on the host, shared with host agents such as Claude Code, Codex and Hermes, so never delete it to reset one group. Verify a group with the mount check below.

### Mounting the store into a group

A group that writes memories needs **both** mounts. A group that only reads memory takes the first one alone.

```bash
ncl groups config add-mount --id <group-id> --host ~/.mnemon --container mnemon --ro
ncl groups config add-mount --id <group-id> --host ~/.mnemon/queue --container mnemon/queue --rw
ncl groups restart --id <group-id>
```

If the group's `skills` in `container_configs` is an explicit list rather than `"all"`, add `"mnemon"` to it so the agent loads the container skill. `ncl` has no flag for this.

`--rw` only records intent. The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) decides, and the first root that contains a path wins. So the queue needs its own read-write root, listed **above** the read-only `~/.mnemon` root in `allowedRoots`:

```json
{ "path": "~/.mnemon/queue", "allowReadWrite": true },
{ "path": "~/.mnemon", "allowReadWrite": false }
```

The old single mount, `--host ~/.mnemon --container mnemon --rw`, no longer works. The allowlist forces it read-only and every `mnemon remember` fails with `EROFS: read-only file system`. The same happens if the queue root is missing or listed below `~/.mnemon`.

**Why the root must stay read-only.** Host hooks and host sync processes read and write `~/.mnemon` by path, and a container can create real host symlinks inside a writable mount. With the root writable, a container could:

- rewrite `prompt/guide.md`, which host mnemon session hooks `cat` into the startup context of new sessions. That is prompt injection into host agents.
- swap `data/default/mnemon.db` for a symlink. The next `src/mnemon-sync.ts` snapshot (`VACUUM INTO` → `snapshot/`) would then copy any SQLite file the host can open, such as `data/v2.db`, into the container's view.
- plant a symlink where a host sync job writes its state or log by path, and so overwrite an arbitrary host file.

Containers never need more than `queue/` writable: reads come from `snapshot/` with `--readonly`, and writes are queued in `queue/`. Never give `~/.mnemon` read-write in the allowlist, and never move it above the queue root.

Once the group's container is running again, confirm the effective modes:

```bash
docker inspect $(docker ps -q --filter label=nanoclaw-group=<group-id> | head -1) \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}' | grep mnemon
```

Expect `~/.mnemon` → `/workspace/extra/mnemon` with `rw=false`, and `~/.mnemon/queue` → `/workspace/extra/mnemon/queue` with `rw=true`.

## Memory Storage

Mnemon writes to `/home/node/.claude/mnemon/` inside the container, which maps to the per-agent-group `.claude/` directory on the host. To find the exact host path:

```bash
docker inspect $(docker ps --filter label=nanoclaw-session --format "{{.Names}}" | head -1) \
  --format '{{range .Mounts}}{{if eq .Destination "/home/node/.claude"}}{{.Source}}{{end}}{{end}}'
```

To reset all memory for an agent, stop the container and delete the `mnemon/` subdirectory from that host path.

## Troubleshooting

### `mnemon: command not found` in container

The image wasn't rebuilt after adding the Dockerfile layer. Run `./container/build.sh` and restart.

### Memory not persisting across restarts

Verify `MNEMON_DATA_DIR` resolves to a mounted path (not an in-container ephemeral directory):

```bash
docker exec <container> sh -c 'ls -la $MNEMON_DATA_DIR'
```

If the directory is empty after conversations, the mount is missing or the path is wrong. Check the host mount with the `docker inspect` command above.

### Agent not using past memory

`mnemon setup` writes hooks into `/home/node/.claude/settings.json`. Verify:

```bash
docker exec <container> cat /home/node/.claude/settings.json
```

If the hooks are absent, `mnemon setup` may have failed silently. Check container startup logs for errors from mnemon.

### Setup fails at container start

Run setup manually inside a running container to see the full error:

```bash
docker exec -it <container> mnemon setup --target claude-code --yes --global
```

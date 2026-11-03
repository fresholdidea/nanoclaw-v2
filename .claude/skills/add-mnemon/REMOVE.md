# Remove Mnemon

Every step is idempotent — safe to run even if some steps were never applied.

## 0. Detach the shared store from every group (this install)

Skip this on a stock install. This install mounts one shared store into every group that uses mnemon (see SKILL.md → This Install). Find the groups that mount it:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT ag.id, ag.folder FROM container_configs cc JOIN agent_groups ag ON ag.id = cc.agent_group_id WHERE cc.additional_mounts LIKE '%.mnemon%'"
```

For each one, remove **both** mounts, then restart it. The queue mount on its own would still give the container a writable path into `~/.mnemon`.

```bash
ncl groups config remove-mount --id <group-id> --host ~/.mnemon/queue --container mnemon/queue
ncl groups config remove-mount --id <group-id> --host ~/.mnemon --container mnemon
ncl groups restart --id <group-id>
```

Also take `"mnemon"` out of any explicit `skills` list in `container_configs`, and drop the `~/.mnemon/queue` and `~/.mnemon` entries from `~/.config/nanoclaw/mount-allowlist.json`.

Do **not** delete `~/.mnemon`. It is the shared store for host agents such as Claude Code, Codex and Hermes, not a NanoClaw copy.

## 1. Strip the Dockerfile install layer

Open `container/Dockerfile` and delete the mnemon block (the `# ---- mnemon` comment, the `ARG MNEMON_VERSION`, the `RUN` that downloads the binary, and the `ENV MNEMON_DATA_DIR` line):

```dockerfile
# ---- mnemon — persistent agent memory ----------------------------------------
ARG MNEMON_VERSION=0.1.1
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mnemon && \
    chmod +x /usr/local/bin/mnemon

ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

If the block is already gone, skip this step.

## 2. Strip the entrypoint setup line

Open `container/entrypoint.sh` and delete the `mnemon setup` line that follows `set -e`:

```bash
mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1
```

If the line is already gone (always true on this install), skip this step.

## 3. Delete the copied test files

```bash
rm -f src/mnemon-dockerfile.test.ts src/mnemon-entrypoint.test.ts
```

## 4. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## 5. Delete stored memory (optional)

**This install: skip this step.** The store is the shared `~/.mnemon` (see step 0), not a per-group directory.

Mnemon's graph lives at `/home/node/.claude/mnemon/` in each container, which maps to the per-agent-group `.claude/` directory on the host. To find the host path and clear it:

```bash
docker inspect $(docker ps --filter label=nanoclaw-session --format "{{.Names}}" | head -1) \
  --format '{{range .Mounts}}{{if eq .Destination "/home/node/.claude"}}{{.Source}}{{end}}{{end}}'
```

Stop the container, then delete the `mnemon/` subdirectory from that path.

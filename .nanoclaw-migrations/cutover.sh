#!/usr/bin/env bash
# Cut the live install over to rebuild/upstream-2026-11.
#
#   cutover.sh prep     snapshot DB + images, stop host, drain containers,
#                       move main, install, build dist + images
#   (Brad)              pnpm exec tsx scripts/upgrade-state.ts set "" migrate-nanoclaw
#   cutover.sh start    start the host and run health checks
#   cutover.sh rollback put everything back to the pre-migrate tag
#
# Run from anywhere; every path is absolute.
set -euo pipefail

LIVE=/Users/bradhess/Documents/GitHub/nanoclaw-v2
BRANCH=rebuild/upstream-2026-11
TAG=pre-migrate-ed7eccd6-20261103-171601
IMG=nanoclaw-agent-v2-edb15411
SNAP=$LIVE/data/v2.db.pre-migrate-20261103
LABEL=gui/$(id -u)/com.nanoclaw
PLIST=$HOME/Library/LaunchAgents/com.nanoclaw.plist
export PATH="$HOME/.local/bin:$PATH" # host is pinned to Node 22 (better-sqlite3 ABI)

running() { docker ps --filter label=nanoclaw-install --format '{{.Names}}' | grep -c "^ncl-edb15411-" || true; }

stop_host() {
  launchctl bootout "$LABEL" 2>/dev/null || true
  for _ in $(seq 1 30); do pgrep -f "$LIVE/dist/index.js" >/dev/null || return 0; sleep 1; done
  echo "host still running after 30s" >&2; exit 1
}

drain() {
  # Containers outlive the host and have src/ bind-mounted. Give in-flight
  # turns up to 5 minutes, then stop the rest (unacked messages are retried).
  for _ in $(seq 1 30); do [ "$(running)" = 0 ] && return 0; echo "waiting on $(running) container(s)"; sleep 10; done
  docker ps --filter label=nanoclaw-install --format '{{.Names}}' | grep "^ncl-edb15411-" | xargs -r docker stop -t 20
}

case "${1:-}" in
  prep)
    [ "$(git -C "$LIVE" rev-parse --short HEAD)" = ed7eccd6 ] || { echo "live HEAD moved; re-check before cutover" >&2; exit 1; }
    [ -z "$(git -C "$LIVE" status --porcelain)" ] || { echo "live tree dirty" >&2; exit 1; }
    for t in $(docker images "$IMG" --format '{{.Tag}}' | grep -v '^pre-migrate'); do
      docker tag "$IMG:$t" "$IMG:pre-migrate-$t"
    done
    stop_host
    drain
    sqlite3 -readonly "$LIVE/data/v2.db" ".backup $SNAP"
    git -C "$LIVE" worktree remove --force "$LIVE/.upgrade-worktree"
    git -C "$LIVE" reset --hard "$BRANCH"
    # Non-frozen on purpose: the lockfile's dashboard link: path is relative to
    # the checkout and was recorded from the worktree.
    (cd "$LIVE" && pnpm install && pnpm run build)
    git -C "$LIVE" add pnpm-lock.yaml
    git -C "$LIVE" diff --cached --quiet || git -C "$LIVE" commit -q -m "chore: record the dashboard link path for the live checkout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
    (cd "$LIVE" && ./container/build.sh && pnpm exec tsx scripts/rebuild-agent-image.ts --all-customized)
    echo
    echo "PREP DONE at $(git -C "$LIVE" rev-parse --short HEAD). Host is STOPPED."
    echo "Next (Brad): cd $LIVE && pnpm exec tsx scripts/upgrade-state.ts set \"\" migrate-nanoclaw"
    ;;
  start)
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "$LABEL"
    sleep 20
    pgrep -f "$LIVE/dist/index.js" >/dev/null || { echo "host not running"; tail -40 "$LIVE/logs/nanoclaw.error.log"; exit 1; }
    tail -20 "$LIVE/logs/nanoclaw.error.log"
    ;;
  rollback)
    stop_host
    drain
    git -C "$LIVE" reset --hard "$TAG"
    (cd "$LIVE" && pnpm install --frozen-lockfile && pnpm run build)
    for t in $(docker images "$IMG" --format '{{.Tag}}' | grep '^pre-migrate-' | sed 's/^pre-migrate-//'); do
      docker tag "$IMG:pre-migrate-$t" "$IMG:$t"
    done
    echo "Code + images restored. The DB snapshot is at $SNAP (migrations added nothing, so restoring it is only needed if startup wrote bad state)."
    echo "Next (Brad): cd $LIVE && pnpm exec tsx scripts/upgrade-state.ts set \"\" rollback ; then: $0 start"
    ;;
  *) echo "usage: $0 prep|start|rollback" >&2; exit 2 ;;
esac

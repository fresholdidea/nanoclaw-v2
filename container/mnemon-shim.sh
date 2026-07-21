#!/bin/bash
# mnemon shim for agent containers.
#
# The shared store at $MNEMON_DATA_DIR is a host-side SQLite DB in WAL mode.
# WAL requires mmap'd shared memory, which does not work across the macOS
# Docker file-sharing mount — any direct open fails with SQLITE_CANTOPEN (14).
# So containers never touch the live DB:
#
#   reads  -> served from $MNEMON_DATA_DIR/snapshot, a DELETE-journal copy the
#             host refreshes via VACUUM INTO (src/mnemon-sync.ts), opened with
#             --readonly (no WAL files created).
#   writes -> argv is queued as a JSON file in $MNEMON_DATA_DIR/queue/; the
#             host replays it through the real mnemon CLI against the live DB.
#
# Everything else passes through to the real binary at /usr/local/bin/mnemon-real.
set -uo pipefail

REAL=/usr/local/bin/mnemon-real
BASE="${MNEMON_DATA_DIR:-/workspace/extra/mnemon}"

cmd="${1:-}"
case "$cmd" in
  recall|search|related|status|log|viz|receipt)
    MNEMON_DATA_DIR="$BASE/snapshot" exec "$REAL" --readonly "$@"
    ;;
  remember|link|forget)
    mkdir -p "$BASE/queue"
    exec bun /usr/local/lib/mnemon-queue.mjs "$BASE/queue" "$@"
    ;;
  *)
    exec "$REAL" "$@"
    ;;
esac

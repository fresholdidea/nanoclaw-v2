#!/usr/bin/env bash
#
# Wire several dedicated rooms in one pass, matching each room by its chat
# title. Wraps wire-dedicated-room.sh.
#
# When someone @mentions the bot in a new group, the router records the room
# and the approval-card path backfills the platform's own title into
# messaging_groups.name (via the adapter's resolveChannelName). So a room
# titled "CADCo AM" is findable by that exact string — no chat ids to copy.
#
# Rooms that don't exist yet are reported and skipped, so this is safe to
# re-run as groups get created one at a time. Already-wired rooms are no-ops.
#
# Usage:
#   scripts/wire-rooms-batch.sh "CADCo AM=cadco-am" "Cubby AM=cubby-am" ...
#   scripts/wire-rooms-batch.sh --map data/am-rooms.tsv
#
# Map file: one "<chat title><TAB><agent-group folder>" per line; blank lines
# and #-comments ignored.
#
# Flags: --channel-type (default telegram), --instance, --dry-run
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIRE="$HERE/wire-dedicated-room.sh"

CHANNEL_TYPE="telegram"
INSTANCE=""
DRY_RUN=0
PAIRS=()

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --map)
      [[ -r "${2:-}" ]] || die "cannot read map file: ${2:-<missing>}"
      while IFS=$'\t' read -r title folder; do
        [[ -z "${title// }" || "${title:0:1}" == "#" ]] && continue
        [[ -n "${folder:-}" ]] || die "map line missing a tab-separated folder: $title"
        PAIRS+=("${title}=${folder}")
      done < "$2"
      shift 2 ;;
    --channel-type) CHANNEL_TYPE="${2:-}"; shift 2 ;;
    --instance)     INSTANCE="${2:-}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      sed -n '2,22p' "$0"; exit 0 ;;
    -*)             die "unknown flag: $1" ;;
    *)              PAIRS+=("$1"); shift ;;
  esac
done

[[ ${#PAIRS[@]} -gt 0 ]] || die "nothing to wire — pass \"Title=folder\" pairs or --map <file>"
[[ -x "$WIRE" || -r "$WIRE" ]] || die "wire-dedicated-room.sh not found next to this script"
[[ -S data/ncl.sock ]] || die "no data/ncl.sock here — run from the install root (cd ~/Documents/GitHub/nanoclaw-v2)"

INSTANCE="${INSTANCE:-$CHANNEL_TYPE}"

ROOMS_JSON="$(pnpm --silent ncl messaging-groups list --json)"

wired=0; pending=0; failed=0
PENDING_TITLES=()

for pair in "${PAIRS[@]}"; do
  title="${pair%%=*}"
  folder="${pair#*=}"
  [[ -n "$title" && -n "$folder" && "$title" != "$pair" ]] || die "malformed pair (want \"Title=folder\"): $pair"

  # Title match is case-insensitive — Telegram preserves whatever was typed.
  platform_id="$(jq -r --arg n "$title" --arg ct "$CHANNEL_TYPE" --arg inst "$INSTANCE" '
      .data[]
      | select(.channel_type == $ct and .instance == $inst)
      | select((.name // "") | ascii_downcase == ($n | ascii_downcase))
      | .platform_id' <<<"$ROOMS_JSON" | head -1)"

  if [[ -z "$platform_id" ]]; then
    echo "── $title → $folder: NOT FOUND YET"
    PENDING_TITLES+=("$title")
    pending=$((pending + 1))
    continue
  fi

  echo "── $title → $folder ($platform_id)"
  args=(--agent-group "$folder" --platform-id "$platform_id" --name "$title"
        --channel-type "$CHANNEL_TYPE" --instance "$INSTANCE")
  [[ $DRY_RUN -eq 1 ]] && args+=(--dry-run)
  if bash "$WIRE" "${args[@]}"; then
    wired=$((wired + 1))
  else
    echo "   ^ FAILED — left alone, re-runnable" >&2
    failed=$((failed + 1))
  fi
  echo
done

echo "──────────────────────────────────────────"
echo "wired: $wired   awaiting creation: $pending   failed: $failed"
if [[ $pending -gt 0 ]]; then
  echo
  echo "Still need a Telegram group created + @JbhNanoclawBot mentioned in it:"
  for t in "${PENDING_TITLES[@]}"; do echo "  · $t"; done
  echo "The room title must match exactly (case-insensitive). Re-run when done."
fi
[[ $failed -eq 0 ]]

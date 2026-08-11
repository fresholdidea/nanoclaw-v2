#!/usr/bin/env bash
#
# Wire an existing agent group to its own dedicated chat room.
#
# Gives a sub-agent a private channel of its own — messages in that room go
# straight to it, and its replies land back in the same room instead of being
# relayed through a parent agent. Reproduces the profile the Falcone and
# cache-am rooms already use:
#
#   messaging group : is_group=1, unknown_sender_policy=strict
#   wiring          : engage pattern "." (every message), sender_scope=all,
#                     ignored_message_policy=drop, session_mode=shared
#   destination     : channel destination pointing back at the room
#
# sender_scope=all is safe here: the router still runs the user-level access
# gate (owner / admin / agent_group member), so a stranger dropped into the
# room is refused regardless of scope.
#
# Run from an install root (the directory holding data/ncl.sock) — ncl
# resolves its socket from the current working directory.
#
# Usage:
#   scripts/wire-dedicated-room.sh --agent-group <folder> --platform-id <id> \
#       [--channel-type telegram] [--instance <name>] [--name "<display>"] \
#       [--dest-name <local-name>] [--no-announce] [--dry-run]
#
# On success it appends a routing note to the group's standing instructions so
# the agent knows the room is its default destination; --no-announce skips that.
#
# Example:
#   cd ~/Documents/GitHub/nanoclaw-v2
#   scripts/wire-dedicated-room.sh --agent-group cadco-am \
#       --platform-id telegram:-4912345678 --name "CADCo AM"
#
set -euo pipefail

CHANNEL_TYPE="telegram"
INSTANCE=""
AGENT_GROUP=""
PLATFORM_ID=""
DISPLAY_NAME=""
DEST_NAME=""
DRY_RUN=0
ANNOUNCE=1

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-group)  AGENT_GROUP="${2:-}"; shift 2 ;;
    --platform-id)  PLATFORM_ID="${2:-}"; shift 2 ;;
    --channel-type) CHANNEL_TYPE="${2:-}"; shift 2 ;;
    --instance)     INSTANCE="${2:-}"; shift 2 ;;
    --name)         DISPLAY_NAME="${2:-}"; shift 2 ;;
    --dest-name)    DEST_NAME="${2:-}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --no-announce)  ANNOUNCE=0; shift ;;
    -h|--help)      sed -n '2,34p' "$0"; exit 0 ;;
    *)              die "unknown flag: $1" ;;
  esac
done

[[ -n "$AGENT_GROUP" ]] || die "--agent-group <folder> is required"
[[ -n "$PLATFORM_ID" ]] || die "--platform-id <id> is required"
[[ -S data/ncl.sock ]] || die "no data/ncl.sock here — run from the install root (cd ~/Documents/GitHub/nanoclaw-v2)"

# Default instance is the channel type itself (the unnamed adapter instance).
INSTANCE="${INSTANCE:-$CHANNEL_TYPE}"
DEST_NAME="${DEST_NAME:-${CHANNEL_TYPE}-${AGENT_GROUP}}"
# local_name is a column, not a display string — keep it short and stable.
DEST_NAME="$(printf '%s' "$DEST_NAME" | cut -c1-40)"

ncl() { pnpm --silent ncl "$@"; }

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'DRY-RUN  ncl'; printf ' %q' "$@"; printf '\n'
  else
    printf '  ncl'; printf ' %s' "$@"; printf '\n'
    ncl "$@" >/dev/null
  fi
}

# ── 1. Agent group must already exist ────────────────────────────────────────
AGENT_GROUP_ID="$(ncl groups list --json | jq -r --arg f "$AGENT_GROUP" \
  '.data[] | select(.folder == $f) | .id' | head -1)"
[[ -n "$AGENT_GROUP_ID" ]] || die "no agent group with folder '$AGENT_GROUP' (see: ncl groups list)"
echo "agent group : $AGENT_GROUP ($AGENT_GROUP_ID)"

# ── 2. Messaging group: create it, or adopt the row the router auto-created ──
MG_ROW="$(ncl messaging-groups list --json | jq -c \
  --arg ct "$CHANNEL_TYPE" --arg pid "$PLATFORM_ID" --arg inst "$INSTANCE" \
  '[.data[] | select(.channel_type == $ct and .platform_id == $pid and .instance == $inst)][0] // empty')"
MG_ID="$(jq -r '.id // empty' <<<"${MG_ROW:-}")"
EXISTING_NAME="$(jq -r '.name // empty' <<<"${MG_ROW:-}")"

if [[ -z "$MG_ID" ]]; then
  echo "room        : creating messaging group for $PLATFORM_ID"
  create_args=(messaging-groups create --channel-type "$CHANNEL_TYPE" --platform-id "$PLATFORM_ID"
               --instance "$INSTANCE" --is-group 1 --unknown-sender-policy strict)
  [[ -n "$DISPLAY_NAME" ]] && create_args+=(--name "$DISPLAY_NAME")
  run "${create_args[@]}"
  if [[ $DRY_RUN -eq 0 ]]; then
    MG_ID="$(ncl messaging-groups list --json | jq -r \
      --arg ct "$CHANNEL_TYPE" --arg pid "$PLATFORM_ID" --arg inst "$INSTANCE" \
      '.data[] | select(.channel_type == $ct and .platform_id == $pid and .instance == $inst) | .id' | head -1)"
    [[ -n "$MG_ID" ]] || die "messaging group create reported success but no row came back"
  else
    MG_ID="<new-mg-id>"
  fi
else
  echo "room        : adopting existing messaging group $MG_ID"
  # The router auto-creates rows on first @mention with request_approval and
  # whatever is_group the event carried. Normalize to the dedicated-room shape.
  update_args=(messaging-groups update "$MG_ID" --is-group 1 --unknown-sender-policy strict)
  # Never overwrite a name the platform already resolved (getChat title, via
  # the approval-card path) — that value is authoritative, --name here is only
  # a label supplied on the command line. Fill in only when the row has none.
  if [[ -n "$DISPLAY_NAME" && -z "$EXISTING_NAME" ]]; then
    update_args+=(--name "$DISPLAY_NAME")
  elif [[ -n "$EXISTING_NAME" ]]; then
    echo "              (keeping platform-resolved title '$EXISTING_NAME')"
  fi
  run "${update_args[@]}"
fi

# ── 3. Wiring (idempotent on messaging group + agent group) ──────────────────
echo "wiring      : $AGENT_GROUP <- $PLATFORM_ID"
run wirings create --messaging-group-id "$MG_ID" --agent-group-id "$AGENT_GROUP_ID" \
    --engage-mode pattern --engage-pattern '.' \
    --sender-scope all --ignored-message-policy drop --session-mode shared

# ── 4. Destination, so the agent can reply into the room ─────────────────────
# `wirings create` writes a companion destination named after the agent-group
# folder and projects it into live sessions. Check before adding: a duplicate
# --local-name would collide on (agent_group_id, local_name), and more
# importantly the announce step below must name the destination that actually
# exists — naming a phantom one is how replies get dropped as "unknown
# destination".
EXISTING_DEST="$(ncl destinations list --agent-group-id "$AGENT_GROUP_ID" --json |
  jq -r --arg t "$MG_ID" '.data[] | select(.target_type == "channel" and .target_id == $t) | .local_name' | head -1)"

if [[ -n "$EXISTING_DEST" ]]; then
  echo "destination : already present as '$EXISTING_DEST'"
  DEST_NAME="$EXISTING_DEST"
else
  echo "destination : adding '$DEST_NAME' -> $MG_ID"
  run destinations add --agent-group-id "$AGENT_GROUP_ID" --local-name "$DEST_NAME" \
      --target-type channel --target-id "$MG_ID"
fi

# ── 5. Tell the agent it has a room ──────────────────────────────────────────
# Deliberately last: the instruction only becomes true once the destination
# row exists. An agent told to send to a destination that isn't there yet gets
# "Unknown destination" and its reply is dropped silently.
#
# Target file differs by group: instructions.prepend.md is the provider-neutral
# standing-instructions file (inlined as the persona fragment at spawn),
# CLAUDE.local.md is picked up natively from the workspace. groups/<f>/CLAUDE.md
# is composed at spawn and must never be hand-edited.
if [[ $ANNOUNCE -eq 1 ]]; then
  GROUP_DIR="groups/$AGENT_GROUP"
  TARGET=""
  for candidate in "$GROUP_DIR/CLAUDE.local.md" "$GROUP_DIR/instructions.prepend.md"; do
    [[ -f "$candidate" ]] && { TARGET="$candidate"; break; }
  done

  if [[ -z "$TARGET" ]]; then
    echo "note        : no CLAUDE.local.md or instructions.prepend.md in $GROUP_DIR —"
    echo "              tell $AGENT_GROUP about destination '$DEST_NAME' by hand."
  elif grep -qF "$DEST_NAME" "$TARGET"; then
    echo "note        : $TARGET already mentions '$DEST_NAME'"
  elif [[ $DRY_RUN -eq 1 ]]; then
    echo "DRY-RUN  append routing note for '$DEST_NAME' to $TARGET"
  else
    printf '\n## Messaging routing\n\nDefault destination: `%s` — your own %s room, Brad <-> %s. Messages that arrive there are Brad talking to you directly; reply straight back to that destination rather than relaying through Zed.\n\nStill use `parent` (Zed) for anything outside your scope, and to report completion when Zed delegated the work.\n' \
      "$DEST_NAME" "$CHANNEL_TYPE" "$AGENT_GROUP" >> "$TARGET"
    echo "note        : appended routing note to $TARGET"
  fi
fi

echo "done."

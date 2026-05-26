#!/usr/bin/env bash
# Goal: determine the format and emission point of the conversation ID
# that maps to the `continuation` token in the AgentProvider interface.
#
# Note: the CLI uses ~/.gemini/antigravity-cli/ (NOT ~/.gemini/antigravity/
# which is the desktop app's directory). Conversations are tracked per
# working directory in cache/last_conversations.json.
set -euo pipefail

AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}"

CLI_DIR="$HOME/.gemini/antigravity-cli"
BRAIN_DIR="$CLI_DIR/brain"
CACHE_FILE="$CLI_DIR/cache/last_conversations.json"

BEFORE=$(ls "$BRAIN_DIR" 2>/dev/null | sort)
echo "=== Existing conversations: $(echo "$BEFORE" | wc -l | tr -d ' ') ==="

echo
echo "=== Single turn: capture all output ==="
WORK=$(mktemp -d)
cd "$WORK"
echo "Working dir: $WORK"
"$AGY_BIN" -p "Say hi in three words." --dangerously-skip-permissions 2>&1 | tee /tmp/agy-convid.log

echo
echo "=== Diff brain/ folder to find the new conversation id ==="
AFTER=$(ls "$BRAIN_DIR" 2>/dev/null | sort)
NEW_CONVS=$(comm -13 <(echo "$BEFORE") <(echo "$AFTER"))
echo "New conversation folders:"
echo "$NEW_CONVS"

echo
echo "=== last_conversations.json entry for $WORK ==="
grep -F "$WORK" "$CACHE_FILE" || echo "(not found)"

echo
echo "=== Second turn: resume by --conversation <id> ==="
if [ -n "$NEW_CONVS" ]; then
  FIRST=$(echo "$NEW_CONVS" | head -1)
  echo "Resuming $FIRST"
  "$AGY_BIN" -p "What did you just say?" \
    --conversation "$FIRST" \
    --dangerously-skip-permissions 2>&1 | tee /tmp/agy-resume.log
fi

echo
echo "=== Invalid conversation id probe ==="
"$AGY_BIN" -p "hello" --conversation "does-not-exist-12345" \
  --dangerously-skip-permissions 2>&1 | tee /tmp/agy-bad-conv.log || true

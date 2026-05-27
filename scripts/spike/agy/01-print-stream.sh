#!/usr/bin/env bash
# Goal: determine whether `agy -p` emits stdout incrementally during tool
# execution, or buffers everything until the final result. The host's
# idle-kill timer needs incremental events.
set -euo pipefail

AGY_BIN="${AGY_BIN:-$HOME/.local/bin/agy}"

# Use a workspace that forces tool calls.
WORK=$(mktemp -d)
echo "line one" > "$WORK/foo.txt"
echo "line two" >> "$WORK/foo.txt"

PROMPT="Read foo.txt in the current directory using your file tool, then list its lines back to me numbered."

echo "=== Run with timestamps on every output line ==="
# awk adds wallclock to each line. If gaps > 5s appear between the spawn and
# the final result, stdout is buffered.
cd "$WORK"
"$AGY_BIN" -p "$PROMPT" \
  --dangerously-skip-permissions \
  --print-timeout 5m 2>&1 \
  | while IFS= read -r line; do
      printf '[%s] %s\n' "$(date +%H:%M:%S.%N 2>/dev/null || date +%H:%M:%S)" "$line"
    done \
  | tee /tmp/agy-stream.log

echo
echo "=== Test 2: check for --output-format json / similar ==="
"$AGY_BIN" --help 2>&1 | grep -iE 'output|format|json|stream' || echo "no format flags surfaced"

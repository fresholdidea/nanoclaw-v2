#!/usr/bin/env bash
# One-shot: run `agy auth login` inside a throwaway container so the resulting
# token lands in the host's ~/.gemini/antigravity-cli/ (mounted) and persists
# for the cache agent container to use.
#
# Run from the repo root. Browser will open / a URL will be shown; complete
# OAuth, then come back here. Token file persists across runs.
set -euo pipefail

AGY_BIN="${AGY_BIN:-$(pwd)/scripts/spike/agy/cache/antigravity}"
GEMINI_DIR="${GEMINI_DIR:-$HOME/.gemini}"
# Use the nanoclaw agent image — it has ca-certificates installed (node:22-slim
# does not, which broke TLS verification against oauth2.googleapis.com).
IMAGE="${IMAGE:-$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^nanoclaw-agent-v2-[a-f0-9]+:latest$' | head -1)}"

if [ ! -x "$AGY_BIN" ]; then
  echo "agy linux binary not found at $AGY_BIN" >&2
  exit 1
fi
if [ ! -d "$GEMINI_DIR" ]; then
  echo "$GEMINI_DIR not found — run host agy once first" >&2
  exit 1
fi
if [ -z "$IMAGE" ]; then
  echo "No nanoclaw-agent-v2-*:latest image found. Run ./container/build.sh first." >&2
  exit 1
fi

echo "Launching agy auth login in a throwaway $IMAGE container."
echo "Token will write to: $GEMINI_DIR/antigravity-cli/"
echo

docker run --rm -it \
  -v "$GEMINI_DIR":/home/node/.gemini \
  -v "$AGY_BIN":/usr/local/bin/agy:ro \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/node \
  --entrypoint /usr/local/bin/agy \
  "$IMAGE" \
  auth login

echo
echo "Done. Token files now in:"
ls -la "$GEMINI_DIR/antigravity-cli/" | grep -iE "token|cred|auth|implicit" || true
echo
echo "Now kick the cache container so the next message respawns it:"
echo "  docker kill \$(docker ps -q --filter \"name=cache\")"

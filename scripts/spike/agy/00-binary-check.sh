#!/usr/bin/env bash
# Goal: determine if Google ships agy for linux/arm64 (Docker on Apple Silicon)
# and/or linux/amd64. Record findings, do NOT auto-download.
set -euo pipefail

echo "=== Host agy ==="
which agy || true
file "$(which agy)" 2>/dev/null || true
agy --help 2>&1 | head -5

echo
echo "=== Update channel hints ==="
agy update --help 2>&1 | head -30 || true

echo
echo "=== Install/changelog subcommands ==="
agy install --help 2>&1 | head -20 || true
agy changelog 2>&1 | head -20 || true

echo
echo "=== Look for an install script or download manifest ==="
strings "$(which agy)" 2>/dev/null | grep -iE 'download|release|cdn|linux|arm64|amd64' | head -20 || true

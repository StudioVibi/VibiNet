#!/usr/bin/env bash
set -euo pipefail

PATTERN='ws://net\.studiovibi\.com:8080'
TARGETS=("src" "walkers" "README.md")

if command -v rg >/dev/null 2>&1; then
  if rg -n "$PATTERN" "${TARGETS[@]}"; then
    echo
    echo "[FAIL] Deprecated official endpoint found."
    echo "Use wss://net.studiovibi.com or omit 'server' to use defaults."
    exit 1
  fi
else
  if grep -R -n -E "$PATTERN" "${TARGETS[@]}"; then
    echo
    echo "[FAIL] Deprecated official endpoint found."
    echo "Use wss://net.studiovibi.com or omit 'server' to use defaults."
    exit 1
  fi
fi

echo "[OK] Official endpoint check passed."

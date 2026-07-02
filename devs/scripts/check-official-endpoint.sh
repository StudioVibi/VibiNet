#!/usr/bin/env bash
set -euo pipefail

# Blocks the deprecated plaintext official endpoint from re-entering the
# codebase. Runs from anywhere (paths anchored to the repo root).

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

PATTERN='ws://net\.studiovibi\.com:8080'
# (AGENTS.md is excluded: it cites the deprecated endpoint in a rule.)
TARGETS=("vibinet-ts/src" "demo" "README.md" "TUTORIAL.md")

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

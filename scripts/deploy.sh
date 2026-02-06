#!/usr/bin/env bash
set -euo pipefail

# Manual deploy fallback.
# Recommended production flow is scripts/setup-auto-sync.sh + pushes to main.

REMOTE_HOST="vibi"
REMOTE_DIR="${REMOTE_DIR:-~/vibinet}"

echo "[DEPLOY] Syncing repo to ${REMOTE_HOST}:${REMOTE_DIR}"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.DS_Store' \
  ./ "${REMOTE_HOST}:${REMOTE_DIR}/"

echo "[DEPLOY] Restarting remote server"
ssh "${REMOTE_HOST}" bash -s <<'REMOTE_SH'
set -euo pipefail
REMOTE_DIR="${REMOTE_DIR:-$HOME/vibinet}"

# Ensure Bun in PATH if installed via $HOME/.bun
if ! command -v bun >/dev/null 2>&1; then
  if [ -d "$HOME/.bun/bin" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi

mkdir -p "$REMOTE_DIR"
cd "$REMOTE_DIR"

# Install deps and restart service
bun install
if sudo systemctl list-unit-files | grep -q '^vibinet\.service'; then
  sudo systemctl restart vibinet.service
  sudo systemctl status --no-pager --lines=20 vibinet.service
else
  if [ -f server.pid ]; then
    kill "$(cat server.pid)" 2>/dev/null || true
    rm -f server.pid
  fi
  pkill -f 'bun run src/server.ts' 2>/dev/null || true
  nohup bun run src/server.ts > server.log 2>&1 & echo $! > server.pid
  disown || true
  sleep 0.1
  echo "[DEPLOY] Server started (PID: $(cat server.pid))"
fi
REMOTE_SH

echo "[DEPLOY] Done"

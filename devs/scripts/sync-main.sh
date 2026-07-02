#!/usr/bin/env bash
set -euo pipefail

# Canonical production sync job (runs on the server, driven by
# vibinet-sync.timer): fast-forwards the repo to origin/main, reinstalls
# deps, and restarts vibinet.service when something changed.
# Deploy = push to main.

exec 9>/tmp/vibinet-sync-main.lock
if ! flock -n 9; then
  echo "[sync] another run is active; skipping"
  exit 0
fi

REPO_DIR="${REPO_DIR:-/home/ubuntu/vibinet}"
REPO_URL="${REPO_URL:-https://github.com/StudioVibi/VibiNet}"
BRANCH="${BRANCH:-main}"
BUN_BIN="${BUN_BIN:-/home/ubuntu/.bun/bin/bun}"
SERVICE="${SERVICE:-vibinet.service}"

if [ ! -d "$REPO_DIR" ]; then
  echo "[sync] repo dir not found: $REPO_DIR"
  exit 1
fi

cd "$REPO_DIR"

bootstrap_repo() {
  echo "[sync] bootstrapping git tracking for $REPO_URL ($BRANCH)"

  local data_backup
  data_backup="/tmp/vibinet-data-backup-$$"
  if [ -d "$REPO_DIR/data" ]; then
    rm -rf "$data_backup"
    cp -a "$REPO_DIR/data" "$data_backup"
  fi

  rm -rf .git
  git init -b "$BRANCH"
  git remote add origin "$REPO_URL"
  git fetch origin "$BRANCH"
  git clean -fdx -e data/
  git checkout -f -B "$BRANCH" "origin/$BRANCH"

  if [ -d "$data_backup" ]; then
    mkdir -p "$REPO_DIR/data"
    rsync -a "$data_backup/" "$REPO_DIR/data/"
    rm -rf "$data_backup"
  fi
}

if [ ! -d .git ] || ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  bootstrap_repo
else
  git remote set-url origin "$REPO_URL"
fi

git fetch origin "$BRANCH"
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "origin/$BRANCH")"

if [ "$local_head" = "$remote_head" ] && [ -z "$(git status --porcelain)" ]; then
  echo "[sync] up-to-date ($local_head)"
  exit 0
fi

echo "[sync] updating $local_head -> $remote_head"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
git clean -fdx -e data/

cd "$REPO_DIR/vibinet-ts"
if [ -x "$BUN_BIN" ]; then
  "$BUN_BIN" install --frozen-lockfile || "$BUN_BIN" install
else
  bun install --frozen-lockfile || bun install
fi
cd "$REPO_DIR"

if [ -x "$REPO_DIR/devs/scripts/check-official-endpoint.sh" ]; then
  bash "$REPO_DIR/devs/scripts/check-official-endpoint.sh"
fi

sudo -n systemctl restart "$SERVICE"
sudo -n systemctl is-active --quiet "$SERVICE"
echo "[sync] done"

#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-vibibr}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/vibinet}"
REPO_URL="${REPO_URL:-https://github.com/studiovibi/vibinet}"
BRANCH="${BRANCH:-main}"
SYNC_INTERVAL_SECONDS="${SYNC_INTERVAL_SECONDS:-45}"

echo "[AUTO-SYNC] Installing sync script and systemd units on ${REMOTE_HOST}"

ssh "${REMOTE_HOST}" \
  "REMOTE_DIR='${REMOTE_DIR}' REPO_URL='${REPO_URL}' BRANCH='${BRANCH}' SYNC_INTERVAL_SECONDS='${SYNC_INTERVAL_SECONDS}' bash -s" <<'REMOTE_SH'
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR}"
REPO_URL="${REPO_URL}"
BRANCH="${BRANCH}"
SYNC_INTERVAL_SECONDS="${SYNC_INTERVAL_SECONDS}"

mkdir -p "$REMOTE_DIR"

bootstrap_repo() {
  echo "[AUTO-SYNC] bootstrapping repository in $REMOTE_DIR"

  local db_backup
  db_backup="/tmp/vibinet-db-backup-$$"
  if [ -d "$REMOTE_DIR/db" ]; then
    rm -rf "$db_backup"
    cp -a "$REMOTE_DIR/db" "$db_backup"
  fi

  rm -rf "$REMOTE_DIR/.git"
  git -C "$REMOTE_DIR" init -b "$BRANCH"
  if git -C "$REMOTE_DIR" remote get-url origin >/dev/null 2>&1; then
    git -C "$REMOTE_DIR" remote set-url origin "$REPO_URL"
  else
    git -C "$REMOTE_DIR" remote add origin "$REPO_URL"
  fi
  git -C "$REMOTE_DIR" fetch origin "$BRANCH"
  git -C "$REMOTE_DIR" clean -fdx -e db/
  git -C "$REMOTE_DIR" checkout -f -B "$BRANCH" "origin/$BRANCH"

  if [ -d "$db_backup" ]; then
    mkdir -p "$REMOTE_DIR/db"
    rsync -a "$db_backup/" "$REMOTE_DIR/db/"
    rm -rf "$db_backup"
  fi
}

if [ ! -d "$REMOTE_DIR/.git" ]; then
  bootstrap_repo
else
  git -C "$REMOTE_DIR" remote set-url origin "$REPO_URL"
  git -C "$REMOTE_DIR" fetch origin "$BRANCH"
fi

if [ ! -f "$REMOTE_DIR/scripts/sync-main.sh" ]; then
  bootstrap_repo
fi

chmod +x "$REMOTE_DIR/scripts/sync-main.sh"

sudo tee /etc/systemd/system/vibinet-sync.service >/dev/null <<UNIT
[Unit]
Description=Sync VibiNet from GitHub ${BRANCH}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
Environment=REPO_DIR=${REMOTE_DIR}
Environment=REPO_URL=${REPO_URL}
Environment=BRANCH=${BRANCH}
Environment=BUN_BIN=/home/ubuntu/.bun/bin/bun
Environment=SERVICE=vibinet.service
ExecStart=/usr/bin/env bash ${REMOTE_DIR}/scripts/sync-main.sh
UNIT

sudo tee /etc/systemd/system/vibinet-sync.timer >/dev/null <<TIMER
[Unit]
Description=Run VibiNet GitHub sync on a schedule

[Timer]
OnBootSec=${SYNC_INTERVAL_SECONDS}s
OnUnitActiveSec=${SYNC_INTERVAL_SECONDS}s
RandomizedDelaySec=5s
Persistent=true
Unit=vibinet-sync.service

[Install]
WantedBy=timers.target
TIMER

sudo systemctl daemon-reload
sudo systemctl enable --now vibinet-sync.timer
sudo systemctl start vibinet-sync.service
sudo systemctl status --no-pager --lines=30 vibinet-sync.service || true
sudo systemctl status --no-pager --lines=20 vibinet-sync.timer
REMOTE_SH

echo "[AUTO-SYNC] Done"

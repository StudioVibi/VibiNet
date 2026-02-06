#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-vibi}"
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

sudo tee /usr/local/bin/vibinet-sync-main.sh >/dev/null <<'SYNC'
#!/usr/bin/env bash
set -euo pipefail

exec 9>/tmp/vibinet-sync-main.lock
if ! flock -n 9; then
  echo "[sync] another run is active; skipping"
  exit 0
fi

REPO_DIR="${REPO_DIR:-/home/ubuntu/vibinet}"
REPO_URL="${REPO_URL:-https://github.com/studiovibi/vibinet}"
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

  local db_backup
  db_backup="/tmp/vibinet-db-backup-$$"
  if [ -d "$REPO_DIR/db" ]; then
    rm -rf "$db_backup"
    cp -a "$REPO_DIR/db" "$db_backup"
  fi

  rm -rf .git
  git init -b "$BRANCH"
  git remote add origin "$REPO_URL"
  git fetch origin "$BRANCH"
  git clean -fdx -e db/
  git checkout -f -B "$BRANCH" "origin/$BRANCH"

  if [ -d "$db_backup" ]; then
    mkdir -p "$REPO_DIR/db"
    rsync -a "$db_backup/" "$REPO_DIR/db/"
    rm -rf "$db_backup"
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
git clean -fdx -e db/

if [ -x "$BUN_BIN" ]; then
  "$BUN_BIN" install --frozen-lockfile || "$BUN_BIN" install
else
  bun install --frozen-lockfile || bun install
fi

if [ -x "$REPO_DIR/scripts/check-official-endpoint.sh" ]; then
  bash "$REPO_DIR/scripts/check-official-endpoint.sh"
fi

sudo -n systemctl restart "$SERVICE"
sudo -n systemctl is-active --quiet "$SERVICE"
echo "[sync] done"
SYNC

sudo chmod +x /usr/local/bin/vibinet-sync-main.sh

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
ExecStart=/usr/local/bin/vibinet-sync-main.sh
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

#!/usr/bin/env bash
set -euo pipefail

# Provision a fresh Ubuntu 24.04 box as a VibiNet production server:
# bun + caddy (auto-TLS) + vibinet.service + GitHub auto-sync units.
#
# Usage:
#   devs/scripts/provision.sh <ssh-target>       # e.g. ubuntu@54.207.112.112
#   SSH_OPTS="-i ~/.ssh/key.pem" devs/scripts/provision.sh <ssh-target>
#
# Env:
#   DOMAIN   (default net.studiovibi.com)  domain caddy serves TLS for
#   REPO_URL (default StudioVibi/VibiNet)  repo the server runs and syncs
#   BRANCH   (default main)
#
# Idempotent: safe to re-run on an already provisioned box.
#
# Creating the machine itself (AWS example, sa-east-1):
#   aws ec2 create-key-pair --key-name vibinet --key-type ed25519 \
#     --query KeyMaterial --output text > ~/.ssh/vibinet_aws.pem
#   aws ec2 create-security-group --group-name vibinet --description "vibinet" \
#     --vpc-id <default-vpc>                      # then open tcp 22/80/443
#   aws ec2 run-instances --image-id <ubuntu-24.04-arm64-ami> \
#     --instance-type t4g.small --key-name vibinet \
#     --security-group-ids <sg> ...
#   aws ec2 allocate-address + associate-address  # stable IP, point DNS at it

TARGET="${1:?usage: provision.sh <ssh-target>}"
SSH_OPTS="${SSH_OPTS:-}"
DOMAIN="${DOMAIN:-net.studiovibi.com}"
REPO_URL="${REPO_URL:-https://github.com/StudioVibi/VibiNet}"
BRANCH="${BRANCH:-main}"

echo "[PROVISION] target=$TARGET domain=$DOMAIN repo=$REPO_URL branch=$BRANCH"

# shellcheck disable=SC2086
ssh $SSH_OPTS "$TARGET" \
  "DOMAIN='$DOMAIN' REPO_URL='$REPO_URL' BRANCH='$BRANCH' bash -s" <<'REMOTE_SH'
set -euo pipefail

REPO_DIR="$HOME/vibinet"
BUN_BIN="$HOME/.bun/bin/bun"

echo "[1/6] system packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
  git curl unzip rsync debian-keyring debian-archive-keyring apt-transport-https

echo "[2/6] bun"
if [ ! -x "$BUN_BIN" ]; then
  curl -fsSL https://bun.sh/install | bash
fi
"$BUN_BIN" --version

echo "[3/6] caddy (TLS reverse proxy)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -q
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q caddy
fi

sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
	reverse_proxy 127.0.0.1:8080
}
CADDY
sudo systemctl enable --now caddy
sudo systemctl reload caddy

echo "[4/6] repository"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git remote set-url origin "$REPO_URL"
git fetch origin "$BRANCH"
git checkout -f -B "$BRANCH" "origin/$BRANCH"
cd "$REPO_DIR/vibinet-ts"
"$BUN_BIN" install --frozen-lockfile || "$BUN_BIN" install
cd "$REPO_DIR"

echo "[5/6] vibinet.service"
sudo tee /etc/systemd/system/vibinet.service >/dev/null <<UNIT
[Unit]
Description=VibiNet game networking server
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
Group=$USER
WorkingDirectory=$REPO_DIR
Environment=HOST=127.0.0.1
Environment=PORT=8080
ExecStart=$BUN_BIN run vibinet-ts/src/server.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now vibinet.service
sudo systemctl restart vibinet.service

echo "[6/6] auto-sync units (deploy = push to $BRANCH)"
chmod +x "$REPO_DIR/devs/scripts/sync-main.sh"
sudo tee /etc/systemd/system/vibinet-sync.service >/dev/null <<UNIT
[Unit]
Description=Sync VibiNet from GitHub $BRANCH
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER
Group=$USER
Environment=REPO_DIR=$REPO_DIR
Environment=REPO_URL=$REPO_URL
Environment=BRANCH=$BRANCH
Environment=BUN_BIN=$BUN_BIN
Environment=SERVICE=vibinet.service
ExecStart=/usr/bin/env bash $REPO_DIR/devs/scripts/sync-main.sh
UNIT

sudo tee /etc/systemd/system/vibinet-sync.timer >/dev/null <<TIMER
[Unit]
Description=Run VibiNet GitHub sync on a schedule

[Timer]
OnBootSec=45s
OnUnitActiveSec=45s
RandomizedDelaySec=5s
Persistent=true
Unit=vibinet-sync.service

[Install]
WantedBy=timers.target
TIMER

sudo systemctl daemon-reload
sudo systemctl enable --now vibinet-sync.timer

sleep 1
sudo systemctl is-active vibinet.service caddy.service vibinet-sync.timer
echo "[PROVISION] done: $(git -C "$REPO_DIR" rev-parse --short HEAD) on $(hostname)"
REMOTE_SH

echo "[PROVISION] OK"

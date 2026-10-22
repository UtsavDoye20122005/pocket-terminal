#!/bin/bash
# Pocket Terminal relay: one-shot setup for an Oracle Cloud "Always Free" Ubuntu VM.
# Paste this whole file into: Create instance → Show advanced options → Management →
# "Paste cloud-init script". It runs once, by itself, on first boot (~5 minutes).
#
# What it sets up:
#   Node.js        runs the relay
#   Caddy          free HTTPS certificate + forwards traffic to the relay
#   sslip.io name  a free web address made from your server's IP (1.2.3.4 → 1-2-3-4.sslip.io)
#   systemd        keeps the relay running and restarts it if it crashes
#   auto-update    every 10 min it pulls your GitHub repo; push code → server updates itself
set -euxo pipefail
exec > >(tee -a /var/log/pocket-terminal-setup.log) 2>&1

REPO="__REPO__"
APP_PASSWORD_HASH='__HASH__'
AGENT_TOKEN='__TOKEN__'

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (automatic HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# App user + code
id pocket >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin pocket
git clone "$REPO" /opt/pocket-terminal || (cd /opt/pocket-terminal && git pull)
chown -R pocket:pocket /opt/pocket-terminal
sudo -u pocket bash -c 'cd /opt/pocket-terminal/relay && npm ci --omit=dev --no-audit --no-fund'
mkdir -p /var/lib/pocket-terminal && chown pocket:pocket /var/lib/pocket-terminal && chmod 700 /var/lib/pocket-terminal

# Secrets (only root and the app can read them)
mkdir -p /etc/pocket-terminal
cat > /etc/pocket-terminal/env <<ENV
APP_PASSWORD_HASH=$APP_PASSWORD_HASH
AGENT_TOKEN=$AGENT_TOKEN
PORT=8080
HOST=127.0.0.1
DATA_DIR=/var/lib/pocket-terminal
ENV
chown root:pocket /etc/pocket-terminal/env && chmod 640 /etc/pocket-terminal/env

cat > /etc/systemd/system/pocket-relay.service <<'UNIT'
[Unit]
Description=Pocket Terminal relay
After=network-online.target
Wants=network-online.target

[Service]
User=pocket
WorkingDirectory=/opt/pocket-terminal/relay
EnvironmentFile=/etc/pocket-terminal/env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/pocket-terminal
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# Auto-update from GitHub every 10 minutes
cat > /usr/local/bin/pocket-update <<'UPD'
#!/bin/bash
set -e
cd /opt/pocket-terminal
before=$(sudo -u pocket git rev-parse HEAD)
sudo -u pocket git pull --ff-only -q
after=$(sudo -u pocket git rev-parse HEAD)
if [ "$before" != "$after" ]; then
  sudo -u pocket bash -c 'cd relay && npm ci --omit=dev --no-audit --no-fund'
  systemctl restart pocket-relay
  echo "updated to $after"
fi
UPD
chmod 755 /usr/local/bin/pocket-update
cat > /etc/systemd/system/pocket-update.service <<'UNIT'
[Unit]
Description=Pull latest Pocket Terminal code
[Service]
Type=oneshot
ExecStart=/usr/local/bin/pocket-update
UNIT
cat > /etc/systemd/system/pocket-update.timer <<'UNIT'
[Unit]
Description=Check GitHub for Pocket Terminal updates
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
UNIT

# Open ports 80/443 in the server's own firewall (Oracle's Ubuntu blocks them by default)
N=$(iptables -L INPUT --line-numbers -n | awk '/REJECT/{print $1; exit}')
for PORT in 443 80; do
  if [ -n "$N" ]; then iptables -I INPUT "$N" -m state --state NEW -p tcp --dport $PORT -j ACCEPT
  else iptables -A INPUT -m state --state NEW -p tcp --dport $PORT -j ACCEPT; fi
done
netfilter-persistent save

# Web address + HTTPS
IP=$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)
DOMAIN="${IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
CADDY
echo "$DOMAIN" > /etc/pocket-terminal/domain

systemctl daemon-reload
systemctl enable --now pocket-relay pocket-update.timer
systemctl restart caddy
echo "Pocket Terminal relay ready at https://$DOMAIN"

#!/bin/bash
# Local mode installer: runs everything on this Mac, no outside server.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="com.pocketterminal.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.pocket-terminal/local.log"

NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "Install Node.js first: https://nodejs.org (LTS). Then run this again."; exit 1; }

# The cloud version and local mode should not run at the same time.
launchctl bootout "gui/$(id -u)/com.pocketterminal.agent" 2>/dev/null || true

echo "==> Installing packages"
(cd relay && npm install --omit=dev --no-fund --no-audit)
(cd agent && npm install --omit=dev --no-fund --no-audit)

if [ ! -f "$HOME/.pocket-terminal/local.json" ]; then
  echo "==> Choose the password you'll type on your phone"
  node local/start.js --setup
fi

echo "==> Starting now and at every login"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.pocket-terminal"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/local/start.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
if curl -s -o /dev/null http://127.0.0.1:$(node -e "console.log(require('$HOME/.pocket-terminal/local.json').port)")/healthz; then
  echo
  echo "Running. Open one of these on your phone:"
  node local/start.js --urls | sed 's/^/  /'
  echo
  echo "If macOS asks whether 'node' can accept incoming connections, click Allow."
else
  echo "Did not start. See: $LOG"; exit 1
fi

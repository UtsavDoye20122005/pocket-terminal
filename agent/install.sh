#!/bin/bash
# Pocket Terminal: Mac installer. Safe to run again any time.
#
# It will:
#   1. install the agent's packages
#   2. ask for your phone password and make a secret token for this Mac
#   3. let the power brain control sleep (asks for your Mac password once)
#   4. write the Oracle server setup script and copy it to your clipboard
#   5. connect to your Oracle server and start the agent at every login
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
HOME_DIR="$HOME/.pocket-terminal"
LABEL="com.pocketterminal.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME_DIR/agent.log"
step() { printf "\n\033[1;34m[%s]\033[0m %s\n" "$1" "$2"; }

NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "Install Node.js first: https://nodejs.org (LTS). Then run this again."; exit 1; }
mkdir -p "$HOME_DIR"; chmod 700 "$HOME_DIR"

# Only one version should run. Stop older ones.
for old in com.pocketterm.server com.pocketterminal.local; do
  launchctl bootout "gui/$(id -u)/$old" 2>/dev/null || true
done

step 1/5 "Installing packages"
npm install --omit=dev --no-fund --no-audit --silent

step 2/5 "Phone password and Mac token"
node setup.js secrets

step 3/5 "Letting the power brain manage sleep"
SUDOERS=/etc/sudoers.d/pocket-terminal
ME="$(whoami)"
RULE="$ME ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset schedule wake *, /usr/bin/pmset schedule cancel wake *"
if [ ! -f "$SUDOERS" ]; then
  echo "macOS needs your Mac login password once, so the agent can switch lid-sleep on/off"
  echo "and set wake-up alarms. It can ONLY run those exact pmset commands, nothing else."
  TMP="$(mktemp)"; echo "$RULE" > "$TMP"
  sudo visudo -cf "$TMP" >/dev/null
  sudo install -m 0440 -o root -g wheel "$TMP" "$SUDOERS"
  rm -f "$TMP"
  # Keep Wi-Fi connections alive through short sleeps.
  sudo pmset -a tcpkeepalive 1
fi
sudo -n /usr/bin/pmset -a disablesleep 0 && echo "Power control ready ✅"

step 4/5 "Oracle server setup script"
REPO_FILE="$HOME_DIR/repo"
DEFAULT_REPO="$(cat "$REPO_FILE" 2>/dev/null || echo "https://github.com/UtsavDoye20122005/pocket-terminal")"
read -r -p "Your GitHub repo URL [Enter = $DEFAULT_REPO]: " REPO
REPO="${REPO:-$DEFAULT_REPO}"; echo "$REPO" > "$REPO_FILE"
CI="$(node setup.js cloud-init "$REPO")"
pbcopy < "$CI"
echo "Saved to $CI and copied to your clipboard 📋"
echo "Paste it into Oracle: Create instance → Show advanced options → Management → Paste cloud-init script."

step 5/5 "Connect to your server"
set +e; node setup.js relay; RC=$?; set -e
if [ $RC -eq 3 ]; then
  echo; echo "Next: create the Oracle server (see README), then run this installer again."; exit 0
fi
[ $RC -ne 0 ] && exit $RC

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/agent.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 4
echo; tail -n 4 "$LOG" || true
if grep -q "connected to relay" "$LOG" 2>/dev/null; then
  echo; echo "✅ All set. Open $(node -e "console.log(require('$HOME_DIR/agent.json').relay)") on your phone."
else
  echo; echo "Agent is running but not connected yet. If your server was just created, wait 5 minutes."
  echo "Watch it with:  tail -f $LOG"
fi

#!/bin/bash
# Pocket Terminal: Mac installer. Safe to run again any time.
#
#   1. installs the agent's packages
#   2. lets the power brain manage sleep (asks for your Mac password once)
#   3. starts the agent now and at every login
#   4. shows a QR code: scan it with your phone to pair
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"
HOME_DIR="$HOME/.pocket-terminal"
LABEL="com.pocketterminal.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME_DIR/agent.log"
step() { printf "\n\033[1;34m[%s]\033[0m %s\n" "$1" "$2"; }

[ "$(uname)" = "Darwin" ] || { echo "Pocket Terminal's agent runs on macOS."; exit 1; }
NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "Install Node.js 18.20+ first: https://nodejs.org (LTS). Then run this again."; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=20)?0:1)' \
  || { echo "Your Node.js is too old ($("$NODE" -v)). Install the LTS from https://nodejs.org"; exit 1; }
mkdir -p "$HOME_DIR"; chmod 700 "$HOME_DIR"

# Older Pocket Terminal versions: stop them so only one runs.
for old in com.pocketterm.server com.pocketterminal.local; do
  launchctl bootout "gui/$(id -u)/$old" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$old.plist"
done

step 1/4 "Installing packages"
npm install --omit=dev --no-fund --no-audit --loglevel=error

step 2/4 "Letting the power brain manage sleep"
SUDOERS=/etc/sudoers.d/pocket-terminal
if [ ! -f "$SUDOERS" ]; then
  echo "macOS needs your Mac login password once, so the agent can keep the Mac awake with"
  echo "the lid closed and set wake-up alarms. It can ONLY run these 4 exact commands:"
  echo "  pmset -a disablesleep 0|1   and   pmset schedule [cancel] wake <time>"
  RULE="$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset schedule wake *, /usr/bin/pmset schedule cancel wake *"
  TMP="$(mktemp)"; echo "$RULE" > "$TMP"
  sudo visudo -cf "$TMP" >/dev/null
  sudo install -m 0440 -o root -g wheel "$TMP" "$SUDOERS"
  rm -f "$TMP"
  sudo pmset -a tcpkeepalive 1   # keep Wi-Fi links alive through short sleeps
fi
sudo -n /usr/bin/pmset -a disablesleep 0 && echo "Power control ready ✅"

step 3/4 "Pairing key"
# The original repo uses the official app (pocket-terminal.vercel.app).
# If you forked it, your phone app lives on YOUR GitHub Pages. Use it automatically.
APP_ARGS=()
ORIGIN="$(git -C "$DIR/.." remote get-url origin 2>/dev/null || true)"
if [[ "$ORIGIN" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]] && [[ ! "$ORIGIN" =~ [Uu]tsav[Dd]oye20122005/pocket-terminal ]]; then
  OWNER="$(echo "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"; REPO="${BASH_REMATCH[2]}"
  APP_ARGS=(--app-url "https://$OWNER.github.io/$REPO/")
fi
"$NODE" pair.js --list "${APP_ARGS[@]}" >/dev/null   # saves the settings; pairing comes at the end

step 4/4 "Starting the agent now and at every login"
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
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
if grep -q "mailbox ready" "$LOG" 2>/dev/null; then echo "Agent running ✅"; else echo "Agent started. If something's off, see: $LOG"; fi

echo
"$NODE" pair.js

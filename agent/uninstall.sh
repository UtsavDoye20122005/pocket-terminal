#!/bin/bash
# Removes Pocket Terminal from this Mac and puts sleep back to normal.
#   bash uninstall.sh          keep your pairing key (~/.pocket-terminal) for later
#   bash uninstall.sh --purge  delete the key too (every paired phone stops working)
LABEL="com.pocketterminal.agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
sudo /usr/bin/pmset -a disablesleep 0
sudo rm -f /etc/sudoers.d/pocket-terminal
if [ "$1" = "--purge" ]; then rm -rf "$HOME/.pocket-terminal"; echo "Pairing key deleted."; fi
echo "Pocket Terminal removed. Closing the lid puts the Mac to sleep normally again."

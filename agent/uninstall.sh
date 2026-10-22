#!/bin/bash
# Stops the agent, removes it from login, and puts Mac sleep back to normal.
# Your secrets stay in ~/.pocket-terminal (delete that folder to remove everything).
LABEL="com.pocketterminal.agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
sudo /usr/bin/pmset -a disablesleep 0
sudo rm -f /etc/sudoers.d/pocket-terminal
echo "Agent removed. Closing the lid puts the Mac to sleep normally again."

#!/bin/bash
LABEL="com.pocketterminal.local"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Local mode stopped and removed from login."

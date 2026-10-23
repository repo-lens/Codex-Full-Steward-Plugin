#!/bin/bash
set -euo pipefail

DEST="$HOME/.config/Codex++/user_scripts/codex-429-guardian.js"
launchctl bootout "gui/$(id -u)/codex.guardian.steward" >/dev/null 2>&1 || launchctl remove codex.guardian.steward >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/codex.guardian.llm-proxy" >/dev/null 2>&1 || launchctl remove codex.guardian.llm-proxy >/dev/null 2>&1 || true
rm -f "$DEST"
rm -f "$HOME/Library/LaunchAgents/codex.guardian.steward.plist"
rm -f "$HOME/Library/LaunchAgents/codex.guardian.llm-proxy.plist"
security delete-generic-password -s codex-guardian -a primary >/dev/null 2>&1 || true
security delete-generic-password -s codex-guardian -a backup >/dev/null 2>&1 || true
echo "已卸载：$DEST"
echo "请在 Codex 窗口按 Command+R 重载一次。"

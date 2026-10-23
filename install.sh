#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.config/Codex++/user_scripts"
DEST="$DEST_DIR/codex-429-guardian.js"
NODE_BIN="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
PLIST_SRC="$ROOT/resources/steward-daemon.plist"
PLIST_DST="$HOME/Library/LaunchAgents/codex.guardian.steward.plist"

mkdir -p "$DEST_DIR" "$HOME/Library/LaunchAgents"
cp "$ROOT/guardian.js" "$DEST"
sed -e "s#__SCRIPTS_DIR__#$ROOT/scripts#g" -e "s#__REPO_DIR__#$ROOT#g" "$PLIST_SRC" > "$PLIST_DST"
launchctl bootout "gui/$(id -u)/codex.guardian.steward" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" >/dev/null 2>&1 || launchctl load -w "$PLIST_DST"
launchctl kickstart -k "gui/$(id -u)/codex.guardian.steward" >/dev/null 2>&1 || true
echo "已安装：$DEST"
echo "已安装 steward：$PLIST_DST"
echo "请在 Codex 窗口按 Command+R 重载一次。"

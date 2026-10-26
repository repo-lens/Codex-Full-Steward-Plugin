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
# v2.1.2：bootout 是异步的，立即 bootstrap 可能失败；失败后再回退 load 并重试。
launchctl bootout "gui/$(id -u)/codex.guardian.steward" >/dev/null 2>&1 || true
sleep 1
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" >/dev/null 2>&1; then
  launchctl load -w "$PLIST_DST" >/dev/null 2>&1 || true
fi
launchctl kickstart -k "gui/$(id -u)/codex.guardian.steward" >/dev/null 2>&1 || true
sleep 1
if ! launchctl list | grep -q "codex.guardian.steward"; then
  launchctl load -w "$PLIST_DST" >/dev/null 2>&1 || true
  sleep 1
fi
if launchctl list | grep -q "codex.guardian.steward"; then
  echo "steward 守护：已运行"
else
  echo "steward 守护：未启动，请手动跑 launchctl bootstrap gui/$(id -u) $PLIST_DST"
fi
echo "已安装：$DEST"
echo "已安装 steward：$PLIST_DST"
echo "请在 Codex 窗口按 Command+R 重载一次。"

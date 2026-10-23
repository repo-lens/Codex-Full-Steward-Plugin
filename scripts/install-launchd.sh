#!/bin/bash
# 安装本地 LLM CORS 代理为 macOS LaunchAgent（开机自启 + 崩了自愈）。
# launchd 直接跑 node 代理（node 进程就是 launchd job，KeepAlive 才真正生效），
# 不再用 shell+nohup 包一层（那种 launchd 收不到子进程退出，不会自愈）。
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPTS_DIR}/.." && pwd)"
NODE_BIN="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
PORT="8443"
PLIST_SRC="${REPO_DIR}/resources/llm-proxy.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/codex.guardian.llm-proxy.plist"

# 渲染模板占位符
sed -e "s#__SCRIPTS_DIR__#${SCRIPTS_DIR}#" \
    -e "s#__REPO_DIR__#${REPO_DIR}#" \
    "${PLIST_SRC}" > "${PLIST_DST}"
echo "已写入：${PLIST_DST}"

# 重新加载（先卸后载，幂等）
launchctl remove codex.guardian.llm-proxy 2>/dev/null || true
launchctl load -w "${PLIST_DST}"
sleep 2

if lsof -nP -i "tcp:${PORT}" >/dev/null 2>&1; then
  echo "✅ 代理已在 ${PORT} 监听，launchd 管理（开机自启 + 崩了 5s 内自愈）"
else
  echo "❌ 端口 ${PORT} 未监听，看 /tmp/llm-proxy-${PORT}.stderr.log"
fi
echo "手动停止：launchctl remove codex.guardian.llm-proxy"

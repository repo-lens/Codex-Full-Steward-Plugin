#!/bin/bash
# 启动本地 LLM CORS 代理（HTTPS，供 codex-429-guardian 管家模式调用 LLM 供应商）。
# 用法：bash scripts/launch-proxy.sh [端口]   默认 8443（HTTPS）
# 幂等：已在跑就复用；否则后台起（脱离父进程，终端断开不带走）。
set -euo pipefail

PORT="${1:-8443}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
LOG="/tmp/llm-proxy-${PORT}.log"

# 端口已在监听就复用
if lsof -i "tcp:${PORT}" >/dev/null 2>&1; then
  echo "代理已在 ${PORT} 监听，复用"
  exit 0
fi

# 杀旧（避免半死进程占端口）
pkill -f "llm-proxy.mjs ${PORT}" 2>/dev/null || true
sleep 1

# 证书存在性检查
if [ ! -f "${SCRIPT_DIR}/../resources/cert/llm-proxy.crt" ]; then
  echo "❌ 缺自签证书，先生成："
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "${SCRIPT_DIR}/../resources/cert/llm-proxy.key" \
    -out "${SCRIPT_DIR}/../resources/cert/llm-proxy.crt" \
    -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1,IP:0.0.0.0,DNS:localhost"
fi

nohup "${NODE_BIN}" "${SCRIPT_DIR}/llm-proxy.mjs" "${PORT}" > "${LOG}" 2>&1 < /dev/null &
sleep 1
echo "已启动 HTTPS llm-proxy（端口 ${PORT}），日志：${LOG}"
echo "首次使用需在钥匙串里信任证书：open ${SCRIPT_DIR}/../resources/cert/llm-proxy.crt  → 信任 → 始终信任"

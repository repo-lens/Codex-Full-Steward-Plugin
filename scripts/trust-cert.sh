#!/bin/bash
# 一次把 llm-proxy 自签证书标记为系统信任（让安全上下文里的 Codex 页面能 fetch https://127.0.0.1:8443）。
# 命令行 security add-trusted-cert 报 "One or more parameters ... not valid"，
# 真正生效的是钥匙串 App 的 GUI 信任对话框。本脚本把它做成一次完成：
#   1. 打开钥匙串 App 并选中登录钥匙串里的 127.0.0.1 证书
#   2. 你只需：双击该证书 → 信任 → 「使用此证书时」选「始终信任」→ 关窗输登录密码
set -euo pipefail

CERT_CRT="${HOME}/Library/Keychains/llm-proxy.crt"
REPO_CERT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/resources/cert/llm-proxy.crt"
LOGIN_KC="${HOME}/Library/Keychains/login.keychain-db"

# 确保证书在登录钥匙串（幂等）
if ! security find-certificate -a -c "127.0.0.1" "$LOGIN_KC" >/dev/null 2>&1; then
  cp "$REPO_CERT" "$CERT_CRT" 2>/dev/null || true
  security import "$REPO_CERT" -k "$LOGIN_KC" >/dev/null 2>&1 || true
fi

echo "证书已就绪在登录钥匙串。现在打开钥匙串 App 并定位到它："
# 打开钥匙串 App（若未开）
open -a "Keychain Access" "$LOGIN_KC" 2>/dev/null || open -a "Keychain Access"

cat <<'HINT'

接下来你只需 3 下（全程在钥匙串 App 里，无需再跑命令）：
  1. 左侧「登录」→ 顶部「证书」→ 找到 127.0.0.1（CN=127.0.0.1）
  2. 双击它 → 展开「信任」→ 「使用此证书时」选「始终信任」→ 关窗
  3. 输入 macOS 登录密码确认
完成后在 Codex 窗口按一次 Command+R，再点管家窗口「▶ 触发审核」即通。
HINT

#!/bin/sh
# kimi-purge 一键安装（macOS/Linux）
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo '未找到 node —— kimi-purge 需要 Node.js 18+（内置 fetch）。请先安装：https://nodejs.org/' >&2; exit 1; }
echo '== kimi-purge 安装 =='
node "$ROOT/scripts/kimi-purge.mjs" install
echo ''
echo '引擎补丁（apply）需要 Kimi Code 已完全退出。'
printf '现在应用引擎补丁吗？(y/N) '
read ans
if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  node "$ROOT/scripts/kimi-purge.mjs" apply
  echo '完成。重启 Kimi Code 后生效，会话里说 "purge probe" 验证。'
else
  echo '跳过。之后运行: node scripts/kimi-purge.mjs apply（先退出 Kimi Code）'
fi

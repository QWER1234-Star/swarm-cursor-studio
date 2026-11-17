#!/usr/bin/env bash
# macOS / Linux 启动脚本：双击或用 ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js，先装一个：https://nodejs.org"
  read -r -p "按回车关闭…" _
  exit 1
fi
node server.js

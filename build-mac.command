#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22.12 或更高版本。"
  exit 1
fi

case "$(uname -m)" in
  arm64) ELECTRON_ARCH="arm64" ;;
  x86_64) ELECTRON_ARCH="x64" ;;
  *) echo "不支持的 Mac 架构：$(uname -m)"; exit 1 ;;
esac

echo "正在安装依赖并构建 Mac ${ELECTRON_ARCH} 版本……"
npm ci
npm run build
npx electron-builder --mac dmg zip --"$ELECTRON_ARCH" --publish never

echo "构建完成，安装包位于：$PROJECT_DIR/release"

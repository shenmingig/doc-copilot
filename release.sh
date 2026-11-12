#!/bin/bash
# ============================================================
# Doc Copilot — 一键编译打包脚本
# 用法: bash release.sh
# ============================================================
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# ---------- 从 package.json 读取版本号 ----------
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
ZIP_NAME="doc-copilot-v${VERSION}-chrome.zip"

echo ""
echo "============================================"
echo "  Doc Copilot v${VERSION} — 一键编译打包"
echo "============================================"
echo ""
export https_proxy=http://agent.baidu.com:8891
export http_proxy=http://agent.baidu.com:8891

# ---------- 1. 检查 & 安装依赖 ----------
echo "📦 [1/4] 检查依赖..."
if [ ! -d "node_modules" ] || [ ! -f "node_modules/vite/bin/vite.js" ]; then
    echo "  → node_modules 不存在，执行 pnpm install ..."
    if ! command -v pnpm &>/dev/null; then
        echo "  ❌ 未安装 pnpm，请先执行: npm install -g pnpm"
        exit 1
    fi
    pnpm install
else
    echo "  → 依赖已就绪，跳过安装"
fi

# ---------- 2. 清理旧产物 ----------
echo ""
echo "🧹 [2/4] 清理旧构建产物..."
rm -rf dist
echo "  → dist/ 已清理"

# ---------- 3. 三阶段构建 ----------
echo ""
echo "🔨 [3/4] 编译 TypeScript → IIFE ..."

echo "  → [3a/3] content script ..."
BUILD_TARGET=content npx vite build --logLevel warn

echo "  → [3b/3] background service worker ..."
BUILD_TARGET=background npx vite build --logLevel warn

echo "  → [3c/3] popup + static files ..."
BUILD_TARGET=popup npx vite build --logLevel warn

# ---------- 校验构建产物 ----------
EXPECTED_FILES=("dist/content.js" "dist/background.js" "dist/popup.js" "dist/popup.html" "dist/manifest.json")
MISSING=0
for f in "${EXPECTED_FILES[@]}"; do
    if [ ! -f "$f" ]; then
        echo "  ❌ 缺失: $f"
        MISSING=1
    fi
done
if [ "$MISSING" -eq 1 ]; then
    echo ""
    echo "❌ 构建产物不完整，终止打包"
    exit 1
fi

echo ""
echo "  📁 构建产物:"
find dist -type f | sort | while read -r f; do
    size=$(wc -c < "$f")
    printf "     %-35s %'8d bytes\n" "$f" "$size"
done

# ---------- 4. 打包 zip ----------
echo ""
echo "📦 [4/4] 打包 → ${ZIP_NAME} ..."
rm -f "$ZIP_NAME"
cd dist && zip -r -q "../${ZIP_NAME}" . && cd ..

ZIP_SIZE=$(wc -c < "$ZIP_NAME")
echo "  → 完成: ${ZIP_NAME} ($(echo "$ZIP_SIZE" | awk '{printf "%\047d", $1}') bytes)"

# ---------- 完成 ----------
echo ""
echo "============================================"
echo "  ✅ 全部完成！"
echo "============================================"
echo ""
echo "  产物目录:  ${ROOT_DIR}/dist/"
echo "  安装包:    ${ROOT_DIR}/${ZIP_NAME}"
echo ""
echo "  加载到 Chrome:"
echo "    1. 打开 chrome://extensions"
echo "    2. 开启「开发者模式」"
echo "    3. 点击「加载已解压的扩展程序」"
echo "    4. 选择 dist/ 文件夹"
echo ""

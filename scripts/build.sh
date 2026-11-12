#!/bin/bash
# Build all Chrome extension targets as self-contained IIFE bundles
set -e

echo "🔨 Building Doc Copilot Chrome Extension..."

echo "  [1/4] Building content script..."
BUILD_TARGET=content npx vite build

echo "  [2/4] Building background service worker..."
BUILD_TARGET=background npx vite build

echo "  [3/4] Building offscreen clipboard document..."
BUILD_TARGET=offscreen npx vite build

echo "  [4/4] Building popup + copying static files..."
BUILD_TARGET=popup npx vite build

echo ""
echo "✅ Build complete! Output in dist/"
echo ""
echo "To load in Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Enable Developer Mode"
echo "  3. Click 'Load unpacked'"
echo "  4. Select the dist/ folder"
echo ""

# Verify output
echo "📁 Files:"
find dist -type f -name '*.js' -o -name '*.html' -o -name '*.json' | sort | while read f; do
  size=$(wc -c < "$f")
  echo "   $(printf '%-30s %6s bytes' "$f" "$size")"
done

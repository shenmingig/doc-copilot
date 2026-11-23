#!/usr/bin/env bash
# Compatibility entry point; builds run via Node.js on Windows, macOS and Linux.
set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/build.mjs" "$@"

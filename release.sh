#!/usr/bin/env bash
# Compatibility entry point for the cross-platform release command.
set -e
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
exec pnpm run package

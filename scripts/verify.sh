#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node_modules/.bin/tsc --noEmit
PI=$(command -v pi || echo "$HOME/.local/share/mise/installs/pi/latest/pi/pi")
"$PI" --offline -e "$(pwd)/src/index.ts" --list-models >/dev/null 2>&1

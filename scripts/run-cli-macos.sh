#!/usr/bin/env bash
# Run the standalone Ollama Free Coder terminal app from the current folder.
# Any arguments are treated as an optional one-shot command.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf "This script is for macOS. On Linux use scripts/run-cli-ubuntu.sh.\n" >&2
  exit 1
fi

CALLER_CWD="$(pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT_DIR/out/cli.js" ]; then
  (cd "$ROOT_DIR" && ./node_modules/.bin/tsc -p ./)
fi

node "$ROOT_DIR/out/cli.js" --cwd "$CALLER_CWD" "$@"

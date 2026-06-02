#!/usr/bin/env bash
# Run the standalone Ollama Free Coder terminal app from the current folder.
# Any arguments are treated as an optional one-shot command.
#
# Usage:
#   ./scripts/run-cli-ubuntu.sh
#   ./scripts/run-cli-ubuntu.sh "Generate a new C++ solution of LeetCode problem 2222"

set -euo pipefail

CALLER_CWD="$(pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT_DIR/out/cli.js" ]; then
  (cd "$ROOT_DIR" && ./node_modules/.bin/tsc -p ./)
fi

node "$ROOT_DIR/out/cli.js" --cwd "$CALLER_CWD" "$@"

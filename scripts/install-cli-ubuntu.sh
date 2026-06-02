#!/usr/bin/env bash
# Build and install the standalone Ollama Free Coder terminal app on Ubuntu/Linux.
#
# Usage:
#   ./scripts/install-cli-ubuntu.sh
#   SKIP_OLLAMA=1 ./scripts/install-cli-ubuntu.sh
#   SKIP_PULL=1 CHAT_MODEL=qwen2.5:7b ./scripts/install-cli-ubuntu.sh
#
# Installs the package's npm bins globally via `npm link`, exposing:
#   ofc
#   ollama-free-coder

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

if command -v apt-get >/dev/null 2>&1; then
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    log "Installing Node.js/npm via apt"
    sudo apt-get update
    sudo apt-get install -y nodejs npm
  fi
fi

command -v node >/dev/null 2>&1 || die "Node.js is required (>=18). Install Node and re-run."
command -v npm >/dev/null 2>&1 || die "npm is required. Install npm and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  die "Node.js $NODE_MAJOR detected; Ollama Free Coder CLI needs >=18."
fi

OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
CHAT_MODEL="${CHAT_MODEL:-llama3.1:8b}"
ROUTER_MODEL="${ROUTER_MODEL:-qwen2.5-coder:1.5b-base}"
EXTRA_MODELS="${EXTRA_MODELS:-}"

is_ollama_up() { curl -fsS --max-time 2 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; }
wait_for_ollama() {
  for _ in $(seq 1 30); do is_ollama_up && return 0; sleep 1; done
  return 1
}

if [ "${SKIP_OLLAMA:-0}" != "1" ]; then
  if ! command -v ollama >/dev/null 2>&1; then
    log "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  if ! is_ollama_up; then
    log "Starting ollama serve in background"
    nohup ollama serve >"${TMPDIR:-/tmp}/ollama-serve.log" 2>&1 </dev/null &
    disown || true
    wait_for_ollama || die "Ollama did not start at $OLLAMA_HOST"
  fi
  if [ "${SKIP_PULL:-0}" != "1" ]; then
    for model in $CHAT_MODEL $ROUTER_MODEL $EXTRA_MODELS; do
      log "Pulling Ollama model: $model"
      OLLAMA_HOST="$OLLAMA_HOST" ollama pull "$model"
    done
  fi
fi

log "Installing npm development dependencies"
npm install
log "Compiling TypeScript"
./node_modules/.bin/tsc -p ./
chmod +x out/cli.js || true
log "Linking global commands: ofc, ollama-free-coder"
npm link --force

log "Installed. Try:"
printf '  cd /path/to/project && ofc "Generate a new C++ solution of LeetCode problem 2222"\n'
printf '  cd /path/to/project && ofc "Play Radio Tapok music"\n'

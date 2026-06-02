# Ollama Free Coder

[![Install on the VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/DenRaskovalov.ollama-free-coder?label=VS%20Code%20Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=DenRaskovalov.ollama-free-coder)
[![Marketplace installs](https://img.shields.io/visual-studio-marketplace/i/DenRaskovalov.ollama-free-coder?label=installs)](https://marketplace.visualstudio.com/items?itemName=DenRaskovalov.ollama-free-coder)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A fully-local LLM coding assistant powered by [Ollama](https://ollama.com).
Nothing leaves your machine.

## Install (one-liner, recommended)

The VS Code extension is published on the official Marketplace:

- **VS Code UI**: open *Extensions* (`Cmd/Ctrl+Shift+X`), search for
  **Ollama Free Coder**, click *Install*.
- **CLI**:
  ```sh
  code --install-extension DenRaskovalov.ollama-free-coder
  ```
- **Direct URL**: <https://marketplace.visualstudio.com/items?itemName=DenRaskovalov.ollama-free-coder>

You still need a running Ollama server and at least one pulled model.
The Ubuntu / macOS / Windows installers in `scripts/` (described below)
automate that part for you, but with the Marketplace install you can
also just `brew install ollama` / `winget install Ollama.Ollama` / etc.
and pull a model manually.


This repository ships **three sister frontends** that share the same ideas and core Ollama plumbing:

| Frontend | Source | Installers | Docs |
| --- | --- | --- | --- |
| **VS Code** | `src/` | `scripts/install-ubuntu.sh`, `scripts/install-macos.sh`, `scripts/install-windows.ps1` | this README, [`DOCUMENTATION.md`](./DOCUMENTATION.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| **Terminal app** | `src/cli.ts`, `src/cliTools.ts` | npm bin after compile/package | this README, [`DOCUMENTATION.md`](./DOCUMENTATION.md) |
| **Vim / Neovim** | `vim/` | `vim/scripts/install-ubuntu.sh`, `vim/scripts/install-macos.sh`, `vim/scripts/install-windows.ps1` | [`vim/README.md`](./vim/README.md) + `:help ollama-coder` |

All six installers share the same environment-variable contract:
`CHAT_MODEL`, `COMPLETION_MODEL`, `EXTRA_MODELS`, `OLLAMA_HOST`,
`SKIP_OLLAMA`, `SKIP_PULL`. They each ensure the Ollama server is
running, pull the configured models (failures are fatal, never silent),
and verify them in `/api/tags` before installing the plugin.

If you don’t set `CHAT_MODEL` / `COMPLETION_MODEL`, the installer **picks
sensible defaults based on detected RAM**:

| Total RAM | Tier | Chat model | Completion model |
| --- | --- | --- | --- |
| < 6 GB | tiny | `llama3.2:3b` | `qwen2.5-coder:0.5b-base` |
| < 12 GB | small | `llama3.1:8b` | `qwen2.5-coder:1.5b-base` |
| < 20 GB | medium | `qwen2.5:14b` | `qwen2.5-coder:1.5b-base` |
| < 40 GB | large | `qwen2.5:32b` | `qwen2.5-coder:7b-base` |
| ≥ 40 GB | huge | `llama3.3:70b` | `qwen2.5-coder:7b-base` |

Override at any time:  
`CHAT_MODEL=qwen2.5:14b ./scripts/install-ubuntu.sh`. The detection logic
lives in `scripts/pick-models.sh` and `scripts/pick-models.ps1` (same
tier table), and prints `==> Detected N GB RAM (tier: X) -> ...` so the
choice is visible.

The rest of this README is about the VS Code extension and the standalone terminal app.

---

## Standalone terminal app

The compiled package also provides a cross-platform CLI agent for Ubuntu, macOS,
and Windows. Start it from a project folder and it treats that folder like VS
Code's first workspace folder:

```sh
npm run compile
node out/cli.js
# or one-shot:
node out/cli.js "Generate a new C++ solution of LeetCode problem 2222"
```

Install only the terminal app and expose the global `ofc` / `ollama-free-coder`
commands:

```sh
# Ubuntu/Linux
./scripts/install-cli-ubuntu.sh

# macOS
./scripts/install-cli-macos.sh

# Windows PowerShell
pwsh -ExecutionPolicy Bypass -File .\scripts\install-cli-windows.ps1
```

Run it from the current folder without globally linking it:

```sh
./scripts/run-cli-ubuntu.sh "Generate a new C++ solution of LeetCode problem 2222"
./scripts/run-cli-macos.sh "Play Radio Tapok music"
pwsh -ExecutionPolicy Bypass -File .\scripts\run-cli-windows.ps1 "Play Radio Tapok music"
```

When installed as an npm package, the same app is exposed as `ollama-free-coder`
and `ofc`:

```sh
ofc "Play Radio Tapok music"
ofc --model qwen2.5:7b --enable-run-command
```

The CLI reuses the existing Ollama client, LLM router, agent loop, problem
reference detector, music parser, web search, repo-map extraction, and
SEARCH/REPLACE editor. Its terminal-specific tool executor (`src/cliTools.ts`)
implements the same safety contract as the VS Code extension: all file paths
are sandboxed to the startup folder, file writes require a `y/N` confirmation,
and shell commands are disabled unless `--enable-run-command` is passed (then
confirmed per command). Music requests open the configured streaming service in
the local browser/app.

Useful options:

| Option | Description |
| --- | --- |
| `--model MODEL` | Chat/agent model (default `llama3.1:8b`) |
| `--router-model MODEL` | Small intent-router model (default `qwen2.5-coder:1.5b-base`) |
| `--endpoint URL` | Ollama endpoint (default `$OLLAMA_HOST` or `http://localhost:11434`) |
| `--cwd DIR` | Workspace folder instead of the current directory |
| `--enable-run-command` | Enable the `run_command` tool, still with confirmation |
| `--music-service amazon\|spotify\|youtube\|apple` | Default music service |

---

## Ollama Free Coder for VS Code

## Features

- **Inline ghost-text completion** as you type, using a FIM-capable model
  (defaults to `qwen2.5-coder:1.5b-base`). Debounced and cancellable.
- **Command history** — every prompt you send is persisted. Press ↑/↓ in the
  chat input to walk through past commands shell-style, click **History** for
  a list view, or hover any past user message in the chat log for one-click
  *resend* and *edit*.
- **Keyboard-driven model picker** — click the **Model** button (or focus it
  with Tab) and use ↑/↓ to cycle models, **Home/End** to jump to first/last,
  **PageUp/PageDown** to skip 5, **Enter** to select, **Esc** to cancel.
  Mouse still works. The textarea’s own ↑/↓ history walk is independent —
  the keys never collide because they live on different focus targets.
- **Chat sidebar** (Activity Bar → robot icon) with streaming responses, a
  one-click "include current file/selection" toggle, and `@mentions`:
  - `@src/foo.ts` — attach a workspace file's contents to your question.
  - `@selection` — attach the current editor selection (or whole active file).
- **Show-on-screen vs. write-to-file routing** — prompts like *“show me a
  C++ Hello World”*, *“explain Vector class in C++”*, *“what is a class in
  Python”* always stream into the chat panel. Prompts like *“add Vector
  class implementation to test.cpp”* or *“write a new file with Python
  fizzbuzz”* are auto-routed through agent mode and create the file (with
  a confirm dialog). You can override either way by toggling **agent mode**.
- **Web search built in** — three ways to use it:
  1. Type `/search QUERY` (or `/web`, `/google`) in the chat input to run a
     web search directly and render the top hits inline. No LLM involved.
  2. Prompts with a web-search intent (*"google the latest TypeScript"*,
     *"what's new in Rust 1.85"*, *"search the web for free SVG icons"*)
     are auto-grounded: results are fetched and prepended as context
     before the LLM answers.
  3. The agent can call `web_search` itself in agent mode.
  A small `Search: DuckDuckGo` (or `Google`) label in the chat input shows
  which backend is active.
- **Play music** — say *“Play Radio Tapok from Amazon Music”* or just *“Play
  Five Finger Death Punch”* and the extension opens the right streaming service
  for that artist/track in your browser. The Ollama model only extracts the
  artist and service from your words; the **plugin** builds the URL and opens it
  locally (no API keys, nothing leaves your machine). A named service wins;
  otherwise the `ollamaCoder.musicService` default (Amazon Music) is used. You
  can also type `/play QUERY` (alias `/music`) for a keyless, LLM-free shortcut,
  or run **Ollama Free Coder: Play Music…** from the command palette.
- **Apply code blocks** — hover any code block in chat for one-click
  *Insert at cursor*, *Replace selection*, *Save…* (with diff preview if the
  target file exists), and *Copy*. If the assistant emits a fence like
  ` ```ts src/foo.ts `, *Save…* pre-fills that path.
- **Agent mode** (checkbox in the chat input) lets the model call workspace
  tools to answer multi-step questions and apply edits:
  - `read_file`, `list_files`, `search_text` — read-only context gathering.
  - `get_open_editors` — see what's open and what's selected.
  - `web_search` — search the public web. Default backend is **DuckDuckGo**
    (free, no key, no signup). If you set `ollamaCoder.googleApiKey` and
    `ollamaCoder.googleCseId`, the tool switches to Google Custom Search
    JSON API (Google's free tier: 100 queries/day).
  - `write_file` — create / overwrite files (always shows a confirm dialog;
    "Show diff first" opens a side-by-side preview before applying).
  Uses Ollama's native tool calling — works well with `llama3.1:8b`,
  `qwen2.5:7b`, `qwen2.5-coder:7b`, and other tool-capable models.
- **Code actions on selection** (right-click → *Ollama Free Coder*):
  - Explain Selection
  - Refactor Selection (replaces selection)
  - Fix Selection (replaces selection)
  - Add Docstrings / Comments (replaces selection)
  - Generate Unit Tests (opens new editor)
  - Ask About Selection… (free-form question)
- **Status bar model switcher** — click the `Ollama: <model>` badge to swap
  between any model you've pulled (`ollama pull ...`).
- **Zero runtime npm deps** — uses Node's built-in `http` for the Ollama API.

## Default keybindings

| Action                | Shortcut          |
| --------------------- | ----------------- |
| Open chat             | `Ctrl+Alt+O`      |
| Explain selection     | `Ctrl+Alt+E`      |
| Refactor selection    | `Ctrl+Alt+R`      |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ollamaCoder.endpoint` | `http://localhost:11434` | Ollama server URL |
| `ollamaCoder.chatModel` | `llama3.1:8b` | Model for chat & code actions |
| `ollamaCoder.completionModel` | `qwen2.5-coder:1.5b-base` | Model for inline completion (FIM-capable recommended) |
| `ollamaCoder.enableInlineCompletion` | `true` | Toggle ghost-text completion |
| `ollamaCoder.completionDebounceMs` | `250` | Delay before a completion request |
| `ollamaCoder.maxCompletionTokens` | `128` | Max tokens per completion |
| `ollamaCoder.temperature` | `0.2` | Sampling temperature |
| `ollamaCoder.contextWindowChars` | `4000` | Max chars of file context sent to the model |
| `ollamaCoder.agentMaxSteps` | `8` | Max tool-calling steps per agent turn |
| `ollamaCoder.searchBackend` | `duckduckgo` | `duckduckgo` (free, no key) or `google` (requires the two keys below) |
| `ollamaCoder.googleApiKey` | `""` | Optional Google API key for Custom Search JSON API (free 100/day) |
| `ollamaCoder.googleCseId` | `""` | Optional Google Programmable Search Engine id |
| `ollamaCoder.enableMusic` | `true` | Allow “play music” requests to open a streaming service locally |
| `ollamaCoder.musicService` | `amazon` | Default service when none is named: `amazon` / `spotify` / `youtube` / `apple` |

## Quick install on Ubuntu (24.04 / 26.04)

```bash
git clone https://github.com/local/ollama-coder-vscode
cd ollama-coder-vscode
./scripts/install-ubuntu.sh
```

The script will:

1. Check for Node.js ≥ 18 (and install via apt if missing).
2. Install Ollama (via the official installer) and `systemctl enable --now ollama`.
3. Pull the two default models (`llama3.1:8b`, `qwen2.5-coder:1.5b-base`).
4. `npm install`, compile TypeScript, package a `.vsix`, and install it into the `code` CLI.

Useful environment variables:

```bash
CODE_BIN=codium ./scripts/install-ubuntu.sh   # install into VSCodium instead of VS Code
SKIP_OLLAMA=1   ./scripts/install-ubuntu.sh   # skip Ollama install
SKIP_PULL=1     ./scripts/install-ubuntu.sh   # skip pulling models
CHAT_MODEL=qwen2.5-coder:7b-instruct ./scripts/install-ubuntu.sh
```

## Manual build

```bash
npm install
npm run compile
npx vsce package -o ollama-free-coder.vsix
code --install-extension ./ollama-free-coder.vsix --force
```

## Development

```bash
npm install
npm run watch       # incremental compile
# In VS Code: F5 to launch an Extension Development Host.
```

Source layout:

```
src/
  extension.ts           # activation, commands, status bar
  ollama.ts              # streaming HTTP client for /api/generate, /api/chat, /api/tags
  completionProvider.ts  # InlineCompletionItemProvider with FIM (prompt + suffix)
  codeActions.ts         # Explain / Refactor / Fix / Docstrings / Tests / Ask
  chatView.ts            # Webview-based chat sidebar
scripts/
  install-ubuntu.sh      # one-shot build + install for Ubuntu
```

## Model recommendations

| Use case | Suggested model | `ollama pull` |
| --- | --- | --- |
| Inline completion (fast, FIM) | `qwen2.5-coder:1.5b-base` | `ollama pull qwen2.5-coder:1.5b-base` |
| Inline completion (better, FIM) | `qwen2.5-coder:7b-base` | `ollama pull qwen2.5-coder:7b-base` |
| Chat / code actions (small) | `llama3.1:8b` | `ollama pull llama3.1:8b` |
| Chat / code actions (better) | `qwen2.5-coder:7b-instruct` | `ollama pull qwen2.5-coder:7b-instruct` |

> The inline completion provider sends both a `prompt` (prefix) and `suffix` to
> `/api/generate`, which Ollama forwards to the model's fill-in-the-middle
> template. Use a `*-base` coder model for best results — `instruct`/`chat`
> models tend to wrap output in prose.

## License

Apache-2.0 (see `LICENSE`).

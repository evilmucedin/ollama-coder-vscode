# Ollama Free Coder — Architecture & Reference

This document explains what the extension does, how it is structured, and what
every script and source file is responsible for. It complements the user-facing
`README.md` (which focuses on installation and features).

---

## 1. What the plugin is

**Ollama Free Coder** is a fully-local VS Code coding assistant that talks to a
[Ollama](https://ollama.com) server running on the same machine. Nothing leaves
your machine and no API keys are needed.

It provides:

| Capability | Where it lives |
| --- | --- |
| Inline ghost-text completion (FIM) | `src/completionProvider.ts` |
| Chat sidebar with streaming responses | `src/chatView.ts` |
| `@mentions` (`@path/to/file`, `@selection`) | `src/chatView.ts` (`expandMentions`) |
| Apply buttons on code blocks (Insert / Replace / Save…) | `src/apply.ts` + `chatView.ts` |
| Agent mode — model can read & write the workspace via tools | `src/tools.ts` + `chatView.ts` (`runAgentLoop`) |
| In-chat model picker | `src/chatView.ts` |
| Code actions on selection (Explain / Refactor / Fix / …) | `src/codeActions.ts` |
| Status-bar model switcher | `src/extension.ts` |
| Ollama HTTP client (`/api/generate`, `/api/chat`, `/api/tags`) | `src/ollama.ts` |
| Installer / bootstrapper for Ubuntu | `scripts/install-ubuntu.sh` |

The extension has **zero runtime npm dependencies** — it talks to Ollama over
Node's built-in `http` module.

---

## 2. How a request flows

### 2a. Inline completion (`completionProvider.ts`)

```
keystroke
   │
   ▼
VS Code calls provideInlineCompletionItems()
   │  debounce (default 250 ms) + cancel any inflight
   ▼
read prefix/suffix around cursor (capped at contextWindowChars)
   │
   ▼
POST /api/generate  (streaming, with stop tokens for FIM)
   model = ollamaCoder.completionModel  (default qwen2.5-coder:1.5b-base)
   │
   ▼
strip leading code-fence (some chat-tuned models add them)
   │
   ▼
return as ghost text
```

### 2b. Chat — basic turn

```
user types in webview
   │  expandMentions(): inline @file contents and @selection
   ▼
extension calls chatFull({ messages, model })   →   streaming /api/chat
   │
   ▼
webview renders streamed tokens, parses fenced code blocks,
overlays Insert / Replace sel / Save… / Copy buttons
```

### 2c. Chat — agent turn (tool calling)

```
user enables "agent mode" checkbox
   │
   ▼
runAgentLoop(): up to ollamaCoder.agentMaxSteps (default 8) iterations
   │
   │   for each iteration:
   │     1. chatFull({ messages, tools: TOOL_SCHEMAS })   ← non-streaming
   │     2. if assistant returned tool_calls → execute each via executeTool(),
   │        push results as role='tool' messages, loop again
   │     3. else → done, surface the final assistant text
   ▼
each tool call is rendered in the chat UI as "⚙ tool_name(args)" + a
400-char preview of the result, so the user can watch the agent think
```

Why non-streaming when tools are present: Ollama only emits `tool_calls` in the
final assistant message; streaming them mid-response is not reliable across
models, so we wait for the complete message before executing tools.

### 2d. The LLM router and its plugin-gathered context

Before a chat turn runs, the **LLM router** (`src/router.ts`,
`routeWithModel`) classifies the request — chat vs. create/edit a file vs.
web-search-then-chat vs. explain/refactor the selection vs. run a command —
and picks a `target_path` when a file is involved. It's authoritative by
default (`ollamaCoder.useLlmRouter`); the regex pipeline is the fallback when
it fails or times out.

Ollama has no I/O: it can't read files or query VS Code. So the plugin
gathers the editor state itself (`chatView.collectRouterContext`) and ships it
in the router's JSON payload, bounded by `ROUTER_CONTEXT_CHARS` (800 chars per
field):

```jsonc
{
  "user_text": "refactor this",
  "has_selection": true,
  "active_file": "src/foo.ts",
  "language": "typescript",          // active file's languageId
  "selection_text": "const x = 1;",  // selection (when non-empty) …
  "active_file_excerpt": "…",         // … else the head of the active file
  "open_files": ["src/foo.ts", "src/bar.ts"]   // open-editor paths (≤20)
}
```

The bulky fields are sent only when present, to keep the JSON tight for the
tiny router model. This is the same workspace content the model already sees
via `@mentions` / the agent's `read_file`; no secrets (keychain, OS env) are
read, and the payload goes only to `$OLLAMA_HOST`.

---

## 3. Tools the agent can call

Defined in `src/tools.ts`. All paths are validated to stay inside the first
workspace folder — the model cannot escape.

| Tool | Description | Safety |
| --- | --- | --- |
| `read_file(path)` | UTF-8 read, **64 KB** cap, returns line-numbered text. | Read-only. |
| `list_files(path)` | `readDirectory`, dirs first, capped at **200** entries. | Read-only. |
| `search_text(query, is_regex?, glob?)` | Literal or regex search across workspace; capped at **50** matches; skips `node_modules`, `.git`, `out`, `dist`, `build`, and files larger than 1 MB. | Read-only. |
| `write_file(path, content)` | Creates or overwrites a file. **Always prompts the user** with `Overwrite / Show diff first / Reject`. "Show diff first" opens a side-by-side preview before a modal confirm. | Workspace-confined, user-gated. |
| `get_open_editors()` | Returns the workspace-relative paths of open tabs and the active editor's selection range. | Read-only. |

The JSON schemas exposed to Ollama follow the OpenAI tool-calling shape
(`{ type: "function", function: { name, description, parameters } }`), which
Ollama accepts natively.

---

## 4. `@mentions` in chat

Implemented in `chatView.ts → expandMentions()`. The regex picks up:

- `@selection` → attaches the active editor's selection (or whole file if no
  selection) as a fenced block, labelled with `(file:Lstart-Lend)`.
- `@path/to/file` → reads the workspace file (up to 16 KB) and attaches it.
  Must contain a `/` or `.` to be treated as a path, so casual `@user` tokens
  are ignored.

Mentions are resolved on the extension side (the webview cannot read the
filesystem), and failures are surfaced as `(could not read @x)` rather than
silently dropped.

---

## 5. Apply buttons on code blocks

Implemented in `chatView.ts` (rendering) and `src/apply.ts` (file ops).

When the assistant produces a fenced block, the webview renders four hover
buttons:

| Button | Action |
| --- | --- |
| **Insert** | Insert code at the current cursor in the active editor. |
| **Replace sel** | Replace the current selection (or whole document if no selection) with the code. |
| **Save…** | Prompt for a workspace-relative path. If the file exists, opens a side-by-side diff and a modal confirm; otherwise creates the file and opens it. |
| **Copy** | Copy to clipboard via `navigator.clipboard`. |

If the model emits a fence in Cursor-style — `` ```ts src/foo.ts `` — the part
after the language tag is captured and used as the suggested filename for
**Save…**.

---

## 6. Model picker

In `chatView.ts`. The webview posts a `ready` message on load; the extension
replies with `{ models, current, error }` from `listModels(endpoint)`
(`/api/tags`).

- Selecting a model writes `ollamaCoder.chatModel` (Global) **and** passes the
  value explicitly with the next `send`, so the very next request uses the new
  model immediately.
- A small `↻` button calls `refreshModels` to re-query `/api/tags` — handy
  right after `ollama pull <name>`.
- `onDidChangeConfiguration` keeps the dropdown in sync if the status-bar
  switcher (or another window) changes the model.

---

## 7. Code actions on selection

Defined in `src/codeActions.ts`. Right-click in the editor → **Ollama Free Coder**
submenu, or via the command palette.

| Command | What it does | Result placement |
| --- | --- | --- |
| Explain Selection | Plain-language explanation + edge cases | New markdown editor |
| Refactor Selection | Idiomatic refactor, behavior preserved | **Replaces** selection |
| Fix Selection | Find & fix bugs | **Replaces** selection |
| Add Docstrings/Comments | Annotate without changing behavior | **Replaces** selection |
| Generate Unit Tests | Picks idiomatic framework for the language | New editor in same language |
| Ask About Selection… | Free-form question about the code | New markdown editor |

All of these use the configured `chatModel` and surface progress via a
cancellable VS Code notification.

---

## 7A. Play music

A small "language understanding in, local action out" feature (the same shape
as everything else here). Implemented in `src/music.ts` (pure logic) and
`src/chatView.ts` / `src/extension.ts` (the action).

- **Intent** comes from one of three layers, in order: the LLM router
  (`kind: "play_music"` with `music_query` / `music_service`), a conservative
  regex fallback (`parsePlayIntent` in `music.ts`, used when the router is off
  or returns null), or the `/play QUERY` (alias `/music`) slash command.
- **`music.ts` is pure** — it parses the request, normalizes the service name
  to one of `amazon | spotify | youtube | apple`, and builds the service's
  search URL (`buildMusicUrl`). No I/O.
- **The plugin performs the action**: `chatView.playMusic()` (and the
  `ollamaCoder.playMusic` command) call `vscode.env.openExternal(...)` to open
  that URL in the user's default browser/app. This honors Invariant 8 in
  `ARCHITECTURE.md` — the model only labels; the plugin opens the URL locally.
  `openExternal` is not filesystem/`child_process` I/O, so it doesn't widen the
  `test/ioBoundary.test.js` allowlist.
- **No keys, nothing leaves the machine** beyond the streaming URL you opened.
  Because there's no keyless, cross-service way to auto-start a *specific*
  track, we open the service's search for the query and you press play.
- Controlled by `ollamaCoder.enableMusic` (default on) and
  `ollamaCoder.musicService` (default `amazon`; a service named in the request
  always wins).

---

## 8. Source tree

```
ollama-coder-vscode/
├── package.json                 manifest: commands, settings, menus, keybindings
├── tsconfig.json                TS config (target/output)
├── README.md                    user-facing intro & quickstart
├── DOCUMENTATION.md             ← this file (architecture / reference)
├── LICENSE                      Apache-2.0
├── media/                       sidebar icon
├── test/                        node:test suites:
│    ├─ typecheck.test.js         shells out to `tsc --noEmit`; catches
│    │                            undefined symbols / type errors
│    ├─ chatView.test.js          unit tests for compiled chat helpers
│    └─ _vscode_stub.js           minimal 'vscode' stub for Node-side require()
└── src/
    ├── extension.ts             activate(): registers commands, status bar,
    │                              completion provider, chat webview
    ├── ollama.ts                HTTP client: generate() / chat() / chatFull() /
    │                              listModels(); shared streaming JSON-line parser;
    │                              user-friendly 404 ("model not pulled") errors
    ├── completionProvider.ts    InlineCompletionItemProvider, FIM stop tokens,
    │                              debounce, cancellation
    ├── codeActions.ts           Explain / Refactor / Fix / Docstrings / Tests /
    │                              Ask actions, with system prompts and result
    │                              routing (replace selection vs. new editor)
    ├── chatView.ts              WebviewView: input bar, @mentions, model picker,
    │                              streaming render with apply buttons, agent loop
    ├── apply.ts                 insertAtCursor / replaceSelection / saveToFile
    │                              (with diff preview before overwrite)
    ├── tools.ts                 Agent tool schemas + executors:
    │                              read_file, list_files, search_text,
    │                              write_file, get_open_editors
    └── music.ts                 Pure "play music" helpers: parsePlayIntent,
                                   normalizeService, buildMusicUrl (no I/O)
```

---

## 9. Settings (`contributes.configuration`)

All under the `ollamaCoder.*` namespace.

| Setting | Default | Used by |
| --- | --- | --- |
| `endpoint` | `http://localhost:11434` | every Ollama call |
| `chatModel` | `llama3.1:8b` | chat sidebar, code actions, agent |
| `completionModel` | `qwen2.5-coder:1.5b-base` | inline completion |
| `enableInlineCompletion` | `true` | inline completion |
| `completionDebounceMs` | `250` | inline completion |
| `maxCompletionTokens` | `128` | inline completion |
| `temperature` | `0.2` | inline completion + chat + actions |
| `contextWindowChars` | `4000` | how much surrounding code is sent |
| `agentMaxSteps` | `8` | agent tool-calling loop cap |
| `enableMusic` | `true` | allow “play music” requests to open a streaming service |
| `musicService` | `amazon` | default service when a request names none |

---

## 10. Commands & default keybindings

| Command ID | Title | Default key |
| --- | --- | --- |
| `ollamaCoder.openChat` | Ollama Free Coder: Open Chat | `Ctrl+Alt+O` (`Cmd+Alt+O` on macOS) |
| `ollamaCoder.explainSelection` | Ollama Free Coder: Explain Selection | `Ctrl+Alt+E` |
| `ollamaCoder.refactorSelection` | Ollama Free Coder: Refactor Selection | `Ctrl+Alt+R` |
| `ollamaCoder.fixSelection` | Ollama Free Coder: Fix Selection | — |
| `ollamaCoder.addDocstrings` | Ollama Free Coder: Add Docstrings/Comments | — |
| `ollamaCoder.generateTests` | Ollama Free Coder: Generate Unit Tests | — |
| `ollamaCoder.askAboutSelection` | Ollama Free Coder: Ask About Selection… | — |
| `ollamaCoder.addFileToChat` | Ollama Free Coder: Add File/Selection to Chat | — |
| `ollamaCoder.selectChatModel` | Ollama Free Coder: Select Chat Model | — |
| `ollamaCoder.selectCompletionModel` | Ollama Free Coder: Select Completion Model | — |

---

## 11. Testing

The repo ships a tiny test setup using **Node's built-in `node:test`** runner
(no extra dependencies):

```sh
npm test                # runs: npm run compile && node --test test/*.test.js
npm run typecheck       # runs: tsc -p ./ --noEmit (fast feedback)
```

Two test files:

- `test/typecheck.test.js` — shells out to the local `tsc` and asserts zero
  errors. This catches the exact class of bug that produced the missing
  `compactJson` reference at runtime (an identifier used but never defined or
  imported).
- `test/chatView.test.js` — unit tests for `compactJson` (plain objects, long
  strings, circular references, overall-length cap, non-serializable values
  like `BigInt`).

`test/_vscode_stub.js` is a minimal stub of the `vscode` module so compiled
sources can be `require()`'d in plain Node — the real `vscode` module only
exists inside a running VS Code process.

`scripts/install-ubuntu.sh` runs `npm test` after compiling, so a broken
commit fails the install before producing a `.vsix`.

---

## 12. `scripts/install-ubuntu.sh`

A single end-to-end installer for Ubuntu (tested on 24.04 / 26.04) and similar
Debian-family systems. It is idempotent and safe to re-run.

### What it does

1. **System prerequisites**
   - Installs `nodejs` + `npm` if missing.
   - Verifies Node ≥ 18; otherwise prints NodeSource instructions and aborts.
   - Verifies a VS Code CLI (`$CODE_BIN`, default `code`) is available.

2. **Ollama installation**
   - Installs the official `ollama` package via the upstream installer if it's
     not already present.

3. **Server bootstrap** (`ensure_ollama_running`)
   - `is_ollama_up()` probes `$OLLAMA_HOST/api/tags` with a 2-second timeout.
   - If the server already responds, no-op.
   - Otherwise, if a systemd `ollama.service` unit exists,
     `sudo systemctl enable --now ollama` and wait up to 30 s.
   - Otherwise (WSL, containers, non-systemd distros), launches
     `nohup ollama serve >/tmp/ollama-serve.log 2>&1 &` and `disown`s it,
     waiting up to 30 s for `/api/tags` to come up.
   - Dies with a clear error pointing to the log file if it never appears.

4. **Model installation** (`pull_model`)
   - Pulls every model the extension needs:
     - `CHAT_MODEL` (default `llama3.1:8b`)
     - `COMPLETION_MODEL` (default `qwen2.5-coder:1.5b-base`)
     - Anything listed in `EXTRA_MODELS`
   - Pull failures are **fatal** (`die`) — not silent warnings. This is the
     bug that produced the "HTTP 404" in the chat panel: a typo'd tag silently
     failed and the model was never installed.
   - After each pull, verifies the model is visible in `/api/tags` to catch
     partial pulls.

5. **Build**
   - `npm install` (no audit/fund), `npm run compile` (`tsc -p ./`),
     `npx @vscode/vsce package` → `ollama-free-coder.vsix`.

6. **Install into VS Code**
   - `"$CODE_BIN" --install-extension ./ollama-free-coder.vsix --force`.
   - Prints next-step hints (open the chat, default keybindings, etc.).

### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `CODE_BIN` | `code` | VS Code CLI to install into (use `codium` for VSCodium). |
| `CHAT_MODEL` | `llama3.1:8b` | Chat / code-action model to pull. |
| `COMPLETION_MODEL` | `qwen2.5-coder:1.5b-base` | Inline-completion model to pull. |
| `EXTRA_MODELS` | (empty) | Space-separated list of extra models to pull, e.g. `"qwen2.5:7b mistral:7b"`. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Server URL probed for readiness; keep in sync with `ollamaCoder.endpoint`. |
| `SKIP_OLLAMA` | `0` | Skip installing/pulling Ollama. The script will still start the server if one isn't running. |
| `SKIP_PULL` | `0` | Skip pulling models (assume they're already there). |

### Typical invocations

```sh
# Vanilla install
./scripts/install-ubuntu.sh

# Install into VSCodium instead
CODE_BIN=codium ./scripts/install-ubuntu.sh

# Don't touch Ollama (it's already set up elsewhere)
SKIP_OLLAMA=1 ./scripts/install-ubuntu.sh

# Build & install only — assume models are already pulled
SKIP_PULL=1 ./scripts/install-ubuntu.sh

# Pull additional models alongside the defaults
EXTRA_MODELS="qwen2.5:7b mistral:7b" ./scripts/install-ubuntu.sh
```

---

## 13. Error handling notes

- **`HTTP 404` from Ollama** almost always means the configured model is not
  installed. `src/ollama.ts` parses Ollama's JSON error body and rephrases this
  as `Model "<name>" is not installed. Run:  ollama pull <name>` so the user
  knows exactly what to do.
- Aborted requests (user clicks **Stop**, cancels the progress notification,
  or types again while a completion is in flight) are swallowed silently — the
  rejection message contains `"aborted"`.
- The completion provider never shows error toasts (would be too noisy on
  every keystroke); failures are logged via `console.warn`.
- `write_file` always asks the user first. There is no setting to disable the
  confirm — the goal is that the model cannot modify your files without your
  explicit click.

---

## 14. Privacy

Everything runs on `localhost`:

- Prompts, file contents attached via `@mentions`, tool inputs, and tool
  outputs are all sent only to the Ollama server at
  `ollamaCoder.endpoint` (default `http://localhost:11434`).
- No telemetry is collected by the extension.
- No third-party services are contacted at runtime.

The only outbound network calls in the entire repository are:

| Where | What |
| --- | --- |
| `scripts/install-ubuntu.sh` | `curl` the official Ollama installer + `ollama pull` model weights. |
| `npm install` (build time) | Fetches `@vscode/vsce`, `typescript`, and `@types/*` from the npm registry. |

Runtime code calls **only** `$OLLAMA_HOST`.

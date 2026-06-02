# Ollama Free Coder — Architecture

This document is a *design* paper, not a reference manual. For an
exhaustive map of files and settings, see [`DOCUMENTATION.md`](./DOCUMENTATION.md).
This paper answers three questions:

1. **What does an operation look like, end-to-end?** From the moment the user
   presses Enter in the chat to the moment a file changes on disk, a buffer
   updates, or text appears on screen.
2. **Where do we make decisions?** The plugin currently classifies user
   intent with hand-written regular expressions. That has limits.
3. **What is the design principle going forward?** *Delegate language
   understanding to Ollama models. Keep the plugin small, mechanical, and
   honest.*

---

## 1. TL;DR

```
┌─────────┐      ┌──────────┐      ┌──────────────┐      ┌────────────┐
│  INPUT  │ ───▶ │  ROUTER  │ ───▶ │  EXECUTOR    │ ───▶ │  OUTPUT    │
│         │      │  (intent │      │  loop:       │      │  - chat    │
│ chat,   │      │   class- │      │  - Ollama    │      │  - editor  │
│ keymap, │      │   ifier) │      │    /chat     │      │  - disk    │
│ slash   │      │          │      │  - tools     │      │            │
└─────────┘      └──────────┘      └──────────────┘      └────────────┘
                       ▲                  │
                       │                  │ tool_calls → execute → result
                       │                  ▼
                       │           ┌──────────────┐
                       │           │   TOOLS      │
                       │           │  read_file,  │
                       │           │  write_file, │
                       │           │  list_files, │
                       │           │  search_text,│
                       │           │  web_search, │
                       │           │  get_open_…  │
                       │           └──────────────┘
                       │
                       └── (today: regex; goal: LLM-driven)
```

The plugin is a *thin shell* around Ollama. Everything that requires
understanding what the user wants — should this answer end up in chat? in a
file? — is, ideally, a job for the model.

The current implementation has a handful of regex classifiers (file-write
intent, show-on-screen intent, web-search intent, language inference). This
paper argues those should shrink, not grow.

---

## 2. The four phases of an operation

### 2.1 Input phase

Five entry points, all in `src/extension.ts`:

| Entry | How the user triggers it | Notes |
| --- | --- | --- |
| Chat send | textarea + Ctrl/Cmd+Enter (or the Send button) | `chatView.handleSend()` |
| Slash command | `/search QUERY`, `/web …`, `/google …` in the chat input | short-circuits the model |
| Code action on selection | right-click → submenu, or `<C+A>+E/R` etc. | `codeActions.runAction()` |
| Status bar / dropdown | model picker click | direct setting mutation |
| Inline completion | typing in any editor | `OllamaInlineCompletionProvider` |

The input phase normalises raw user text + the active editor's context
(selection, file path, language id) into a single `userContent` string with
attached `@mentions` expanded. **No model is consulted here.** This phase is
purely deterministic.

### 2.2 Routing phase

Today, three regex classifiers decide what happens next:

```
                ┌─ looksLikeShowIntent(text)        → stay in chat
text  ───▶      ├─ looksLikeFileWriteIntent(text)   → agent loop (tools on)
                └─ looksLikeWebSearchIntent(text)   → RAG prepend, then chat
```

Their job is to answer **"what does the user actually want to happen?"** —
specifically:

- Should this turn write a file? (`looksLikeFileWriteIntent`)
- …unless they explicitly want it on screen. (`looksLikeShowIntent`)
- …or unless they want the live web. (`looksLikeWebSearchIntent`)

Plus a slash-command parser (`parseSlashSearch`) and a language-extension
inferer (`inferLanguageExt`) that fills in a "sensible default filename"
when the user mentioned a language but not a path.

These classifiers are documented, regression-tested, and **fragile**.
They miss every phrasing they weren't tuned for, and they trip on edge
cases like *"explain the C class hierarchy"* (looks like `class` → file
write) until someone patches the regex.

Section 4 of this paper proposes replacing them with a model call.

### 2.3 Execution phase

Two shapes:

**Single-turn chat.** One streaming `POST /api/chat` against
`ollamaCoder.chatModel`. Tokens are streamed back to the webview and
appended to the running assistant message.

**Agent loop** (in `chatView.runAgentLoop`):

```
loop up to ollamaCoder.agentMaxSteps (default 8):
  POST /api/chat with tools=TOOL_SCHEMAS  (non-streaming)
  if response.tool_calls is empty:
      stream the final text and exit
  for tc in response.tool_calls:
      execute tc via tools.executeTool()
      append the result as a role=tool message
      (the user sees a "⚙ tool_name(args)" line + a 400-char preview)
  goto loop
```

All tool calls are sandboxed inside the workspace root. `write_file` is
the only mutation, and it always prompts the user before applying.

### 2.4 Output phase

Three output kinds, picked by the route:

| Output | Triggered by | Code path |
| --- | --- | --- |
| **Screen** (chat panel) | every turn | `webview.postMessage({type:'assistantToken', ...})` |
| **Editor** | code actions with `replace=true`, "Insert at cursor", "Replace selection" buttons | `apply.insertAtCursor`, `apply.replaceSelection` |
| **Disk** | `write_file` tool, "Save…" button on a code block | `tools.writeFile`, `apply.saveToFile` |

A side effect that touches the user's filesystem **always** passes through
a confirmation prompt (modal for `apply.saveToFile`, info-dialog for
`tools.writeFile`). Side-effect surface area is small and well-known.

---

## 3. Invariants the plugin upholds

These hold today and are the contract any future refactor must keep:

1. **Locality.** Every byte of user input goes to `$OLLAMA_HOST` and nowhere
   else, except for the optional `web_search` tool which goes to
   DuckDuckGo or Google CSE. No telemetry, no anonymous metrics, no
   third-party request.
2. **Sandbox.** Every `read_file` / `write_file` / `list_files` /
   `search_text` path is resolved relative to the first workspace folder
   (or the terminal app's startup folder) and rejected if it escapes that root
   via `..`, absolute paths, or symlinks. Verified in
   `tools.ts → resolveInsideWorkspace` and `cliTools.ts → resolveInsideWorkspace`.
3. **User assent for writes.** No file is created or modified without an
   explicit `y/N`-equivalent confirmation. Diff preview is offered in VS Code;
   the standalone terminal app asks for the same explicit yes/no approval.
4. **Abortable.** Every long-running LLM call is wired to an `AbortSignal`
   so the user can press Stop and have the request actually go away.
5. **Tested as a contract.** Every regression the user has hit (HTTP 404
   from a missing model, `(loading…)` stuck dropdown, `compactJson` not
   defined, model list shorter than `ollama list`, "create file"
   ignored, "show me" hijacked) has at least one test pinning the fix.
   Total: 190+ cases.
6. **Bounded loop.** The agent loop terminates after
   `ollamaCoder.agentMaxSteps` rounds. No model can recurse forever.
7. **Backward-compatible defaults.** Auto-picks (model, filename, search
   backend) only fire when the user did not configure them. Explicit
   user config always wins.
8. **Ollama has no filesystem access. The plugin owns all I/O.**
   Ollama is a model-inference server. It speaks HTTP only; it cannot
   `read`, `write`, `unlink`, or `exec` anything on disk. Every byte the
   model “sees” from the user's workspace is pulled by the plugin
   (`tools.read_file`, `repo_map`, `@mention` expansion in
   `chatView.expandMentions`, and the router's
   `chatView.collectRouterContext`) and packaged into a chat message. Every
   file the model produces (`tools.write_file`, `tools.edit_file`,
   `cliTools.write_file`, `cliTools.edit_file`, and the `apply.saveToFile`
   fallback in `chatView.maybeFallbackSave`) is written by the app's code,
   in the app's process, on the *user's* machine, with the *user's*
   confirmation. If a model
   ever produces text like *“I have created the file”* without calling
   one of those tools, **nothing was written.** The system prompt for
   the agent says this explicitly.

   Source-level audit (pinned by `test/ioBoundary.test.js`): the only
   files in `src/` that touch the filesystem or spawn processes are
   `tools.ts`, `cliTools.ts`, `apply.ts`, and `chatView.ts` (the last only
   for `@mention` reads). `cliTools.ts` is the deliberate second I/O boundary
   for the standalone terminal application; it enforces the same workspace
   sandbox and confirmation rules outside VS Code. Every other module is pure
   or HTTP-only.

---

## 4. The design principle: delegate language understanding to Ollama

The user said it directly: *"we should delegate language understanding as
much as possible to Ollama models."* This section says how.

### 4.1 What "language understanding" means in our code

Anywhere the plugin tries to infer **intent** or **structure** from a
free-form English string is "language understanding". Today that surface
is:

| Location | What it understands | How |
| --- | --- | --- |
| `looksLikeShowIntent` | "user wants screen output" | regex list |
| `looksLikeFileWriteIntent` | "user wants a file change" | regex list |
| `looksLikeWebSearchIntent` | "user wants the live web" | regex list |
| `inferLanguageExt` | "the user said C++, pick .cpp" | regex list |
| Code-action system prompts | per-action instructions | hand-written prompts |
| Stop-token list for completion | "stop generating here" | hand-written list |

The first four are the fragile ones. The last two are stable — they
encode protocol, not intent.

### 4.2 Why the regex classifiers don't scale

- They cover the phrasings someone happened to think of. *"can you
  generate hello.py for me"* doesn't match `\\b(create|make|add|…)\\b
  \\s+[\\w./-]*\\.[a-z0-9]{1,6}\\b` because `for me` separates the verb
  from the filename. We patch, we retest, we ship, we miss the next one.
- They don't compose. *"google what the C++23 modules syntax is and put
  an example in test.cpp"* is **both** web-search and file-write, but
  the current pipeline picks one.
- They're English-only. Russian, Spanish, Japanese users get worse
  routing than English users for no good reason.

### 4.3 The proposed architecture: an LLM router

Replace the three intent regexes with a **routing prompt** sent to a
small, fast model. The router's job is to return a structured plan:

```json
{
  "kind":          "chat" | "edit_file" | "create_file" | "web_search_then_chat" |
                   "explain_selection" | "refactor_selection" | "play_music" | …,
  "music_query":   "Radio Tapok"  // when kind == play_music (artist/song/album)
  "music_service": "amazon"       // optional: amazon|spotify|youtube|apple
  "target_path":   "src/foo.ts"   // when kind ∈ {edit_file, create_file}
                                  // else absent
  "needs_web":     true | false,
  "rephrased":     "the user prompt, optionally cleaned up for the worker model"
}
```

The router uses the **completion** model (which on every tier we already
pull, and on the smallest tier is `qwen2.5-coder:0.5b-base` — fast,
local, instant), called with `format: 'json'` so Ollama enforces a JSON
response. We don't need a 70B model to route; we need a small one that
can output the four-key object reliably.

Pseudo-code:

```ts
// Ollama has no I/O — it can't read files or query VS Code — so the plugin
// gathers the editor state itself (chatView.collectRouterContext) and ships it
// in the payload, bounded by ROUTER_CONTEXT_CHARS (800). The bulky fields are
// included only when present, to keep the JSON tight for the tiny router model.
const plan = await routeWithModel({
  endpoint, model: routerModel,
  prompt: ROUTING_SYSTEM + JSON.stringify({
    user_text, has_selection, active_file,
    language,            // active file's languageId
    selection_text,      // selected code (when non-empty), else omitted
    active_file_excerpt, // head of the active file (when nothing selected)
    open_files,          // workspace-relative paths of the open editors
  }),
  format: "json",
});

switch (plan.kind) {
  case "chat":                  return chatTurn(plan.rephrased);
  case "edit_file":             return agentTurn(plan.rephrased, { force_target: plan.target_path });
  case "create_file":           return agentTurn(plan.rephrased, { force_target: plan.target_path });
  case "web_search_then_chat":  return ragChatTurn(plan.rephrased);
  // …
}
```

### 4.4 What stays mechanical

The router is *not* allowed to do everything. Concretely:

- The router **never executes a tool**. It only labels.
- The router **never sees secrets** (keychain entries, OS env). It *does*
  receive bounded, plugin-gathered editor state — the active file's path and
  language, the current selection (or a short head excerpt of the active
  file), and the open-file paths — because Ollama has no I/O and can't read
  any of that itself. This is the same workspace content the model already
  sees via chat `@mentions` / the agent's `read_file`; it is capped at
  `ROUTER_CONTEXT_CHARS` and goes only to `$OLLAMA_HOST`.
- The router's output is **schema-validated** before we act on it. If
  the JSON doesn't parse, or `kind` is unknown, we fall back to plain
  chat. The model cannot make us do something we haven't authorised.
- All five invariants from section 3 still hold. In particular, file
  writes still go through `tools.writeFile` with its confirmation
  dialog. The router cannot bypass it.

### 4.5 Migration plan

This is a four-step, individually shippable refactor. Each step keeps
the regex fallback so behaviour can't regress mid-migration.

1. **Introduce `router.ts`** with the JSON-routing function above plus a
   pure unit-tested schema validator. Behind a setting,
   `ollamaCoder.useLlmRouter: false` by default.
2. **Shadow mode.** When the flag is on, log what the router would have
   picked, but still act on the regex result. Compare in a tiny opt-in
   telemetry-free local log. Tune the system prompt until they agree
   on the existing test corpus.
3. **Swap.** Flip the default. Regexes become the fallback for when the
   router fails / times out.
4. **Delete.** Once the LLM router has been the default for a release,
   remove the regex classifiers and the language-extension inferer.
   `inferLanguageExt` collapses into the router's `target_path` output.

Throughout: every existing positive/negative case in
`test/fileIntent.test.js`, `test/webSearchIntent.test.js`, and
`test/publishRerun.test.js` continues to pass. They become the
acceptance harness for the router.

### 4.6 What we DON'T move to the model

Just as importantly:

- **Streaming, retries, abort wiring.** Plumbing. Mechanical. Stays in
  `ollama.ts`.
- **Tool execution.** The model picks tools; the plugin runs them under
  the workspace sandbox. The model cannot bypass safety.
- **Confirmation dialogs.** Human in the loop for every write.
- **Apply buttons.** Pure DOM, no model knows about them.
- **Search backend selection.** Setting-driven, not model-driven, so
  users can audit which engine is being hit.
- **Marketplace identity / publishing.** Manual, by design.

---

## 5. Data flow trace: one realistic operation

To make this concrete: *"write to a new file C++ Hello World program"*.

```
1.  user types in chat, presses Cmd+Enter
2.  chatView.handleSend() receives { text, includeFile=false, agent=false }

3.  ROUTING PHASE (LLM router authoritative; regex is the fallback)
    collectRouterContext()            → { active_file, language,
                                          selection_text | active_file_excerpt,
                                          open_files }   (plugin-gathered:
                                          Ollama can't read these itself)
    routeWithModel({ user_text, …context }) → { kind: "create_file", … }
    (fallback) looksLikeShowIntent / looksLikeFileWriteIntent / …
    inferLanguageExt(text)            → { name: "C++", ext: ".cpp" }
    decision: agent mode, with filename hint appended.

4.  chatView pushes a system message:
    "You are an autonomous coding agent. … 1. NEW file → IMMEDIATELY
     call write_file …"
    Plus the user message with the filename hint appended.

5.  EXECUTION PHASE (runAgentLoop)
    POST /api/chat   tools=TOOL_SCHEMAS   model=llama3.1:8b
    response.tool_calls = [ { name: "write_file",
                              arguments: { path: "hello_world.cpp",
                                           content: "#include <iostream> …" } } ]

6.  tools.executeTool("write_file", …)
        resolveInsideWorkspace("hello_world.cpp")
        showWarningMessage("Create hello_world.cpp?",
                           "Create", "Show diff first", "Reject")
        user clicks "Create"
        vscode.workspace.fs.writeFile(uri, Buffer.from(content))
        returns "Created hello_world.cpp (… chars)."

7.  loop iterates with the tool result appended
    POST /api/chat (second round)
    response.tool_calls = []
    response.content   = "Created hello_world.cpp with a minimal
                          C++ Hello World."
    stream into chat. loop exits.

8.  OUTPUT PHASE
    chat: short summary visible to user
    disk: hello_world.cpp committed
    editor: not touched (user can :e it)
```

Every arrow in the diagram corresponds to a function in the codebase.
Nothing happens "elsewhere".

---

## 6. Open questions

- **Latency of the LLM router.** Even the smallest local model adds
  ~100–300 ms per turn. On a 64 GB machine running a 70B chat model
  this is rounding error; on a 4 GB Raspberry Pi it might matter.
  Mitigation: keep regex shortcuts for the obvious unambiguous shapes
  (slash commands, explicit `@selection`) and only invoke the router
  for free-form prompts.
- **Tool-calling support.** Not every Ollama model implements the
  tool-calling protocol equally well. The router is *not* a tool call;
  it's a plain `format: json` chat. That works on every Ollama model.
  Tool calling stays where it is today (used by the executor).
- **Multi-language UX.** Right now the chat *system prompt* is in
  English. Should we localise? Probably — but only the system prompt.
  Tool names, schemas, command ids stay English.
- **State across turns.** The agent loop already maintains a
  conversation history. The router today is stateless. We may want to
  pass the last assistant turn back to the router for follow-up turns
  ("now do it again for the rust version").

---

## 7. Glossary

| Term | Meaning |
| --- | --- |
| **Router** | The piece that maps free-form English to a kind+params. Today: regex. Goal: LLM. |
| **Worker model** | The model that actually answers the user. `ollamaCoder.chatModel`. |
| **Router model** | A small fast model used only for routing decisions. Defaults to the completion model. |
| **Tool** | One of `read_file`, `write_file`, `list_files`, `search_text`, `web_search`, `get_open_editors`. Defined in `src/tools.ts`. |
| **Side effect** | Anything that touches disk or editor state outside of the chat panel. |
| **play_music** | A route kind: the model extracts `music_query`/`music_service`; the plugin opens the service's search URL via `vscode.env.openExternal`. Pure URL logic lives in `src/music.ts`. |
| **Sandbox** | The workspace root. Tools cannot escape it. |
| **Worker turn** | One `POST /api/chat`. |
| **Agent turn** | A chain of worker turns separated by tool executions. Bounded by `agentMaxSteps`. |

---

## 8. Status

Last updated for **v1.4.4**.

### Test coverage — positive AND negative (v1.4.8)

Every surface area has both kinds of test. The rule of thumb when adding a
feature: for every “does the right thing on the happy path” test, add at
least one “fails closed on bad input” test.

| Area | Positive | Negative |
| --- | --- | --- |
| Regex classifiers (`looksLike*`, `inferLanguageExt`) | 30+ “must match” phrasings | 15+ “must NOT match” (`fileIntent`, `webSearchIntent`) |
| Problem-ref detector | 10 LeetCode / Codeforces / Project Euler / AoC shapes | 5 lookalikes (`we have 1000 customers`, `project deadline 50 days`, …) |
| LLM router schema | all 7 valid kinds + every new optional field | bad types, unknown kinds, missing `target_path` for file kinds, wrappers, whitespace-only |
| Router HTTP layer | `{plan: ...}` wrapper unwrapping | chat throws, garbage JSON, non-object JSON, empty content, timeout, unknown kind |
| `applySearchReplace` | in-place, new-file, multi-line, CRLF tolerance, whitespace preservation | empty search, search-not-found (with retry coaching), multiple matches (with retry coaching), empty original + non-empty search |
| `extractSymbols` / `renderRepoMap` | TS / Python / Rust / Go / Bash + line numbers | unknown extensions, `maxPerFile` cap, absurdly long lines, `maxBytes` truncation, empty corpus |
| `parseTagsResponse` (model list) | classic `{name}` + newer `{model}` + bare strings + bare array | null / undefined / `{}` / `{models: null}` / `{models: "oops"}` |
| Sandbox enforcement (test fs executor) | workspace-relative paths read & write correctly | `..` traversal, leading-slash coercion stays inside root, empty path, null/undefined args, unknown tool name |
| `run_command` tool | schema + registration | disabled-by-default error message, empty command rejected, `enableRunCommand=false` blocks at the call site |
| Agent loop | full happy path + max-steps termination | `executeTool` throws → wrapped as `ERROR:` tool message; `chat` rejects → bubbles up; `maxSteps=0` short-circuits; history preserved on truncation |
| Webview HTML | nonced `<script>` block, all entry points present | embedded JS parses as valid JS (regression guard for the “\\n stuck (loading…)” bug) |
| Installers (`scripts/install-*.sh`, `.ps1`) | `bash -n`, every contract env var present, platform-correct pack path | n/a at unit level; smoke-checked by `vim/scripts/install-ubuntu.sh` E2E |
| Publish script | bash -n, every Step N/8 marker, npm test runs before vsce package | `vsce publish` against an already-published version (idempotent), `git push` of an already-pushed tag, second-run lockfile churn |
| E2E scenarios (`test/agentE2E.test.js`) | 6 “empty dir → commands → compiles & runs” scenarios | scenario 5: agent’s first `edit_file` rejected, agent recovers on retry — the SEARCH/REPLACE retry coaching as a live control loop |

Total: **309 tests** as of v1.4.8.

### Acceptance harness (v1.4.4)

From this version on, the agent has **end-to-end scenario tests** in
`test/agentE2E.test.js`. Each scenario:

1. Creates an empty (or pre-populated) temp directory.
2. Drives `runAgentLoop` from `src/agentLoop.ts` with a scripted Ollama
   mock (`test/_scriptedOllama.js`) and a real fs-backed tool executor
   (`test/_fsToolExecutor.js`).
3. Asserts the directory the agent produced **compiles and runs**
   under the user's actual toolchain (`python3`, `g++ + make`).

This is the contract the user described: *“start with a directory, run
a sequence of commands, then the produced directory could be compiled,
run and checked.”* If a future refactor regresses any of those
properties, the relevant scenario will fail loudly. Scenarios that
need a toolchain (`python3` / `g++` / `make`) skip themselves cleanly
when the binary isn't on `PATH`.


### Open-source ideas adopted

| Idea | Origin | Where it lives in this repo |
| --- | --- | --- |
| SEARCH/REPLACE diff edits | [Aider](https://aider.chat) | `src/editFile.ts`, `edit_file` tool |
| Repo map for navigation context | [Aider](https://aider.chat) | `src/repoMap.ts`, `repo_map` tool |
| LLM-driven router for intent classification | This paper §4.3 + general agent literature | `src/router.ts` |
| Confirmed shell execution | Cline / OpenHands | `run_command` tool in `src/tools.ts` |
| `format: json` structured-output prompting | Ollama docs + LangChain pattern | `chatFull` `format` parameter |

The principle from every one of these: **the plugin owns the safety
rails (sandbox, confirms, schema validation); the model owns the
language understanding.**

| Migration step (§4.5) | State |
| --- | --- |
| 4a. Introduce `src/router.ts` behind `ollamaCoder.useLlmRouter` | **shipped in v1.4.2** |
| 4b. Shadow mode | **shipped in v1.4.2** (`ollamaCoder.shadowLlmRouter`) |
| 4c. Swap the default | **shipped in v1.4.7** — `useLlmRouter` defaults to `true`. Regex stays as the fallback when the router returns null. `RoutePlan` grew `language`, `needs_web`, `problem_source`, `problem_id` so the router can output everything the regex layer used to compute. |
| 4d. Delete the regex classifiers | **not yet** — want a release of soak time first |

The regex classifiers in §2.2 remain authoritative by default in v1.4.2.
Users who turn `useLlmRouter` on get the LLM-driven pipeline today.

Beyond the migration plan, v1.4.2 also adds the **`run_command` tool**
(§2.3 “Execution phase”), which lets the agent ask to run a shell command.
It is disabled by default (`ollamaCoder.enableRunCommand: false`) and
every invocation requires a per-call modal confirm. The four safety
guards (feature flag, workspace-sandboxed cwd, modal confirm, hard
kill-on-timeout) are pinned by `test/runCommandTool.test.js`.

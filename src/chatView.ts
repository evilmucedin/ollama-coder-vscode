import * as vscode from "vscode";
import { chatFull, ChatMessage, listModels } from "./ollama";
import { TOOL_SCHEMAS, executeTool, ToolCall } from "./tools";
import { insertAtCursor, replaceSelection, saveToFile } from "./apply";
import { searchWeb, SearchResult } from "./web";
import { routeWithModel, RoutePlan } from "./router";
import { runAgentLoop as runAgentLoopPure } from "./agentLoop";
import { extractCodeBlocks, guessFilenameForLang } from "./extractCodeBlocks";
import { detectProblemRef } from "./problemRef";
import {
  parsePlayIntent,
  buildMusicUrl,
  normalizeService,
  SERVICE_LABEL,
  MusicService,
} from "./music";

const SYSTEM_BASIC =
  "You are Ollama Free Coder, an expert pair-programmer running locally inside the user's VS Code. " +
  "Answer concisely. Use fenced code blocks for code. " +
  "When you produce code intended for a specific file, ALWAYS put the path right after the language in the fence header, like ```ts src/foo.ts or ```cpp test.cpp. " +
  "The user can click 'Save' on a code block and the path you wrote will be used as the filename.";

const SYSTEM_AGENT =
  "You are Ollama Free Coder, an autonomous coding agent running locally in the user's VS Code.\n" +
  "IMPORTANT: you cannot read, write, list, or execute anything on the filesystem yourself. " +
  "Every read/write/run goes through the VS Code plugin via a tool call. When you call a tool the plugin " +
  "performs the operation \u2014 in the user's workspace, with the user's confirmation for any write. " +
  "You CANNOT bypass this. Saying 'I have created the file' without calling write_file or edit_file means " +
  "NOTHING got written.\n\n" +
  "You have tools to read, navigate, and modify the workspace. USE THEM.\n\n" +
  "Choosing the right tool:\n" +
  "- repo_map      \u2014 use FIRST when you don't know where to look. It returns a compact map of the workspace with top-level symbols and line numbers. Cheaper than reading every file blindly.\n" +
  "- read_file     \u2014 when you need the actual contents of a known file (e.g. before editing).\n" +
  "- search_text   \u2014 when you need to find which file(s) mention a specific symbol.\n" +
  "- list_files    \u2014 for directory layout questions only.\n" +
  "- edit_file     \u2014 PREFER THIS for modifying an existing file. Provide a SEARCH/REPLACE patch: 'search' must appear EXACTLY ONCE in the file. Copy whitespace verbatim from read_file output. To create a NEW file with edit_file, pass an empty 'search'.\n" +
  "- write_file    \u2014 only for new files or full rewrites. PREFER edit_file when modifying.\n" +
  "- web_search    \u2014 when the answer depends on up-to-date public information.\n" +
  "- run_command   \u2014 when shell execution is genuinely required (and only if the user enabled it).\n" +
  "\n" +
  "Workflow rules:\n" +
  "1. Brand-new file -> edit_file (empty search) or write_file. IMMEDIATELY, don't ask first. If the user didn't specify a programming language, default to Python and use a .py extension. NEVER reply with just a chat-mode code block when the user asked to write a file \u2014 that fails their request.\n" +
  "2. Modify existing file -> read_file first, then edit_file with a minimal SEARCH/REPLACE patch. Do NOT rewrite the entire file when only a few lines change.\n" +
  "3. Don't know the codebase -> repo_map first.\n" +
  "4. After the change, give a one-sentence summary. Don't paste the code in chat \u2014 it's already in the file.\n" +
  "5. Use fenced code blocks only for tiny illustrative snippets or for the final summary.";

const MAX_AGENT_STEPS = 8;

// Patterns that strongly imply the user wants a file actually created or edited
// on disk. When the chat is sent with agent mode OFF and the message matches one
// of these, we automatically run this one turn through the agent loop so the
// model gets the write_file tool. The user sees a one-line notice in the UI.
const FILE_WRITE_INTENT = [
  // "create/add/make/write a file ..."
  /\b(create|make|add|write|generate|scaffold|bootstrap|new)\b[^.?!\n]*\bfile\b/i,
  // "add X to/into/in test.cpp"
  /\b(add|insert|append|write|put)\b[^.?!\n]*\b(to|into|in)\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "save ... to/into/as output.json"
  /\bsave\b[^.?!\n]*\b(to|into|as)\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "edit foo.ts"
  /\bedit\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "modify/update/patch/refactor/fix foo.py"
  /\b(modify|update|patch|refactor|fix|implement)\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "make/create hello.cpp ..." — verb directly followed by a filename
  /\b(create|make|add|write|generate|new|touch|drop|put)\b\s+[\w./-]*\.[a-z0-9]{1,6}\b/i,
  // "new C++ Hello World file" / "C++ hello world as a file" / "new <lang> file"
  /\bnew\b[^.?!\n]*\b(file|program|script|module|class|header|test)\b/i,
  // "<verb> ... <noun> in/using/with/for <language>".
  // The leading verb keeps innocent "what is a class in Python" / "explain
  // Vector class in C++" out \u2014 those should be shown on screen, not
  // written to disk.
  /\b(create|make|add|write|generate|scaffold|bootstrap|implement|new|touch|drop|put)\b[^.?!\n]*\b(file|program|script|module|class|header|test)\b[^.?!\n]*\b(in|using|with|for)\b\s+(c\+\+|cpp|c#|csharp|python|py|ruby|rust|go(?:lang)?|java(?:script)?|ts|typescript|js|kotlin|swift|bash|shell|sh|html|css)\b/i,
];

export function looksLikeFileWriteIntent(text: string): boolean {
  return FILE_WRITE_INTENT.some((re) => re.test(text));
}

/**
 * Phrases that strongly imply the user wants the answer rendered on screen
 * (in the chat panel), NOT written to a file. When one of these matches it
 * overrides the file-write auto-routing: the model will stream into chat
 * and no `write_file` call will be made unless the user explicitly toggled
 * agent mode on.
 */
const SHOW_INTENT = [
  // explicit ask-for-screen verbs
  /^\s*(show|display|print|render|tell)\b/i,
  /\b(show|display|print|render|tell)\s+me\b/i,
  /\bgive\s+me\s+(an?\s+)?(example|snippet|sample|demo|illustration)\b/i,
  // explainers / Q&A phrasings
  /^\s*(what|how|why|when|where|which|who)\b/i,
  /\b(explain|describe|summari[sz]e|outline|illustrate|demonstrate|walk\s+me\s+through|teach\s+me)\b/i,
  /\b(in\s+(the\s+)?chat|on\s+(the\s+)?screen|inline|without\s+(creating|writing|saving)\s+(a\s+)?file|just\s+show)\b/i,
];

export function looksLikeShowIntent(text: string): boolean {
  return SHOW_INTENT.some((re) => re.test(text));
}

/**
 * Prompts that strongly imply the user wants the web consulted before the
 * model answers. When this fires we run a web_search up front, append the
 * results as context, and tell the model to use them. Works even when the
 * agent toggle is off \u2014 it's straight retrieval-augmented chat.
 */
const WEB_SEARCH_INTENT = [
  /\b(google|bing|duckduckgo|ddg|websearch|web\s+search)\b/i,
  /\bsearch\s+(the\s+)?(web|internet|online)\b/i,
  /\blook\s+((it|that|this)\s+)?up\s+(online|on\s+the\s+web|in\s+google)\b/i,
  /\b(latest|recent|current|today'?s|this\s+week's|news\s+on|news\s+about)\b/i,
  /\bwhat'?s?\s+new\s+in\b/i,
];

export function looksLikeWebSearchIntent(text: string): boolean {
  return WEB_SEARCH_INTENT.some((re) => re.test(text));
}

/**
 * Slash command parser. Recognised:
 *   /search <query>
 *   /web    <query>
 *   /google <query>
 */
export function parseSlashSearch(text: string): string | null {
  const m = text.match(/^\s*\/(search|web|google)\s+([\s\S]+)$/i);
  return m ? m[2].trim() : null;
}

/**
 * Slash command parser for music. Recognised:
 *   /play  <query>
 *   /music <query>
 * The query may end with "from/on SERVICE" — parsePlayIntent handles that, so
 * we just hand it the text after the slash word prefixed with "play ".
 */
export function parsePlaySlash(
  text: string
): { query: string; service?: string } | null {
  const m = text.match(/^\s*\/(play|music)\s+([\s\S]+)$/i);
  if (!m) return null;
  return parsePlayIntent("play " + m[2].trim());
}

/**
 * Upper bound on how much editor text the plugin ships to the (tiny) router
 * model per field. The selection / active-file excerpt are sliced to this so
 * the router payload stays small and fast — see ARCHITECTURE.md §4.3.
 */
const ROUTER_CONTEXT_CHARS = 800;

/** Max number of open-file paths we list for the router. */
const ROUTER_MAX_OPEN_FILES = 20;

export interface RouterContext {
  activeFile: string | null;
  language?: string;
  hasSelection: boolean;
  selectionText?: string;
  activeFileExcerpt?: string;
  openFiles: string[];
}

/**
 * Gather the real editor / VS Code state the router needs to classify a turn.
 *
 * Ollama has no I/O: it can't read files or query VS Code, so the plugin must
 * collect every byte the model sees and send it over HTTP (ARCHITECTURE.md
 * Invariant 8). The router used to get only `active_file` + a `has_selection`
 * flag and so decided edit-vs-chat and picked `target_path` nearly blind. This
 * gathers, bounded by ROUTER_CONTEXT_CHARS:
 *   - the active file's relative path and `languageId`
 *   - the selected text (when non-empty), else the head of the active file so
 *     the router knows what it's looking at
 *   - the list of open-editor paths (reusing the tabGroups pattern from
 *     tools.ts → getOpenEditors), capped at ROUTER_MAX_OPEN_FILES
 *
 * Everything here is workspace content the model already sees elsewhere (chat
 * @mentions, agent read_file); no secrets / env are read.
 */
export function collectRouterContext(): RouterContext {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const openFiles = tabs
    .map((t) =>
      t.input instanceof vscode.TabInputText
        ? vscode.workspace.asRelativePath(t.input.uri)
        : null
    )
    .filter((x): x is string => !!x)
    .slice(0, ROUTER_MAX_OPEN_FILES);

  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    return { activeFile: null, hasSelection: false, openFiles };
  }

  const activeFile = vscode.workspace.asRelativePath(ed.document.uri);
  const language = ed.document.languageId || undefined;
  const sel = ed.selection;
  const hasSelection = !sel.isEmpty;

  const ctx: RouterContext = { activeFile, language, hasSelection, openFiles };
  if (hasSelection) {
    const selectionText = ed.document.getText(sel).slice(0, ROUTER_CONTEXT_CHARS);
    if (selectionText.trim()) ctx.selectionText = selectionText;
  } else {
    const excerpt = ed.document.getText().slice(0, ROUTER_CONTEXT_CHARS);
    if (excerpt.trim()) ctx.activeFileExcerpt = excerpt;
  }
  return ctx;
}

function formatSearchResults(
  query: string,
  backend: string,
  results: SearchResult[]
): string {
  if (!results.length) return `No web results for ${JSON.stringify(query)}.`;
  const lines = results.map(
    (r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 240)}`
  );
  return `Search (${backend}) for "${query}":\n${lines.join("\n")}`;
}

/**
 * Detect mentioned programming language(s) so we can give the agent a strong
 * extension hint when the user only mentions a language by name
 * (e.g. "write a new file C++ Hello World" — no ".cpp" anywhere).
 */
const LANG_EXT: Array<{ re: RegExp; name: string; ext: string }> = [
  // \b doesn't work after '++' or '#' because both are non-word chars next
  // to a non-word boundary (space/EOS). Use look-arounds instead.
  { re: /(?:^|\W)(c\+\+|cpp)(?=\W|$)/i, name: "C++", ext: ".cpp" },
  { re: /(?:^|\W)(c#|csharp)(?=\W|$)/i, name: "C#", ext: ".cs" },
  { re: /\bobjective-?c\b/i, name: "Objective-C", ext: ".m" },
  { re: /\bpython\b|\bpy\b/i, name: "Python", ext: ".py" },
  { re: /\brust\b|\brs\b/i, name: "Rust", ext: ".rs" },
  { re: /\bgo(?:lang)?\b/i, name: "Go", ext: ".go" },
  { re: /\btypescript\b|\bts\b/i, name: "TypeScript", ext: ".ts" },
  { re: /\bjavascript\b|\bjs\b/i, name: "JavaScript", ext: ".js" },
  { re: /\bjava\b/i, name: "Java", ext: ".java" },
  { re: /\bkotlin\b|\bkt\b/i, name: "Kotlin", ext: ".kt" },
  { re: /\bswift\b/i, name: "Swift", ext: ".swift" },
  { re: /\bruby\b|\brb\b/i, name: "Ruby", ext: ".rb" },
  { re: /\bbash\b|\bshell\b|\bsh script\b/i, name: "Bash", ext: ".sh" },
  { re: /\bhtml\b/i, name: "HTML", ext: ".html" },
  { re: /\bcss\b/i, name: "CSS", ext: ".css" },
  // C must come last so 'C++' / 'C#' wins. Use a negative lookahead so the
  // 'c' in 'c++' / 'c#' doesn't get picked as plain C (regex \b treats + and #
  // as word boundaries, which would otherwise match).
  { re: /\bc\b(?!\+\+|#)/i, name: "C", ext: ".c" },
];

export function inferLanguageExt(
  text: string
): { name: string; ext: string } | undefined {
  for (const e of LANG_EXT) if (e.re.test(text)) return { name: e.name, ext: e.ext };
  return undefined;
}

/**
 * Render tool arguments as a short single-line JSON for the chat UI.
 * Long string values are truncated so the tool-call line stays readable.
 */
export function compactJson(value: unknown, maxLen = 200): string {
  const seen = new WeakSet<object>();
  const replacer = (_k: string, v: any) => {
    if (typeof v === "string" && v.length > 80) return v.slice(0, 77) + "…";
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    return v;
  };
  let out: string;
  try {
    out = JSON.stringify(value, replacer);
  } catch {
    out = String(value);
  }
  if (out === undefined) out = String(value);
  return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ollamaCoder.chatView";

  private view: vscode.WebviewView | undefined;
  private history: ChatMessage[] = [];
  private inflight: AbortController | undefined;

  /** Persisted ring buffer of the user's most recent prompts (newest first). */
  private cmdHistory: string[] = [];
  private static readonly CMD_HISTORY_KEY = "ollamaCoder.cmdHistory";
  private static readonly CMD_HISTORY_MAX = 100;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.cmdHistory = ctx.globalState.get<string[]>(
      ChatViewProvider.CMD_HISTORY_KEY,
      []
    );
  }

  private async rememberCommand(text: string) {
    const t = text.trim();
    if (!t) return;
    // Dedup: move to front if already present.
    this.cmdHistory = [t, ...this.cmdHistory.filter((x) => x !== t)].slice(
      0,
      ChatViewProvider.CMD_HISTORY_MAX
    );
    await this.ctx.globalState.update(
      ChatViewProvider.CMD_HISTORY_KEY,
      this.cmdHistory
    );
    this.post({ type: "history", items: this.cmdHistory });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.sendModelList();
          // Also push the persisted command history to the webview.
          this.post({ type: "history", items: this.cmdHistory });
          break;
        case "clearHistory":
          this.cmdHistory = [];
          await this.ctx.globalState.update(
            ChatViewProvider.CMD_HISTORY_KEY,
            this.cmdHistory
          );
          this.post({ type: "history", items: [] });
          break;
        case "refreshModels":
          await this.sendModelList();
          break;
        case "setModel":
          await vscode.workspace
            .getConfiguration("ollamaCoder")
            .update(
              "chatModel",
              String(msg.model ?? ""),
              vscode.ConfigurationTarget.Global
            );
          break;
        case "send":
          await this.handleSend(
            String(msg.text ?? ""),
            !!msg.includeFile,
            !!msg.agent,
            msg.model ? String(msg.model) : undefined
          );
          break;
        case "stop":
          this.inflight?.abort();
          break;
        case "clear":
          this.history = [];
          this.post({ type: "cleared" });
          break;
        case "applyInsert":
          await insertAtCursor(String(msg.code ?? ""));
          break;
        case "applyReplace":
          await replaceSelection(String(msg.code ?? ""));
          break;
        case "applySave":
          await saveToFile(String(msg.code ?? ""), msg.path ? String(msg.path) : undefined);
          break;
      }
    });

    // If the user changes the model from the status bar, keep the dropdown in sync.
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ollamaCoder.chatModel")) {
        const m = vscode.workspace
          .getConfiguration("ollamaCoder")
          .get<string>("chatModel", "");
        this.post({ type: "currentModel", model: m });
      }
      if (
        e.affectsConfiguration("ollamaCoder.searchBackend") ||
        e.affectsConfiguration("ollamaCoder.googleApiKey") ||
        e.affectsConfiguration("ollamaCoder.googleCseId")
      ) {
        this.sendSearchBackend();
      }
    });
    this.ctx.subscriptions.push(cfgSub);
  }

  private async sendModelList() {
    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");
    const current = cfg.get<string>("chatModel", "");
    let models: string[] = [];
    let error: string | undefined;
    try {
      models = await listModels(endpoint);
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
    this.post({ type: "models", models, current, error });
    this.sendSearchBackend();
  }

  private sendSearchBackend() {
    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const wanted = cfg.get<string>("searchBackend", "duckduckgo");
    const hasGoogle =
      !!cfg.get<string>("googleApiKey", "") &&
      !!cfg.get<string>("googleCseId", "");
    const effective =
      wanted === "google" && hasGoogle ? "Google" : "DuckDuckGo";
    this.post({ type: "searchBackend", label: effective });
  }

  private async doWebSearch(
    query: string,
    limit: number
  ): Promise<{ results: SearchResult[]; backend: string }> {
    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const backend = cfg.get<string>("searchBackend", "duckduckgo") as
      | "duckduckgo"
      | "google";
    const googleApiKey = cfg.get<string>("googleApiKey", "");
    const googleCseId = cfg.get<string>("googleCseId", "");
    const results = await searchWeb(query, {
      backend,
      limit,
      googleApiKey: googleApiKey || undefined,
      googleCseId: googleCseId || undefined,
    });
    const label =
      backend === "google" && googleApiKey && googleCseId
        ? "Google CSE"
        : "DuckDuckGo";
    return { results, backend: label };
  }

  private async runDirectSearch(query: string): Promise<void> {
    this.post({ type: "assistantStart" });
    try {
      const { results, backend } = await this.doWebSearch(query, 8);
      const md = results.length
        ? results
            .map(
              (r, i) =>
                `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet.slice(
                  0,
                  300
                )}`
            )
            .join("\n\n")
        : "_(no results)_";
      this.post({
        type: "assistantToken",
        text: `Search (${backend}) for \`${query}\`:\n\n${md}`,
      });
    } catch (e: any) {
      this.post({
        type: "assistantError",
        text: `web_search failed: ${e?.message ?? e}`,
      });
      return;
    }
    this.post({ type: "assistantEnd" });
  }

  /**
   * Open a streaming service for the requested music. This is the *plugin*
   * performing the action on the user's machine (ARCHITECTURE.md Invariant 8):
   * the model only labelled the intent; we build the URL and open it via
   * vscode.env.openExternal. No worker turn runs.
   *
   * @param rawText  the original user message (for the chat log + history)
   * @param query    the artist / song / album to play
   * @param service  the raw service string the user/router named (may be undefined)
   */
  private async playMusic(
    rawText: string,
    query: string,
    service: string | undefined
  ): Promise<void> {
    this.post({ type: "userMessage", text: rawText });
    await this.rememberCommand(rawText);

    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const fallback = cfg.get<string>("musicService", "amazon") as MusicService;
    const resolved = normalizeService(service, fallback);
    const url = buildMusicUrl(query, resolved);
    const label = SERVICE_LABEL[resolved];

    this.post({ type: "assistantStart" });
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      this.post({
        type: "assistantToken",
        text:
          `▶ Opening ${label} for **${query}**.\n\n` +
          `${url}\n\n` +
          `Press play on the result (no track auto-starts — this is a ` +
          `keyless, fully-local action that just opens the service).`,
      });
    } catch (e: any) {
      this.post({
        type: "assistantError",
        text: `Could not open ${label}: ${e?.message ?? e}`,
      });
      return;
    }
    this.post({ type: "assistantEnd" });
  }

  reveal() {
    this.view?.show?.(true);
  }

  /** Public so commands can push a user turn from outside (e.g. "Add file to chat"). */
  async pushUserMessage(text: string) {
    this.post({ type: "userMessage", text });
    // Trigger a normal send (no extra context, agent mode follows current toggle).
    await this.handleSend(text, false, false);
  }

  private post(m: unknown) {
    this.view?.webview.postMessage(m);
  }

  /**
   * Expand `@path` and `@selection` mentions in the user's prompt.
   * `@path/to/file` (no spaces) → reads workspace file, appends as a fenced block.
   * `@selection` → appends current editor selection (or whole active file if none).
   */
  private async expandMentions(text: string): Promise<{
    text: string;
    attachments: string[];
  }> {
    const attachments: string[] = [];
    const folder = vscode.workspace.workspaceFolders?.[0];

    // @selection
    const selRe = /(^|\s)@selection\b/g;
    if (selRe.test(text)) {
      const ed = vscode.window.activeTextEditor;
      if (ed) {
        const sel = ed.selection;
        const code = sel.isEmpty
          ? ed.document.getText()
          : ed.document.getText(sel);
        const rel = vscode.workspace.asRelativePath(ed.document.uri);
        const lang = ed.document.languageId;
        const block = `\n\nFrom @selection (${rel}${
          sel.isEmpty ? "" : `:L${sel.start.line + 1}-L${sel.end.line + 1}`
        }):\n\`\`\`${lang}\n${code.slice(0, 8000)}\n\`\`\``;
        attachments.push(block);
      }
    }
    text = text.replace(selRe, "$1@selection");

    // @path/to/file  (must contain a slash or dot, no spaces)
    const fileRe = /(^|\s)@([^\s@`]+)/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(text)) !== null) {
      const ref = m[2];
      if (ref === "selection" || seen.has(ref)) continue;
      // Heuristic: must look like a path (has '/' or '.')
      if (!ref.includes("/") && !ref.includes(".")) continue;
      seen.add(ref);
      if (!folder) continue;
      const uri = vscode.Uri.joinPath(folder.uri, ref);
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(buf.subarray(0, 16 * 1024)).toString("utf8");
        const truncated =
          buf.byteLength > 16 * 1024 ? "\n... [truncated]" : "";
        attachments.push(
          `\n\nFrom @${ref}:\n\`\`\`\n${content}${truncated}\n\`\`\``
        );
      } catch {
        attachments.push(`\n\n(could not read @${ref})`);
      }
    }

    return { text, attachments };
  }

  private async handleSend(
    text: string,
    includeFile: boolean,
    agent: boolean,
    modelOverride?: string
  ) {
    if (!text.trim()) return;
    this.inflight?.abort();

    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");

    // Slash command: '/search QUERY' (alias '/web', '/google') runs a
    // web search directly and renders results inline. No LLM involved.
    const slashQuery = parseSlashSearch(text);
    if (slashQuery) {
      this.post({ type: "userMessage", text });
      await this.rememberCommand(text);
      await this.runDirectSearch(slashQuery);
      return;
    }

    // Slash command: '/play QUERY' (alias '/music') opens a streaming service
    // for the requested music. No LLM involved.
    const slashPlay = parsePlaySlash(text);
    if (slashPlay) {
      await this.playMusic(text, slashPlay.query, slashPlay.service);
      return;
    }
    const model =
      modelOverride && modelOverride.trim()
        ? modelOverride
        : cfg.get<string>("chatModel", "llama3.1:8b");
    const temperature = cfg.get<number>("temperature", 0.3);
    const ctxChars = cfg.get<number>("contextWindowChars", 4000);

    let userContent = text;

    // Implicit "include current file/selection" toggle (unchanged behavior)
    const ed = vscode.window.activeTextEditor;
    if (includeFile && ed) {
      const doc = ed.document;
      const sel = ed.selection;
      const lang = doc.languageId;
      const rel = vscode.workspace.asRelativePath(doc.uri);
      if (!sel.isEmpty) {
        const code = doc.getText(sel).slice(0, ctxChars);
        userContent = `${userContent}\n\nSelected code (${lang}, ${rel}):\n\`\`\`${lang}\n${code}\n\`\`\``;
      } else {
        const code = doc.getText().slice(0, ctxChars);
        userContent = `${userContent}\n\nCurrent file (${lang}, ${rel}):\n\`\`\`${lang}\n${code}\n\`\`\``;
      }
    }

    // @mention expansion
    const { text: cleaned, attachments } = await this.expandMentions(userContent);
    userContent = cleaned + attachments.join("");

    // Web-search intent: prepend retrieved results as context so the LLM
    // can ground its answer. Works without agent mode \u2014 plain RAG.
    // The LLM router (computed below) can ALSO trigger web fetching via
    // its needs_web flag; that path lives inside the routing block.
    if (looksLikeWebSearchIntent(text)) {
      try {
        const { results, backend } = await this.doWebSearch(text, 5);
        if (results.length) {
          this.post({
            type: "notice",
            text: `Pulled ${results.length} web result(s) from ${backend} to ground the answer.`,
          });
          userContent =
            `Use these web search results to answer:\n\n` +
            formatSearchResults(text, backend, results) +
            `\n\n---\n\nUser question:\n${userContent}`;
        }
      } catch (e: any) {
        this.post({
          type: "notice",
          text: `(web_search failed: ${e?.message ?? e})`,
        });
      }
    }

    // ------------------------------------------------------------------
    // Routing. Per ARCHITECTURE.md §4.3 we are migrating from regex
    // classifiers to an LLM-driven router. This block runs both:
    //   - the regex pipeline (authoritative today, fallback later),
    //   - the LLM router, in shadow mode by default (logged only) or
    //     authoritative when ollamaCoder.useLlmRouter == true.
    // ------------------------------------------------------------------
    let effectiveAgent = agent;
    const intent = looksLikeFileWriteIntent(text);
    const showIntent = looksLikeShowIntent(text);

    // Default changed in v1.4.7: LLM router is authoritative; regex stays
    // as the fallback when the router fails / times out. See
    // ARCHITECTURE.md §4.5 step 4c.
    const useLlmRouter = cfg.get<boolean>("useLlmRouter", true);
    let routerPlan: RoutePlan | null = null;
    if (useLlmRouter || cfg.get<boolean>("shadowLlmRouter", false)) {
      try {
        const routerModel =
          cfg.get<string>("routerModel", "") ||
          cfg.get<string>("completionModel", "qwen2.5-coder:1.5b-base");
        // Ollama can't read files or query VS Code, so the plugin gathers the
        // editor state and sends it to the router (ARCHITECTURE.md Invariant 8).
        const rctx = collectRouterContext();
        routerPlan = await routeWithModel({
          endpoint,
          model: routerModel,
          userText: text,
          hasSelection: rctx.hasSelection,
          activeFile: rctx.activeFile ?? undefined,
          language: rctx.language,
          selectionText: rctx.selectionText,
          activeFileExcerpt: rctx.activeFileExcerpt,
          openFiles: rctx.openFiles,
        });
        if (routerPlan) {
          this.post({
            type: "notice",
            text: `Router (${routerModel}): ${routerPlan.kind}${
              routerPlan.target_path ? " → " + routerPlan.target_path : ""
            }${routerPlan.reason ? " — " + routerPlan.reason : ""}`,
          });
        } else if (useLlmRouter) {
          this.post({
            type: "notice",
            text:
              "LLM router returned no plan; falling back to the regex pipeline for this turn.",
          });
        }
      } catch {
        /* router is advisory; failures are silent */
      }
    }

    if (useLlmRouter && routerPlan) {
      // Music short-circuit: open the streaming service and stop. No worker
      // turn, no file logic — the action is purely "open a URL locally".
      if (
        routerPlan.kind === "play_music" &&
        cfg.get<boolean>("enableMusic", true) &&
        routerPlan.music_query
      ) {
        await this.playMusic(text, routerPlan.music_query, routerPlan.music_service);
        return;
      }

      // Authoritative LLM-driven routing. Build a hint block from every
      // optional field the router populated, so the worker model gets the
      // same signals the old regex pipeline would have computed.
      const hints: string[] = [];
      if (routerPlan.kind === "create_file" || routerPlan.kind === "edit_file") {
        effectiveAgent = true;
        if (routerPlan.target_path) hints.push(`target file: ${routerPlan.target_path}`);
      }
      if (routerPlan.language) hints.push(`language: ${routerPlan.language}`);
      if (routerPlan.problem_source && routerPlan.problem_id) {
        hints.push(
          `problem reference: ${routerPlan.problem_source} ${routerPlan.problem_id} \u2014 ` +
          `if you don't remember the exact statement, call web_search with ` +
          `\`${routerPlan.problem_source} ${routerPlan.problem_id}\` first`
        );
        effectiveAgent = true; // problem refs always go to disk
      }
      if (hints.length) {
        userContent = userContent + "\n\n(Router hints: " + hints.join("; ") + ".)";
      }
      // Router-driven web fetch. Only kicks in if the earlier
      // looksLikeWebSearchIntent didn't already prepend results.
      const earlierAlreadyPrependedWeb =
        userContent.includes("Use these web search results to answer:");
      if (
        !earlierAlreadyPrependedWeb &&
        (routerPlan.needs_web === true ||
          routerPlan.kind === "web_search_then_chat")
      ) {
        try {
          const { results, backend } = await this.doWebSearch(text, 5);
          if (results.length) {
            this.post({
              type: "notice",
              text: `Router asked for web context \u2014 pulled ${results.length} result(s) from ${backend}.`,
            });
            userContent =
              `Use these web search results to answer:\n\n` +
              formatSearchResults(text, backend, results) +
              `\n\n---\n\nUser question:\n${userContent}`;
          }
        } catch {
          /* router-driven web fetch is best-effort */
        }
      }
    } else {
      // Existing regex pipeline (still authoritative when LLM router off, or
      // when it returned null and we fell back).
      // Music short-circuit (regex fallback): open the streaming service.
      if (cfg.get<boolean>("enableMusic", true)) {
        const play = parsePlayIntent(text);
        if (play) {
          await this.playMusic(text, play.query, play.service);
          return;
        }
      }
      if (!agent && intent && showIntent) {
        this.post({
          type: "notice",
          text:
            "Looks like you want this shown on screen \u2014 " +
            "replying in chat (no files will be written). Tick \u201cagent mode\u201d to override.",
        });
      } else if (!agent && intent) {
        effectiveAgent = true;
        this.post({
          type: "notice",
          text:
            "Detected a file create/edit request \u2014 running this turn in agent mode so I can write the file.",
        });
      }
    }

    // If the user only named a language ("C++ Hello World") without giving a
    // filename, give the agent an explicit extension hint so it doesn't try to
    // create a path-less file or guess the wrong extension. Only when intent
    // is detected and the user didn't already include a path themselves.
    if (intent && !/[\w./-]*\.[a-z0-9]{1,6}\b/i.test(text)) {
      const lang = inferLanguageExt(text);
      if (lang) {
        userContent =
          userContent +
          `\n\n(Filename hint: the user did not specify a path. Use a sensible "${lang.ext}" file for ${lang.name}, e.g. "hello_world${lang.ext}".)`;
      }
    }

    // Competitive-programming / coding-katas problem reference (LeetCode N,
    // Codeforces 1234A, Project Euler N, Advent of Code year/day, ...). When
    // detected, tell the agent which problem this is, suggest a filename, and
    // explicitly invite web_search if it doesn't remember the statement.
    const problemRef = detectProblemRef(text);
    if (problemRef) {
      userContent = userContent + problemRef.augmentation;
      this.post({
        type: "notice",
        text: `Detected ${problemRef.source} ${problemRef.id} \u2192 will save as ${problemRef.suggestedFilename}.`,
      });
      // Force agent mode \u2014 we want a file on disk, and we want web_search
      // available so the model can look up the problem if needed.
      if (!effectiveAgent) effectiveAgent = true;
    }

    if (this.history.length === 0) {
      this.history.push({
        role: "system",
        content: effectiveAgent ? SYSTEM_AGENT : SYSTEM_BASIC,
      });
    } else if (effectiveAgent) {
      // If user just toggled (or we auto-toggled) agent mode mid-conversation,
      // upgrade the system prompt.
      this.history[0] = { role: "system", content: SYSTEM_AGENT };
    }
    this.history.push({ role: "user", content: userContent });

    // Persist the raw user text (without the auto-attached @mention contents)
    // into the command history. Buttons in the chat log will let the user
    // re-send or edit it later.
    await this.rememberCommand(text);

    this.post({ type: "userMessage", text });

    const ctrl = new AbortController();
    this.inflight = ctrl;

    // If the user wants a file written but no folder is open, every
    // workspace tool will fail with 'No workspace folder is open.'
    // Surface that LOUDLY before kicking off the agent so the user knows
    // they need to File -> Open Folder first.
    if (effectiveAgent) {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        this.post({
          type: "assistantError",
          text:
            "\u26A0 No folder is open in VS Code. Use File \u2192 Open Folder\u2026 first; " +
            "the agent writes files relative to the workspace root and cannot create one without it.",
        });
        return;
      } else {
        this.post({
          type: "notice",
          text: `Writing into workspace: ${folders[0].uri.fsPath}`,
        });
      }
    }

    try {
      if (effectiveAgent) {
        await this.runAgentLoop(endpoint, model, temperature, ctrl.signal);
      } else {
        await this.runSingleTurn(endpoint, model, temperature, ctrl.signal);
      }
    } catch (e: any) {
      const aborted = String(e?.message).includes("aborted");
      this.post({
        type: "assistantError",
        text: aborted ? "(stopped)" : `Error: ${e?.message ?? e}`,
      });
    }
  }

  private async runSingleTurn(
    endpoint: string,
    model: string,
    temperature: number,
    signal: AbortSignal
  ) {
    this.post({ type: "assistantStart" });
    const r = await chatFull(
      {
        endpoint,
        model,
        messages: this.history,
        temperature,
        numPredict: 2048,
        signal,
      },
      (tok) => this.post({ type: "assistantToken", text: tok })
    );
    this.history.push({ role: "assistant", content: r.content });
    this.post({ type: "assistantEnd" });
  }

  private async runAgentLoop(
    endpoint: string,
    model: string,
    temperature: number,
    signal: AbortSignal
  ) {
    const maxSteps = vscode.workspace
      .getConfiguration("ollamaCoder")
      .get<number>("agentMaxSteps", MAX_AGENT_STEPS);

    const result = await runAgentLoopPure(
      {
        endpoint,
        model,
        messages: this.history,
        tools: TOOL_SCHEMAS,
        temperature,
        numPredict: 2048,
        maxSteps,
        signal,
      },
      {
        chat: chatFull,
        executeTool: (tc) => executeTool(tc as ToolCall),
        onAssistantStart:  () => this.post({ type: "assistantStart" }),
        onAssistantToken:  (t) => this.post({ type: "assistantToken", text: t }),
        onAssistantEnd:    () => this.post({ type: "assistantEnd" }),
        onToolCall:        (name, args) =>
          this.post({ type: "toolCall", name, args: compactJson(args) }),
        onToolResult:      (name, preview) =>
          this.post({ type: "toolResult", name, preview }),
        onStoppedAtMaxSteps: (n) =>
          this.post({
            type: "assistantError",
            text: `(agent stopped after ${n} steps)`,
          }),
      }
    );
    // Keep the persisted history in sync with the loop's append-only copy.
    this.history = result.messages;

    // Fallback save: if the user asked for a file to be created but the
    // model emitted only a chat-mode code block (no write_file /
    // edit_file call), rescue the workflow by extracting the code and
    // routing it through saveToFile() \u2014 the same confirm path the
    // \u201cSave\u2026\u201d button uses. Small local models like
    // llama3.1:8b frequently fall into this trap.
    await this.maybeFallbackSave(result);
  }

  private async maybeFallbackSave(result: {
    messages: ChatMessage[];
  }): Promise<void> {
    const wroteSomething = result.messages.some(
      (m) =>
        m.role === "tool" &&
        (m.tool_name === "write_file" || m.tool_name === "edit_file") &&
        /^(Created|Updated|Edited)\b/i.test(m.content)
    );
    if (wroteSomething) return;

    // Find the last user prompt (for the filename hint) and the last
    // assistant content (for the code itself).
    const lastUser = [...result.messages]
      .reverse()
      .find((m) => m.role === "user");
    const lastAssistant = [...result.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content);
    if (!lastAssistant) return;

    const blocks = extractCodeBlocks(lastAssistant.content);
    if (!blocks.length) return;

    this.post({
      type: "notice",
      text:
        "Agent finished without calling write_file. Saving the code block" +
        (blocks.length > 1 ? "s" : "") +
        " to disk \u2014 confirm the path in the input box.",
    });

    for (const blk of blocks) {
      const suggested =
        blk.pathHint && blk.pathHint.includes(".")
          ? blk.pathHint
          : guessFilenameForLang(blk.lang, blk.code, lastUser?.content);
      try {
        await saveToFile(blk.code + "\n", suggested);
      } catch (e: any) {
        this.post({
          type: "notice",
          text: `Fallback save failed: ${e?.message ?? e}`,
        });
      }
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-sideBar-background); margin: 0; padding: 0;
         display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 8px; font-size: 13px; }
  .msg { margin-bottom: 12px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { color: var(--vscode-textLink-foreground); position: relative; }
  .msg.assistant { color: var(--vscode-foreground); }
  .role { font-weight: bold; font-size: 11px; text-transform: uppercase;
          opacity: 0.7; margin-bottom: 2px; }
  .msg.user .msg-actions { position: absolute; top: 0; right: 0; display: none; gap: 4px; }
  .msg.user:hover .msg-actions { display: flex; }
  .msg.user .msg-actions button { font-size: 10px; padding: 1px 6px; }
  .tool { font-size: 11px; opacity: 0.75; font-family: var(--vscode-editor-font-family);
          background: var(--vscode-textCodeBlock-background); padding: 4px 6px;
          border-radius: 4px; margin: 4px 0; }
  .tool .name { color: var(--vscode-symbolIcon-functionForeground, #c586c0); font-weight: bold; }
  .notice { font-size: 11px; opacity: 0.8; font-style: italic;
            padding: 4px 6px; margin: 4px 0;
            border-left: 2px solid var(--vscode-focusBorder, #007acc); }
  .tool .preview { opacity: 0.7; display: block; margin-top: 2px;
                   max-height: 80px; overflow: hidden; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px;
        border-radius: 4px; overflow-x: auto; position: relative; margin: 4px 0; }
  pre .actions { position: absolute; top: 4px; right: 4px; display: none;
                 gap: 4px; }
  pre:hover .actions { display: flex; }
  pre .actions button { font-size: 10px; padding: 2px 6px; }
  pre .pathlabel { font-size: 10px; opacity: 0.6; padding: 0 0 4px 0;
                   font-family: var(--vscode-editor-font-family); }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  #bar { border-top: 1px solid var(--vscode-panel-border); padding: 6px;
         display: flex; flex-direction: column; gap: 4px; }
  #input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px;
           background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border, transparent); padding: 6px;
           font-family: var(--vscode-font-family); font-size: 13px; }
  #row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 0; padding: 4px 10px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  label { font-size: 12px; opacity: 0.85; }
  #hint { font-size: 11px; opacity: 0.6; }
  /* Custom model picker. We avoid <select> because VS Code webviews on Linux
     sometimes render its option list with broken contrast (white-on-white),
     so the user clicks and "sees nothing". A DOM dropdown uses theme vars. */
  #model-picker { position: relative; display: inline-block; }
  #modelBtn { background: var(--vscode-dropdown-background, var(--vscode-input-background));
              color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
              border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
              padding: 2px 18px 2px 6px; font: inherit; font-size: 12px;
              cursor: pointer; min-width: 120px; max-width: 240px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
              text-align: left; position: relative; }
  #modelBtn::after { content: "\\25BE"; position: absolute; right: 6px; top: 2px; opacity: 0.7; }
  #modelMenu { display: none; position: absolute; top: 100%; left: 0;
               background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
               color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
               border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
               min-width: 220px; max-height: 320px; overflow-y: auto;
               z-index: 1000;
               box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
  #modelMenu.open { display: block; }
  #modelMenu .opt { padding: 4px 10px; cursor: pointer; font-size: 12px;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                    color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); }
  #modelMenu .opt:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)); }
  #modelMenu .opt.selected { background: var(--vscode-list-activeSelectionBackground);
                             color: var(--vscode-list-activeSelectionForeground); }
  #modelMenu .opt.empty { opacity: 0.6; font-style: italic; cursor: default; }
  /* Keyboard navigation highlight (separate from .selected so users can see
     where the arrow keys are pointing before they commit with Enter). */
  #modelMenu .opt.active { outline: 1px solid var(--vscode-focusBorder, #007acc);
                          outline-offset: -1px; }
  #history-panel { display: none; max-height: 180px; overflow-y: auto;
                   border-top: 1px solid var(--vscode-panel-border);
                   background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); }
  #history-panel.open { display: block; }
  #history-panel .item { padding: 4px 8px; cursor: pointer;
                         border-bottom: 1px solid var(--vscode-panel-border);
                         font-family: var(--vscode-editor-font-family); font-size: 12px;
                         white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                         display: flex; gap: 6px; align-items: center; }
  #history-panel .item:hover { background: var(--vscode-list-hoverBackground); }
  #history-panel .item .text { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  #history-panel .item button { font-size: 10px; padding: 1px 6px; opacity: 0; }
  #history-panel .item:hover button { opacity: 1; }
  #history-panel .empty { padding: 8px; opacity: 0.5; font-style: italic; }
  #history-panel .header { display: flex; padding: 4px 8px; align-items: center;
                           font-size: 11px; opacity: 0.8; border-bottom: 1px solid var(--vscode-panel-border); }
  #history-panel .header button { font-size: 10px; padding: 1px 6px; margin-left: auto; }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="history-panel">
    <div class="header"><span>History (newest first)</span>
      <button id="closeHistory" class="secondary">close</button>
      <button id="clearHistory" class="secondary">clear</button>
    </div>
    <div id="history-list"></div>
  </div>
  <div id="bar">
    <textarea id="input" placeholder="Ask anything. Use @path/to/file or @selection to attach context. ↑/↓ walks history. Ctrl/Cmd+Enter to send."></textarea>
    <div id="row">
      <label style="display:flex;align-items:center;gap:4px">
        Model:
        <span id="model-picker">
          <button id="modelBtn" type="button" title="Model for the next query">(loading…)</button>
          <div id="modelMenu" role="listbox"></div>
        </span>
        <button id="refreshModels" class="secondary" title="Refresh model list">↻</button>
      </label>
      <label><input type="checkbox" id="ctx" checked /> include current file/selection</label>
      <label><input type="checkbox" id="agent" /> agent mode (can read/write workspace)</label>
      <span id="search-backend" title="Active web_search backend" style="font-size:11px;opacity:0.75">Search: …</span>
      <span style="flex:1"></span>
      <button id="historyBtn" class="secondary" title="Show command history">☰ History</button>
      <button id="stop" class="secondary">Stop</button>
      <button id="clear" class="secondary">Clear</button>
      <button id="send">Send</button>
    </div>
    <div id="hint">Tip: <code>@src/foo.ts</code> attaches a file. <code>@selection</code> attaches the editor selection. <code>/search QUERY</code> runs a web search. Hover a code block for apply actions.</div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  // Custom model picker state. We avoid <select> because its dropdown is
  // sometimes invisible inside VS Code webviews (white-on-white contrast).
  const modelBtn = document.getElementById('modelBtn');
  const modelMenu = document.getElementById('modelMenu');
  const modelSel = {
    _value: '',
    _opts: [],
    get value() { return this._value; },
    set value(v) {
      this._value = v;
      modelBtn.textContent = v || '(none)';
      // Update selected highlight in the menu, if it's already populated.
      modelMenu.querySelectorAll('.opt').forEach((el) => {
        el.classList.toggle('selected', el.getAttribute('data-value') === v);
      });
    },
    get options() {
      // Tests inspect this. Return a live-ish snapshot.
      return this._opts.slice();
    },
  };

  // Currently keyboard-highlighted option (only valid while menu is open).
  let modelActiveIdx = -1;
  function getOptionEls() {
    return Array.from(modelMenu.querySelectorAll('.opt:not(.empty)'));
  }
  function setModelActive(idx) {
    const opts = getOptionEls();
    if (!opts.length) { modelActiveIdx = -1; return; }
    if (idx < 0) idx = 0;
    if (idx >= opts.length) idx = opts.length - 1;
    modelActiveIdx = idx;
    opts.forEach((el, i) => el.classList.toggle('active', i === idx));
    const el = opts[idx];
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }
  function openModelMenu() {
    modelMenu.classList.add('open');
    const opts = getOptionEls();
    // Start the highlight on the currently-selected model if any, else 0.
    let start = opts.findIndex((el) => el.classList.contains('selected'));
    if (start < 0) start = 0;
    setModelActive(start);
  }
  function closeModelMenu() {
    modelMenu.classList.remove('open');
    modelActiveIdx = -1;
    getOptionEls().forEach((el) => el.classList.remove('active'));
  }
  function commitModelActive() {
    const opts = getOptionEls();
    const el = opts[modelActiveIdx];
    if (!el) { closeModelMenu(); return; }
    const val = el.getAttribute('data-value') || '';
    if (val) {
      modelSel.value = val;
      vscode.postMessage({ type: 'setModel', model: val });
    }
    closeModelMenu();
    modelBtn.focus();
  }

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modelMenu.classList.contains('open')) closeModelMenu();
    else openModelMenu();
  });

  // Keyboard navigation. Lives on modelBtn so it never fires while the
  // textarea is focused (the textarea has its OWN ↑/↓ handler for command
  // history \u2014 keeping them on separate focus targets means they
  // don't collide).
  modelBtn.addEventListener('keydown', (e) => {
    const isOpen = modelMenu.classList.contains('open');
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) { openModelMenu(); return; }
        setModelActive(modelActiveIdx + 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) { openModelMenu(); setModelActive(getOptionEls().length - 1); return; }
        setModelActive(modelActiveIdx - 1);
        return;
      case 'PageDown':
        e.preventDefault();
        if (!isOpen) openModelMenu();
        setModelActive(modelActiveIdx + 5);
        return;
      case 'PageUp':
        e.preventDefault();
        if (!isOpen) openModelMenu();
        setModelActive(modelActiveIdx - 5);
        return;
      case 'Home':
        if (!isOpen) return;
        e.preventDefault();
        setModelActive(0);
        return;
      case 'End':
        if (!isOpen) return;
        e.preventDefault();
        setModelActive(getOptionEls().length - 1);
        return;
      case 'Enter':
      case ' ':
        if (!isOpen) { e.preventDefault(); openModelMenu(); return; }
        e.preventDefault();
        commitModelActive();
        return;
      case 'Escape':
        if (!isOpen) return;
        e.preventDefault();
        closeModelMenu();
        return;
      case 'Tab':
        if (isOpen) closeModelMenu(); // don't trap focus
        return;
    }
  });

  // Close when clicking elsewhere or pressing Escape from anywhere.
  document.addEventListener('click', (e) => {
    if (!modelMenu.contains(e.target) && e.target !== modelBtn) {
      closeModelMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modelMenu.classList.contains('open')) {
      closeModelMenu();
    }
  });
  const historyPanel = document.getElementById('history-panel');
  const historyList = document.getElementById('history-list');
  let current = null;       // body element for current assistant message
  let currentRaw = "";
  let cmdHistory = [];
  // -1 means "on the fresh input line". 0..n-1 = walking history (newest first).
  let histCursor = -1;
  let histDraft = "";  // what the user had typed before they started walking history

  function renderHistoryPanel() {
    historyList.innerHTML = '';
    if (!cmdHistory.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No previous commands yet.';
      historyList.appendChild(e);
      return;
    }
    cmdHistory.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'item';
      d.title = t;
      const txt = document.createElement('span');
      txt.className = 'text';
      txt.textContent = t.split('\\n')[0];
      const edit = document.createElement('button');
      edit.textContent = '✎ edit';
      edit.onclick = (ev) => { ev.stopPropagation(); input.value = t; input.focus(); historyPanel.classList.remove('open'); };
      const resend = document.createElement('button');
      resend.textContent = '↻ resend';
      resend.onclick = (ev) => { ev.stopPropagation(); input.value = t; send(); historyPanel.classList.remove('open'); };
      d.appendChild(txt);
      d.appendChild(edit);
      d.appendChild(resend);
      d.onclick = () => { input.value = t; input.focus(); historyPanel.classList.remove('open'); };
      historyList.appendChild(d);
    });
  }

  document.getElementById('historyBtn').onclick = () => {
    historyPanel.classList.toggle('open');
  };
  document.getElementById('closeHistory').onclick = () => historyPanel.classList.remove('open');
  document.getElementById('clearHistory').onclick = () => {
    if (confirm('Clear all command history?')) vscode.postMessage({ type: 'clearHistory' });
  };

  function populateModels(list, current, error){
    modelMenu.innerHTML = '';
    modelSel._opts = [];

    function addItem(text, value, opts) {
      const it = document.createElement('div');
      it.className = 'opt' + (opts && opts.empty ? ' empty' : '');
      if (value) it.setAttribute('data-value', value);
      it.textContent = text;
      if (!opts || !opts.empty) {
        it.addEventListener('click', () => {
          modelSel.value = value;
          modelMenu.classList.remove('open');
          vscode.postMessage({ type:'setModel', model: value });
        });
      }
      modelMenu.appendChild(it);
      modelSel._opts.push({ value: value || '', text });
      return it;
    }

    if (error) {
      modelBtn.textContent = '(error)';
      addItem('(error) ' + String(error).slice(0, 80), '', { empty: true });
      return;
    }
    if (!list || list.length === 0) {
      modelBtn.textContent = '(no models)';
      addItem('(no models — run: ollama pull …)', '', { empty: true });
      return;
    }
    if (current && !list.includes(current)) list = [current, ...list];
    for (const m of list) {
      const el = addItem(m, m);
      if (m === current) el.classList.add('selected');
    }
    modelSel._value = current || '';
    modelBtn.textContent = current || list[0] || '(none)';
  }

  document.getElementById('refreshModels').onclick = ()=>vscode.postMessage({type:'refreshModels'});

  function escapeHtml(s){return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  function escapeAttr(s){return s.replace(/"/g,'&quot;').replace(/</g,'&lt;');}

  // Parse fenced code blocks, including the Cursor-style "\`\`\`lang path/to/file" header.
  function render(raw){
    const parts = [];
    const re = /\`\`\`([a-zA-Z0-9_+\\-]*)([^\\n]*)\\n([\\s\\S]*?)\`\`\`/g;
    let last = 0, m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) parts.push(escapeHtml(raw.slice(last, m.index)));
      const lang = m[1] || '';
      const pathHint = (m[2] || '').trim();
      const codeRaw = m[3];
      const codeId = 'c' + Math.random().toString(36).slice(2);
      window.__codeBlocks = window.__codeBlocks || {};
      window.__codeBlocks[codeId] = { code: codeRaw, path: pathHint };
      const pathLabel = pathHint ? '<div class="pathlabel">'+escapeHtml(pathHint)+'</div>' : '';
      parts.push(
        '<pre data-id="'+codeId+'">' + pathLabel +
        '<div class="actions">' +
          '<button data-act="insert" data-id="'+codeId+'">Insert</button>' +
          '<button data-act="replace" data-id="'+codeId+'">Replace sel</button>' +
          '<button data-act="save" data-id="'+codeId+'">Save…</button>' +
          '<button data-act="copy" data-id="'+codeId+'">Copy</button>' +
        '</div>' +
        '<code>'+escapeHtml(codeRaw)+'</code></pre>'
      );
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push(escapeHtml(raw.slice(last)));
    return parts.join('');
  }

  function addMsg(role, text){
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    let actions = '';
    if (role === 'user') {
      // Allow re-sending or editing this very prompt.
      const safe = encodeURIComponent(text);
      actions = '<div class="msg-actions">' +
        '<button data-resend="'+safe+'">↻ resend</button>' +
        '<button data-edit="'+safe+'">✎ edit</button>' +
        '</div>';
    }
    d.innerHTML = '<div class="role">'+role+'</div>'+actions+'<div class="body">'+render(text)+'</div>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d.querySelector('.body');
  }
  function addTool(name, args){
    const d = document.createElement('div');
    d.className = 'tool';
    d.innerHTML = '<span class="name">⚙ '+escapeHtml(name)+'</span> <code>'+escapeHtml(args)+'</code>' +
                  '<span class="preview" data-preview></span>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  let lastTool = null;

  function send(){
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    vscode.postMessage({
      type:'send',
      text,
      includeFile: document.getElementById('ctx').checked,
      agent: document.getElementById('agent').checked,
      model: modelSel.value || undefined,
    });
  }
  document.getElementById('send').onclick = send;
  document.getElementById('stop').onclick = ()=>vscode.postMessage({type:'stop'});
  document.getElementById('clear').onclick = ()=>{ log.innerHTML=''; vscode.postMessage({type:'clear'}); };
  input.addEventListener('keydown', (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key === 'Enter'){ e.preventDefault(); send(); return; }
    // Shell-style history walk: ↑ at top of input goes back, ↓ at bottom goes forward.
    if (e.key === 'ArrowUp') {
      // Only step into history if the cursor is on the first visual line.
      const before = input.value.slice(0, input.selectionStart || 0);
      if (before.includes('\\n')) return; // multi-line edit, leave native behaviour
      if (histCursor === -1) histDraft = input.value;
      if (histCursor + 1 < cmdHistory.length) {
        histCursor++;
        input.value = cmdHistory[histCursor];
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      const after = input.value.slice(input.selectionEnd || 0);
      if (after.includes('\\n')) return;
      if (histCursor > 0) {
        histCursor--;
        input.value = cmdHistory[histCursor];
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      } else if (histCursor === 0) {
        histCursor = -1;
        input.value = histDraft;
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      }
      return;
    }
    // Any normal typing exits history-walk mode.
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      histCursor = -1;
    }
  });

  // Delegated click handler for per-message resend/edit buttons.
  log.addEventListener('click', (e)=>{
    const r = e.target.closest('button[data-resend]');
    const ed = e.target.closest('button[data-edit]');
    if (r) {
      const t = decodeURIComponent(r.getAttribute('data-resend'));
      input.value = t;
      send();
    } else if (ed) {
      const t = decodeURIComponent(ed.getAttribute('data-edit'));
      input.value = t;
      input.focus();
    }
  });

  // Delegated handler for code-block action buttons.
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const blk = (window.__codeBlocks||{})[id];
    if (!blk) return;
    const act = btn.getAttribute('data-act');
    if (act === 'copy') {
      navigator.clipboard?.writeText(blk.code);
      btn.textContent = 'Copied';
      setTimeout(()=>btn.textContent='Copy', 1000);
      return;
    }
    if (act === 'insert')  vscode.postMessage({type:'applyInsert', code: blk.code});
    if (act === 'replace') vscode.postMessage({type:'applyReplace', code: blk.code});
    if (act === 'save')    vscode.postMessage({type:'applySave', code: blk.code, path: blk.path});
  });

  window.addEventListener('message', (e)=>{
    const m = e.data;
    if (m.type === 'userMessage') addMsg('user', m.text);
    else if (m.type === 'assistantStart'){ currentRaw=''; current = addMsg('assistant',''); }
    else if (m.type === 'assistantToken'){ currentRaw += m.text; if(current) current.innerHTML = render(currentRaw); log.scrollTop = log.scrollHeight; }
    else if (m.type === 'assistantEnd'){ current = null; }
    else if (m.type === 'assistantError'){ if(current) current.textContent = m.text; else addMsg('assistant', m.text); current = null; }
    else if (m.type === 'notice'){
      const d = document.createElement('div');
      d.className = 'notice';
      d.textContent = m.text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }
    else if (m.type === 'toolCall'){ lastTool = addTool(m.name, m.args); }
    else if (m.type === 'toolResult'){
      if (lastTool) {
        const p = lastTool.querySelector('[data-preview]');
        if (p) p.textContent = m.preview;
      }
    }
    else if (m.type === 'cleared'){ log.innerHTML=''; window.__codeBlocks={}; }
    else if (m.type === 'models'){ populateModels(m.models, m.current, m.error); }
    else if (m.type === 'currentModel'){
      modelSel.value = m.model || '';
    }
    else if (m.type === 'history'){
      cmdHistory = m.items || [];
      histCursor = -1;
      renderHistoryPanel();
    }
    else if (m.type === 'searchBackend'){
      const el = document.getElementById('search-backend');
      if (el) el.textContent = 'Search: ' + (m.label || '…');
    }
  });

  // Ask the extension to send us the model list now that we're loaded.
  vscode.postMessage({ type:'ready' });
</script>
</body></html>`;
  }
}

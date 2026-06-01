import { chatFull } from "./ollama";

/**
 * LLM-driven router. See ARCHITECTURE.md \u00a74.3.
 *
 * Replaces the regex classifiers in chatView.ts with a single call to a small
 * fast model that returns a structured plan. The router is intentionally not
 * allowed to *execute* anything \u2014 it only labels. The plugin still owns the
 * sandbox, the confirmation dialogs, and the tool wiring.
 *
 * The output is schema-validated before we act on it. If the model returns
 * invalid JSON or an unknown `kind`, callers fall back to the regex pipeline.
 */

export type RouteKind =
  | "chat"                 // plain chat answer, no side effects
  | "create_file"          // new file to disk; target_path required
  | "edit_file"            // modify an existing file; target_path required
  | "web_search_then_chat" // RAG: fetch web first, then chat
  | "explain_selection"    // analyse the current editor selection
  | "refactor_selection"   // rewrite the current selection in-place
  | "run_command"          // shell command via run_command tool
  | "play_music";          // open a streaming service for the requested music

export interface RoutePlan {
  kind: RouteKind;
  /** Workspace-relative path. Required when kind is create_file or edit_file. */
  target_path?: string;
  /**
   * Language hint ("python", "cpp", "rust", …). Replaces the regex-based
   * inferLanguageExt() helper. The chat view uses this to pre-fill a
   * filename when the model didn't pick a target_path.
   */
  language?: string;
  /**
   * True when the router thinks the worker model should be primed with
   * fresh web results before answering. Replaces the regex-based
   * looksLikeWebSearchIntent() helper. May fire for any `kind`.
   */
  needs_web?: boolean;
  /**
   * For competitive-programming references (LeetCode 1000, AoC 2022/17,
   * …). Replaces the regex-based detectProblemRef() helper. When set,
   * the chat view appends the same kind of augmentation the regex layer
   * would have produced.
   */
  problem_source?: string;
  problem_id?: string;
  /**
   * For kind "play_music": the artist / track / album to play, extracted from
   * the request. Required when kind is play_music.
   */
  music_query?: string;
  /**
   * For kind "play_music": the streaming service the user named, if any
   * ("amazon", "spotify", "youtube", "apple"). Optional — the plugin falls
   * back to the ollamaCoder.musicService setting when absent.
   */
  music_service?: string;
  /**
   * The user's prompt, optionally cleaned up by the router. Passed on to the
   * worker model instead of the raw text. Always non-empty.
   */
  rephrased: string;
  /** Free-form one-line reason. Shown in the chat as a notice. */
  reason?: string;
}

const VALID_KINDS: RouteKind[] = [
  "chat",
  "create_file",
  "edit_file",
  "web_search_then_chat",
  "explain_selection",
  "refactor_selection",
  "run_command",
  "play_music",
];

export const ROUTER_SYSTEM_PROMPT =
  "You are a routing classifier for a local-only coding assistant. " +
  "You read the user's request and emit a single JSON object describing what should happen. " +
  "You are NOT the model that solves the user's problem \u2014 you only classify intent and provide hints.\n" +
  "\n" +
  "Output schema (all fields optional except `kind` and `rephrased`):\n" +
  "  kind:           one of\n" +
  "                    chat                  (answer shown on screen, no file written)\n" +
  "                    create_file           (new file on disk)\n" +
  "                    edit_file             (modify an existing file)\n" +
  "                    web_search_then_chat  (look up live web info, then chat)\n" +
  "                    explain_selection     (explain the active editor selection)\n" +
  "                    refactor_selection    (rewrite the active editor selection)\n" +
  "                    run_command           (execute a shell command)\n" +
  "                    play_music            (open a streaming service to play music)\n" +
  "  target_path:    workspace-relative path. REQUIRED for create_file and edit_file.\n" +
  "  language:       'python' | 'cpp' | 'rust' | 'typescript' | 'javascript' | ...\n" +
  "                  Set when you can infer the language. Used to choose a sensible filename.\n" +
  "  needs_web:      true if the worker model should be given web search results first.\n" +
  "                  Use for 'latest', 'today's', 'what's new in X', 'google X', 'search the web'.\n" +
  "  problem_source: 'LeetCode' | 'Codeforces' | 'Project Euler' | 'Advent of Code' when\n" +
  "                  the request mentions a problem from those sites.\n" +
  "  problem_id:     the problem identifier when problem_source is set (e.g. '1000', '1234A',\n" +
  "                  '2022 day 17').\n" +
  "  music_query:    for play_music: the artist / song / album to play. REQUIRED for play_music.\n" +
  "  music_service:  for play_music: 'amazon' | 'spotify' | 'youtube' | 'apple' when the user\n" +
  "                  named one. Omit if they didn't.\n" +
  "  rephrased:      the user request, optionally cleaned up. NEVER empty.\n" +
  "  reason:         one-sentence explanation; shown in the UI.\n" +
  "\n" +
  "Editor context you are given (the plugin collects this from VS Code and sends\n" +
  "it to you because Ollama cannot read files or query the editor itself):\n" +
  "  user_text:           the request to classify.\n" +
  "  has_selection:       true if the user has text selected in the active editor.\n" +
  "  active_file:         workspace-relative path of the active file, if any.\n" +
  "  language:            the active file's language id (e.g. 'typescript').\n" +
  "  selection_text:      the selected code (truncated), when has_selection is true.\n" +
  "  active_file_excerpt: the start of the active file (truncated), when nothing is selected.\n" +
  "  open_files:          workspace-relative paths of the currently open editors.\n" +
  "Use this context: prefer active_file (or a path from open_files) as target_path\n" +
  "for edit_file; a non-empty selection_text supports explain_selection /\n" +
  "refactor_selection; use language to pick a sensible extension.\n" +
  "\n" +
  "Routing rules (apply top-to-bottom, first match wins):\n" +
  "1. 'show me / what is / how do / explain / describe / give me an example / in chat'\n" +
  "   -> chat. Even if they mention a filename.\n" +
  "2. 'google / search the web / latest / today's / what's new in'\n" +
  "   -> web_search_then_chat, needs_web=true.\n" +
  "3. 'create / make / add / write / generate ... a new file' or 'write ... to FILE.ext'\n" +
  "   -> create_file with target_path. If they named a path use it; otherwise pick a\n" +
  "   sensible workspace-relative path with the right extension (default Python .py).\n" +
  "4. 'modify / update / patch / refactor / fix ... in FILE.ext'\n" +
  "   -> edit_file with target_path.\n" +
  "5. 'explain this code / refactor this / fix this' with a selection\n" +
  "   -> explain_selection or refactor_selection.\n" +
  "6. 'run / execute SHELL_COMMAND'\n" +
  "   -> run_command.\n" +
  "7. 'play / put on / turn on / start playing ARTIST or SONG [from/on SERVICE]'\n" +
  "   -> play_music with music_query=the artist/song/album. Set music_service to\n" +
  "   amazon|spotify|youtube|apple when the user named one; omit it otherwise.\n" +
  "   ('play around with', 'play a game', 'how to play audio in code' are NOT music.)\n" +
  "8. Competitive-programming references win over case 3 with extra fields:\n" +
  "   'LeetCode N'         -> create_file, target_path='leetcode_N.py',          problem_source='LeetCode',       problem_id='N'\n" +
  "   'Codeforces NL'      -> create_file, target_path='codeforces_NL.py',       problem_source='Codeforces',     problem_id='NL'\n" +
  "   'Project Euler N'    -> create_file, target_path='project_euler_N.py',     problem_source='Project Euler',  problem_id='N'\n" +
  "   'AoC YYYY day D'     -> create_file, target_path='aoc_YYYY_dayD.py',       problem_source='Advent of Code', problem_id='YYYY day D'\n" +
  "   Always default to .py unless the user explicitly named another language.\n" +
  "9. Otherwise -> chat.\n" +
  "\n" +
  "You MUST return valid JSON. Do not include code fences. Do not add commentary.";

export interface RouterOptions {
  endpoint: string;
  model: string;
  userText: string;
  hasSelection?: boolean;
  activeFile?: string;
  /** Active file's VS Code language id (e.g. "typescript"). */
  language?: string;
  /** Selected code, already truncated by the caller. Sent when present. */
  selectionText?: string;
  /** Head of the active file, already truncated. Sent when nothing is selected. */
  activeFileExcerpt?: string;
  /** Workspace-relative paths of the open editors. */
  openFiles?: string[];
  signal?: AbortSignal;
  /**
   * Used by tests / shadow mode: timeout after which we give up on the router
   * and let callers fall back to the regex pipeline. Default 8s.
   */
  timeoutMs?: number;
}

/**
 * Schema-validate a parsed JSON object as a RoutePlan. Strict: unknown
 * `kind` values or missing required fields all reject. Exported because the
 * test suite exercises it directly.
 */
export function isValidRoutePlan(x: unknown): x is RoutePlan {
  if (!x || typeof x !== "object") return false;
  const o = x as any;
  if (!VALID_KINDS.includes(o.kind)) return false;
  if (typeof o.rephrased !== "string" || !o.rephrased.trim()) return false;
  if (o.kind === "create_file" || o.kind === "edit_file") {
    if (typeof o.target_path !== "string" || !o.target_path.trim()) return false;
  } else if (o.target_path !== undefined && typeof o.target_path !== "string") {
    return false;
  }
  if (o.kind === "play_music") {
    if (typeof o.music_query !== "string" || !o.music_query.trim()) return false;
  } else if (o.music_query !== undefined && typeof o.music_query !== "string") {
    return false;
  }
  if (o.music_service !== undefined && typeof o.music_service !== "string") return false;
  if (o.reason !== undefined && typeof o.reason !== "string") return false;
  if (o.language !== undefined && typeof o.language !== "string") return false;
  if (o.needs_web !== undefined && typeof o.needs_web !== "boolean") return false;
  if (o.problem_source !== undefined && typeof o.problem_source !== "string") return false;
  if (o.problem_id !== undefined && typeof o.problem_id !== "string") return false;
  return true;
}

/**
 * Normalise a parsed JSON blob into a RoutePlan or `null`. Strips unknown
 * fields, coerces minor shape mismatches (e.g. wrapping text in an `object`
 * key, missing `rephrased` -> fall back to the original prompt).
 */
export function coerceRoutePlan(
  raw: unknown,
  fallbackUserText: string
): RoutePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;

  // Some small models nest the answer under a wrapper key. Be forgiving.
  const candidate =
    typeof r.kind === "string"
      ? r
      : r.plan && typeof r.plan === "object"
      ? r.plan
      : r.route && typeof r.route === "object"
      ? r.route
      : r;

  const plan: RoutePlan = {
    kind: candidate.kind,
    rephrased:
      typeof candidate.rephrased === "string" && candidate.rephrased.trim()
        ? candidate.rephrased.trim()
        : fallbackUserText,
  };
  if (typeof candidate.target_path === "string" && candidate.target_path.trim()) {
    plan.target_path = candidate.target_path.trim();
  }
  if (typeof candidate.reason === "string") {
    plan.reason = candidate.reason;
  }
  if (typeof candidate.language === "string" && candidate.language.trim()) {
    plan.language = candidate.language.trim().toLowerCase();
  }
  if (typeof candidate.needs_web === "boolean") {
    plan.needs_web = candidate.needs_web;
  }
  if (typeof candidate.problem_source === "string" && candidate.problem_source.trim()) {
    plan.problem_source = candidate.problem_source.trim();
  }
  if (typeof candidate.problem_id === "string" && candidate.problem_id.trim()) {
    plan.problem_id = candidate.problem_id.trim();
  }
  if (typeof candidate.music_query === "string" && candidate.music_query.trim()) {
    plan.music_query = candidate.music_query.trim();
  }
  if (typeof candidate.music_service === "string" && candidate.music_service.trim()) {
    plan.music_service = candidate.music_service.trim();
  }
  return isValidRoutePlan(plan) ? plan : null;
}

/**
 * Ask the model to classify the user's intent. Returns null if the router
 * fails (bad JSON, unknown kind, timeout, network error). Callers MUST be
 * prepared to fall back \u2014 the router is advisory, not authoritative.
 */
export async function routeWithModel(
  opts: RouterOptions
): Promise<RoutePlan | null> {
  // The plugin gathers the editor/file context (Ollama can't read it itself)
  // and we forward it here. Only include the bulky fields when they're
  // actually present, to keep the JSON small for the tiny router model.
  const payload: Record<string, unknown> = {
    user_text: opts.userText,
    has_selection: !!opts.hasSelection,
    active_file: opts.activeFile ?? null,
  };
  if (opts.language && opts.language.trim()) payload.language = opts.language;
  if (opts.selectionText && opts.selectionText.trim()) {
    payload.selection_text = opts.selectionText;
  }
  if (opts.activeFileExcerpt && opts.activeFileExcerpt.trim()) {
    payload.active_file_excerpt = opts.activeFileExcerpt;
  }
  if (opts.openFiles && opts.openFiles.length) {
    payload.open_files = opts.openFiles;
  }
  const userPrompt = JSON.stringify(payload);

  const timeoutMs = opts.timeoutMs ?? 8000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  // Compose abort: user signal OR our timeout.
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  try {
    const r = await chatFull({
      endpoint: opts.endpoint,
      model: opts.model,
      messages: [
        { role: "system", content: ROUTER_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      numPredict: 256,
      format: "json",
      signal: ctrl.signal,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      return null;
    }
    return coerceRoutePlan(parsed, opts.userText);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

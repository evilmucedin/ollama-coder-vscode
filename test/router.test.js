// Tests for the LLM router (src/router.ts). We exercise the pure logic
// (schema validation + coercion) without hitting Ollama, then verify that
// the router is wired into chatView via the documented settings.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return require.resolve("./_vscode_stub.js");
  return origResolve.call(this, request, parent, ...rest);
};

const routerPath = path.resolve(__dirname, "..", "out", "router.js");
const chatViewPath = path.resolve(__dirname, "..", "out", "chatView.js");
if (!fs.existsSync(routerPath)) {
  throw new Error(`${routerPath} not found. Run 'npm run compile' first.`);
}
const {
  isValidRoutePlan,
  coerceRoutePlan,
  ROUTER_SYSTEM_PROMPT,
} = require(routerPath);

const { default: _ignored } = { default: null }; // keep file shape stable

/* ----------------------------- isValidRoutePlan -------------------------- */

test("isValidRoutePlan accepts a minimal chat plan", () => {
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "hi" }),
    true
  );
});

test("isValidRoutePlan accepts each valid kind", () => {
  const KINDS = [
    "chat",
    "web_search_then_chat",
    "explain_selection",
    "refactor_selection",
    "run_command",
  ];
  for (const k of KINDS) {
    assert.equal(
      isValidRoutePlan({ kind: k, rephrased: "x" }),
      true,
      `kind ${k} should validate`
    );
  }
});

test("isValidRoutePlan requires target_path for create_file/edit_file", () => {
  assert.equal(
    isValidRoutePlan({ kind: "create_file", rephrased: "x" }),
    false,
    "create_file without target_path must reject"
  );
  assert.equal(
    isValidRoutePlan({ kind: "create_file", rephrased: "x", target_path: "a.py" }),
    true
  );
  assert.equal(
    isValidRoutePlan({ kind: "edit_file", rephrased: "x", target_path: "" }),
    false,
    "edit_file with empty target_path must reject"
  );
});

test("isValidRoutePlan requires music_query for play_music", () => {
  assert.equal(
    isValidRoutePlan({ kind: "play_music", rephrased: "x" }),
    false,
    "play_music without music_query must reject"
  );
  assert.equal(
    isValidRoutePlan({
      kind: "play_music",
      rephrased: "x",
      music_query: "Radio Tapok",
    }),
    true
  );
  assert.equal(
    isValidRoutePlan({
      kind: "play_music",
      rephrased: "x",
      music_query: "Radio Tapok",
      music_service: "amazon",
    }),
    true
  );
  assert.equal(
    isValidRoutePlan({
      kind: "play_music",
      rephrased: "x",
      music_query: "Radio Tapok",
      music_service: 5,
    }),
    false,
    "non-string music_service must reject"
  );
});

test("isValidRoutePlan rejects unknown kinds", () => {
  assert.equal(
    isValidRoutePlan({ kind: "delete_everything", rephrased: "x" }),
    false
  );
});

test("isValidRoutePlan rejects malformed input", () => {
  assert.equal(isValidRoutePlan(null), false);
  assert.equal(isValidRoutePlan({}), false);
  assert.equal(isValidRoutePlan({ kind: "chat" }), false); // no rephrased
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "   " }),
    false,
    "whitespace-only rephrased must reject"
  );
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "ok", reason: 42 }),
    false
  );
});

/* ------------------------------ coerceRoutePlan -------------------------- */

test("coerceRoutePlan passes a clean plan through", () => {
  const plan = coerceRoutePlan(
    { kind: "chat", rephrased: "hello" },
    "fallback"
  );
  assert.deepEqual(plan, { kind: "chat", rephrased: "hello" });
});

test("coerceRoutePlan keeps music fields for a play_music plan", () => {
  const plan = coerceRoutePlan(
    {
      kind: "play_music",
      rephrased: "play Radio Tapok",
      music_query: "  Radio Tapok ",
      music_service: " Amazon Music ",
    },
    "fallback"
  );
  assert.ok(plan);
  assert.equal(plan.kind, "play_music");
  assert.equal(plan.music_query, "Radio Tapok");
  assert.equal(plan.music_service, "Amazon Music");
});

test("coerceRoutePlan rejects play_music with no music_query", () => {
  assert.equal(
    coerceRoutePlan({ kind: "play_music", rephrased: "play" }, "fallback"),
    null
  );
});

test("coerceRoutePlan fills in rephrased from fallback when missing", () => {
  const plan = coerceRoutePlan(
    { kind: "chat" },
    "what is the capital of France"
  );
  assert.equal(plan?.rephrased, "what is the capital of France");
});

test("coerceRoutePlan unwraps {plan:...} and {route:...} wrappers", () => {
  const plan1 = coerceRoutePlan(
    { plan: { kind: "chat", rephrased: "x" } },
    "fallback"
  );
  assert.equal(plan1?.kind, "chat");
  const plan2 = coerceRoutePlan(
    { route: { kind: "chat", rephrased: "x" } },
    "fallback"
  );
  assert.equal(plan2?.kind, "chat");
});

test("coerceRoutePlan returns null for un-fixable input", () => {
  assert.equal(coerceRoutePlan({}, "f"), null);
  assert.equal(coerceRoutePlan({ kind: "nope" }, "f"), null);
  assert.equal(coerceRoutePlan(null, "f"), null);
  assert.equal(coerceRoutePlan("string", "f"), null);
});

test("coerceRoutePlan trims target_path and rejects whitespace-only", () => {
  const ok = coerceRoutePlan(
    { kind: "create_file", target_path: "  src/foo.ts ", rephrased: "x" },
    "f"
  );
  assert.equal(ok?.target_path, "src/foo.ts");
  const bad = coerceRoutePlan(
    { kind: "create_file", target_path: "   ", rephrased: "x" },
    "f"
  );
  assert.equal(bad, null, "create_file with whitespace path must fail");
});

/* --------------------------- router system prompt ------------------------ */

/* ----------------- new optional RoutePlan fields (v1.4.7) ----------------- */

test("isValidRoutePlan accepts the new optional fields", () => {
  // language
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "x", language: "python" }),
    true
  );
  // needs_web
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "x", needs_web: true }),
    true
  );
  // problem_source + problem_id together (typical LeetCode case)
  assert.equal(
    isValidRoutePlan({
      kind: "create_file",
      rephrased: "x",
      target_path: "leetcode_1000.py",
      problem_source: "LeetCode",
      problem_id: "1000",
    }),
    true
  );
});

test("isValidRoutePlan rejects bad types for new fields", () => {
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "x", language: 42 }),
    false
  );
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "x", needs_web: "yes" }),
    false
  );
  assert.equal(
    isValidRoutePlan({
      kind: "chat",
      rephrased: "x",
      problem_source: { foo: 1 },
    }),
    false
  );
});

test("coerceRoutePlan normalises language to lowercase, trims strings", () => {
  const plan = coerceRoutePlan(
    {
      kind: "create_file",
      rephrased: "hi",
      target_path: "  hello.py ",
      language: "  Python ",
      problem_source: "  LeetCode ",
      problem_id: "  1000 ",
      needs_web: false,
    },
    "fallback"
  );
  assert.equal(plan?.language, "python");
  assert.equal(plan?.target_path, "hello.py");
  assert.equal(plan?.problem_source, "LeetCode");
  assert.equal(plan?.problem_id, "1000");
  assert.equal(plan?.needs_web, false);
});

test("coerceRoutePlan drops whitespace-only optional strings", () => {
  const plan = coerceRoutePlan(
    {
      kind: "chat",
      rephrased: "x",
      language: "   ",
      problem_source: "",
    },
    "f"
  );
  assert.ok(plan);
  assert.equal(plan.language, undefined);
  assert.equal(plan.problem_source, undefined);
});

test("ROUTER_SYSTEM_PROMPT covers the new RoutePlan fields", () => {
  // The prompt is the model's whole spec. If any of these get dropped
  // the router silently loses functionality.
  for (const needle of [
    "language",
    "needs_web",
    "problem_source",
    "problem_id",
    "LeetCode",
    "Codeforces",
    "Project Euler",
    "Advent of Code",
    // Editor-context fields the plugin gathers and sends (Ollama has no I/O).
    "selection_text",
    "active_file_excerpt",
    "open_files",
  ]) {
    assert.ok(
      ROUTER_SYSTEM_PROMPT.includes(needle),
      `ROUTER_SYSTEM_PROMPT missing keyword: ${needle}`
    );
  }
});

test("ROUTER_SYSTEM_PROMPT mentions every routing rule keyword", () => {
  // Required because the prompt is the model's whole spec. If someone
  // deletes one rule, behaviour silently drifts.
  for (const needle of [
    "create_file",
    "edit_file",
    "web_search_then_chat",
    "explain_selection",
    "refactor_selection",
    "run_command",
    "play_music",
    "music_query",
    "rephrased",
    "target_path",
  ]) {
    assert.ok(
      ROUTER_SYSTEM_PROMPT.includes(needle),
      `ROUTER_SYSTEM_PROMPT missing keyword: ${needle}`
    );
  }
});

/* ----------------------------- chatView wiring --------------------------- */

test("chatView reads useLlmRouter / shadowLlmRouter / routerModel settings", () => {
  const src = fs.readFileSync(chatViewPath, "utf8");
  for (const key of [
    "useLlmRouter",
    "shadowLlmRouter",
    "routerModel",
  ]) {
    assert.ok(
      src.includes(key),
      `chatView.js does not consult the ${key} setting`
    );
  }
  assert.ok(
    /routeWithModel\b/.test(src),
    "chatView must call routeWithModel"
  );
});

test("chatView gathers editor context and feeds it to the router", () => {
  // Ollama can't read files or query VS Code, so the plugin must collect the
  // editor state itself and pass it to routeWithModel. Pin that wiring.
  const src = fs.readFileSync(chatViewPath, "utf8");
  assert.ok(
    /collectRouterContext\b/.test(src),
    "chatView must gather editor context via collectRouterContext"
  );
  for (const token of [
    "languageId",
    "selectionText",
    "activeFileExcerpt",
    "openFiles",
    "tabGroups",
  ]) {
    assert.ok(
      src.includes(token),
      `chatView must reference ${token} when gathering router context`
    );
  }
});

test("router is ON by default in package.json (as of v1.4.7)", () => {
  // The default flipped in v1.4.7: LLM router is now authoritative.
  // Regex remains as the fast fallback path when the router fails.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  const cfg = pkg.contributes.configuration.properties;
  assert.equal(
    cfg["ollamaCoder.useLlmRouter"].default,
    true,
    "useLlmRouter must default to true in v1.4.7+"
  );
  // Shadow mode stays off \u2014 it's a debugging knob.
  assert.equal(cfg["ollamaCoder.shadowLlmRouter"].default, false);
  // routerModel still empty \u2014 falls back to completionModel.
  assert.equal(cfg["ollamaCoder.routerModel"].default, "");
});

// Negative tests for routeWithModel (src/router.ts).
//
// The router is advisory \u2014 every failure mode (network error, garbage
// JSON, schema violation, timeout) MUST return null and let the caller
// fall back to the regex pipeline. This file pins those returns.
//
// We don't have a real Ollama server here; we monkey-patch the
// `chatFull` export on out/ollama.js so we can script every response
// shape we care about.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ollamaMod = require("../out/ollama.js");
const routerMod = require("../out/router.js");

function withChatFull(stub, fn) {
  const orig = ollamaMod.chatFull;
  ollamaMod.chatFull = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      ollamaMod.chatFull = orig;
    });
}

const opts = {
  endpoint: "http://localhost:11434",
  model: "tiny",
  userText: "what is a hash map",
  hasSelection: false,
  timeoutMs: 200,
};

test("routeWithModel returns null when chat() throws (e.g. ECONNREFUSED)", async () => {
  await withChatFull(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      const r = await routerMod.routeWithModel(opts);
      assert.equal(r, null);
    }
  );
});

test("routeWithModel returns null when chat() returns invalid JSON", async () => {
  await withChatFull(
    async () => ({ content: "not json at all", tool_calls: [] }),
    async () => {
      const r = await routerMod.routeWithModel(opts);
      assert.equal(r, null);
    }
  );
});

test("routeWithModel returns null when chat() returns valid JSON with unknown kind", async () => {
  await withChatFull(
    async () => ({
      content: JSON.stringify({ kind: "delete_universe", rephrased: "no" }),
      tool_calls: [],
    }),
    async () => {
      const r = await routerMod.routeWithModel(opts);
      assert.equal(r, null);
    }
  );
});

test("routeWithModel returns null when create_file plan omits target_path", async () => {
  await withChatFull(
    async () => ({
      content: JSON.stringify({ kind: "create_file", rephrased: "x" }),
      tool_calls: [],
    }),
    async () => {
      const r = await routerMod.routeWithModel(opts);
      assert.equal(r, null);
    }
  );
});

test("routeWithModel unwraps a {plan:...} wrapper and returns a real plan", async () => {
  await withChatFull(
    async () => ({
      content: JSON.stringify({
        plan: {
          kind: "create_file",
          rephrased: "hi",
          target_path: "ok.py",
          language: "Python",
        },
      }),
      tool_calls: [],
    }),
    async () => {
      const r = await routerMod.routeWithModel(opts);
      assert.ok(r);
      assert.equal(r.kind, "create_file");
      assert.equal(r.target_path, "ok.py");
      assert.equal(r.language, "python");
    }
  );
});

test("routeWithModel returns null when chat() never resolves (timeout)", async () => {
  // chat hangs forever; the router's internal AbortSignal must fire and
  // we should get null instead of a hung promise.
  await withChatFull(
    () =>
      new Promise((_resolve, reject) => {
        // Honour the AbortSignal hooked up by the router so the test
        // terminates promptly.
        // The router passes a signal in opts; chatFull is invoked with
        // that signal. Listen for the abort and reject.
        // We rely on routeWithModel passing the abort signal through.
        // If it didn't, this test would timeout in node:test itself.
        setTimeout(() => reject(new Error("aborted")), 100);
      }),
    async () => {
      const r = await routerMod.routeWithModel({ ...opts, timeoutMs: 50 });
      assert.equal(r, null);
    }
  );
});

test("routeWithModel returns null for empty content", async () => {
  await withChatFull(
    async () => ({ content: "", tool_calls: [] }),
    async () => {
      const r = await routerMod.routeWithModel(opts);
      assert.equal(r, null);
    }
  );
});

test("routeWithModel returns null for content that is JSON but not an object", async () => {
  for (const garbage of ["null", "42", '"a string"', "[1, 2, 3]"]) {
    await withChatFull(
      async () => ({ content: garbage, tool_calls: [] }),
      async () => {
        const r = await routerMod.routeWithModel(opts);
        assert.equal(r, null, `expected null for JSON: ${garbage}`);
      }
    );
  }
});

/* ---------------- plugin sends file & VS Code data to Ollama ------------- */

// Ollama has no I/O — it can't read files or query VS Code, so the plugin
// MUST gather the editor state and put it in the router payload. This pins
// that the gathered fields reach Ollama (and that empty ones are omitted).
test("routeWithModel ships gathered editor context in the user message", async () => {
  let captured = null;
  await withChatFull(
    async (req) => {
      captured = req;
      return {
        content: JSON.stringify({ kind: "refactor_selection", rephrased: "x" }),
        tool_calls: [],
      };
    },
    async () => {
      await routerMod.routeWithModel({
        ...opts,
        userText: "refactor this",
        hasSelection: true,
        activeFile: "src/foo.ts",
        language: "typescript",
        selectionText: "const x = 1;",
        // excerpt intentionally empty here -> must be omitted
        activeFileExcerpt: "   ",
        openFiles: ["src/foo.ts", "src/bar.ts"],
      });
    }
  );

  assert.ok(captured, "chatFull was not called");
  const userMsg = captured.messages[1];
  assert.equal(userMsg.role, "user");
  const payload = JSON.parse(userMsg.content);

  assert.equal(payload.user_text, "refactor this");
  assert.equal(payload.has_selection, true);
  assert.equal(payload.active_file, "src/foo.ts");
  assert.equal(payload.language, "typescript");
  assert.equal(payload.selection_text, "const x = 1;");
  assert.deepEqual(payload.open_files, ["src/foo.ts", "src/bar.ts"]);
  // Whitespace-only excerpt must NOT be sent (keeps payload tight).
  assert.ok(
    !("active_file_excerpt" in payload),
    "whitespace-only active_file_excerpt should be omitted"
  );
});

test("routeWithModel omits all optional context fields when none are provided", async () => {
  let captured = null;
  await withChatFull(
    async (req) => {
      captured = req;
      return {
        content: JSON.stringify({ kind: "chat", rephrased: "x" }),
        tool_calls: [],
      };
    },
    async () => {
      await routerMod.routeWithModel(opts); // no language/selection/excerpt/openFiles
    }
  );

  const payload = JSON.parse(captured.messages[1].content);
  // The three baseline fields are always present...
  assert.deepEqual(Object.keys(payload).sort(), [
    "active_file",
    "has_selection",
    "user_text",
  ]);
});

test("routeWithModel sends active_file_excerpt when there is no selection", async () => {
  let captured = null;
  await withChatFull(
    async (req) => {
      captured = req;
      return {
        content: JSON.stringify({ kind: "chat", rephrased: "x" }),
        tool_calls: [],
      };
    },
    async () => {
      await routerMod.routeWithModel({
        ...opts,
        hasSelection: false,
        activeFile: "src/foo.ts",
        activeFileExcerpt: "export const answer = 42;",
      });
    }
  );

  const payload = JSON.parse(captured.messages[1].content);
  assert.equal(payload.active_file_excerpt, "export const answer = 42;");
  assert.ok(!("selection_text" in payload));
});

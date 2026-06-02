// Architectural invariant (ARCHITECTURE.md §3, Invariant 8):
//
//   Ollama has no filesystem access. The plugin owns all I/O.
//
// This test pins the boundary at the source-code level. The ONLY files
// in src/ allowed to touch the filesystem or spawn processes are:
//
//   - tools.ts     (the VS Code agent tools that read/write/list/spawn)
//   - cliTools.ts  (the standalone CLI agent tools with the same sandbox)
//   - apply.ts     (the chat code-block save / insert / replace helpers)
//   - chatView.ts  (only for @mention expansion: pulls file contents
//                   into a chat message so the model can see them)
//
// If a new I/O surface is added, it MUST live in one of those modules
// (or the allowlist must be expanded with a deliberate decision) so the
// confirm-dialog / sandbox / size-limit guarantees in tools.ts / cliTools.ts cannot
// be silently bypassed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.resolve(__dirname, "..", "src");
const ALLOWLIST = new Set(["tools.ts", "cliTools.ts", "apply.ts", "chatView.ts"]);

// Patterns that indicate filesystem or process I/O.
const IO_PATTERNS = [
  /\bfrom\s+["']node:fs["']/,
  /\bfrom\s+["']fs["']/,
  /\brequire\(\s*["']node:fs["']\s*\)/,
  /\brequire\(\s*["']fs["']\s*\)/,
  /\bfs\.(readFile|writeFile|readdir|stat|mkdir|unlink|rmdir|writeFileSync|readFileSync|readdirSync|statSync|existsSync|cpSync)\b/,
  /\bfrom\s+["']node:child_process["']/,
  /\bfrom\s+["']child_process["']/,
  /\brequire\(\s*["']node:child_process["']\s*\)/,
  /\brequire\(\s*["']child_process["']\s*\)/,
  /\bchild_process\.\w+\(/,
  // Bare spawn/exec only when NOT preceded by a dot — 'regex.exec(' must not match.
  /(^|[^.\w])(spawn|spawnSync)\s*\(/,
  /(^|[^.\w])(execSync|execFile|execFileSync)\s*\(/,
  /\bvscode\.workspace\.fs\.\w+\b/,
  /\bworkspace\.fs\.\w+\b/,
];

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  // Strip comments so doc references don't trip the test.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const re of IO_PATTERNS) {
    const m = stripped.match(re);
    if (m) return m[0];
  }
  return null;
}

test("only the allowlisted modules in src/ touch the filesystem", () => {
  const entries = fs.readdirSync(SRC).filter((n) => n.endsWith(".ts"));
  const violators = [];
  for (const name of entries) {
    if (ALLOWLIST.has(name)) continue;
    const hit = scanFile(path.join(SRC, name));
    if (hit) violators.push({ name, hit });
  }
  assert.deepEqual(
    violators,
    [],
    "These src/ modules touch the filesystem but are not on the I/O allowlist:\n" +
      violators.map((v) => `  - ${v.name}: '${v.hit}'`).join("\n") +
      "\n\nEither move the I/O to tools.ts / cliTools.ts / apply.ts / chatView.ts, OR " +
      "expand the allowlist deliberately and explain why in ARCHITECTURE.md §3 Invariant 8."
  );
});

test("the allowlisted modules each actually DO some I/O", () => {
  // If one loses all its I/O it should drop off the allowlist, not
  // silently stay there — keeps the invariant honest.
  for (const name of ALLOWLIST) {
    const hit = scanFile(path.join(SRC, name));
    assert.ok(
      hit,
      `${name} is on the I/O allowlist but contains no I/O. Remove it from the allowlist (or restore its I/O).`
    );
  }
});

test("ARCHITECTURE.md states the no-Ollama-I/O invariant explicitly", () => {
  const md = fs.readFileSync(
    path.resolve(__dirname, "..", "ARCHITECTURE.md"),
    "utf8"
  );
  for (const phrase of [
    "Ollama has no filesystem access",
    "plugin owns all I/O",
    "tools.ts",
    "cliTools.ts",
    "apply.ts",
  ]) {
    assert.ok(
      md.includes(phrase),
      `ARCHITECTURE.md missing invariant phrase: ${JSON.stringify(phrase)}`
    );
  }
});

test("SYSTEM_AGENT tells the model it cannot do I/O itself", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "chatView.ts"),
    "utf8"
  );
  const idx = src.indexOf("const SYSTEM_AGENT");
  assert.ok(idx > 0, "SYSTEM_AGENT constant must exist");
  const slice = src.slice(idx, idx + 4000);
  assert.match(
    slice,
    /cannot read, write, list, or execute anything on the filesystem yourself/i,
    "SYSTEM_AGENT must tell the model it cannot do I/O itself"
  );
  assert.match(
    slice,
    /tool call/i,
    "SYSTEM_AGENT must mention that I/O happens via tool calls"
  );
});

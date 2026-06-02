const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { executeCliTool, resolveInsideWorkspace } = require("../out/cliTools");

async function tempWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ofc-cli-"));
}

test("CLI tools read and write inside the startup workspace", async () => {
  const root = await tempWorkspace();
  const confirmations = [];
  const opts = {
    workspaceRoot: root,
    confirm: async (message, yesLabel) => {
      confirmations.push({ message, yesLabel });
      return true;
    },
  };

  const write = await executeCliTool(
    { name: "write_file", arguments: { path: "src/hello.cpp", content: "int main() { return 0; }\n" } },
    opts
  );
  assert.match(write, /Created src\/hello\.cpp/);
  assert.equal(await fs.readFile(path.join(root, "src", "hello.cpp"), "utf8"), "int main() { return 0; }\n");
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].yesLabel, "Create");

  const read = await executeCliTool(
    { name: "read_file", arguments: { path: "src/hello.cpp" } },
    opts
  );
  assert.match(read, /File: src\/hello\.cpp/);
  assert.match(read, /1: int main\(\) \{ return 0; \}/);
});

test("CLI tools reject path traversal outside the workspace", async () => {
  const root = await tempWorkspace();
  assert.throws(() => resolveInsideWorkspace(root, "../escape.txt"), /must not contain/);

  const result = await executeCliTool(
    { name: "write_file", arguments: { path: "../escape.txt", content: "bad" } },
    { workspaceRoot: root, confirm: async () => true }
  );
  assert.match(result, /ERROR: Path must not contain/);
});

test("CLI write requires confirmation and fails closed on rejection", async () => {
  const root = await tempWorkspace();
  const result = await executeCliTool(
    { name: "write_file", arguments: { path: "nope.txt", content: "nope" } },
    { workspaceRoot: root, confirm: async () => false }
  );
  assert.equal(result, "User rejected write to nope.txt.");
  await assert.rejects(fs.readFile(path.join(root, "nope.txt"), "utf8"), /ENOENT/);
});

test("CLI run_command is disabled by default", async () => {
  const root = await tempWorkspace();
  const result = await executeCliTool(
    { name: "run_command", arguments: { command: "echo hi" } },
    { workspaceRoot: root, confirm: async () => true }
  );
  assert.match(result, /run_command is disabled by default/);
});

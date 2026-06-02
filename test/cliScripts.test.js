const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const POSIX_SCRIPTS = [
  "scripts/install-cli-ubuntu.sh",
  "scripts/install-cli-macos.sh",
  "scripts/run-cli-ubuntu.sh",
  "scripts/run-cli-macos.sh",
];
const WINDOWS_SCRIPTS = [
  "scripts/install-cli-windows.ps1",
  "scripts/run-cli-windows.ps1",
];

test("CLI POSIX scripts exist, are executable, and pass bash -n", () => {
  for (const rel of POSIX_SCRIPTS) {
    const script = path.join(ROOT, rel);
    const st = fs.statSync(script);
    assert.ok(st.isFile(), `${rel} must be a file`);
    assert.ok(st.mode & 0o100, `${rel} must be executable`);
    const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(res.status, 0, `${rel} failed bash -n:\n${res.stdout}\n${res.stderr}`);
  }
});

test("CLI Windows scripts exist and document PowerShell usage", () => {
  for (const rel of WINDOWS_SCRIPTS) {
    const script = path.join(ROOT, rel);
    const src = fs.readFileSync(script, "utf8");
    assert.ok(src.includes("PowerShell") || src.includes("pwsh"), `${rel} should document PowerShell usage`);
    assert.ok(src.includes("out\\cli.js") || src.includes("npm link"), `${rel} should target the compiled CLI app`);
  }
});

test("package exposes CLI bin aliases", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin.ofc, "./out/cli.js");
  assert.equal(pkg.bin["ollama-free-coder"], "./out/cli.js");
});

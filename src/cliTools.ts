import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { searchWeb } from "./web";
import { applySearchReplace } from "./editFile";
import { extractSymbols, renderRepoMap, RepoMapEntry } from "./repoMap";
import type { ToolCall, ToolSchema } from "./tools";

/**
 * Node/terminal implementation of the same agent tools used by the VS Code
 * extension. This is the I/O boundary for the standalone CLI app: every path is
 * sandboxed to the startup workspace and every write / shell command goes
 * through a caller-supplied confirmation callback.
 */

const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;
const MAX_FILE_BYTES_FOR_SCAN = 1024 * 1024;
const DEFAULT_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  "target",
  ".vscode",
  "vendor",
  "coverage",
]);

export interface CliToolOptions {
  workspaceRoot: string;
  requireConfirmForWrites?: boolean;
  enableRunCommand?: boolean;
  runCommandTimeoutMs?: number;
  searchBackend?: "duckduckgo" | "google";
  googleApiKey?: string;
  googleCseId?: string;
  confirm?: (message: string, yesLabel: string) => Promise<boolean>;
}

export const CLI_TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the user's workspace. Returns up to 64KB of content with line numbers. Use this to look at code before answering or editing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path, e.g. 'src/extension.ts'.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and subdirectories under a workspace-relative directory. Pass '.' for the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory path. Use '.' for the root." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description:
        "Search the workspace for a literal string or regex. Returns up to 50 matches with file:line:preview.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text or regex to search for." },
          is_regex: { type: "boolean", description: "Whether 'query' is a regex. Default false." },
          glob: { type: "string", description: "Optional include glob suffix/pattern, e.g. '.ts' or 'src/'." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Apply a SEARCH/REPLACE patch to an existing workspace file. To create a NEW file, pass an empty 'search' and put the full contents in 'replace'. The user must confirm writes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          search: { type: "string", description: "Exact text to find. Empty when creating a new file." },
          replace: { type: "string", description: "Text to put in its place." },
        },
        required: ["path", "search", "replace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map",
      description:
        "Return a compact map of the workspace: source files with top-level symbols and line numbers. Use this before read_file when you don't know where to look.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional workspace-relative subdirectory to map. Defaults to the workspace root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file in the workspace with the given content. User confirmation is required.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "Full new file contents (UTF-8)." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_editors",
      description:
        "Return the workspace context for the CLI app. In the terminal app there are no open editors, so this returns the workspace root.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace root. Disabled by default and always requires confirmation when enabled.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to execute." },
          cwd: { type: "string", description: "Optional workspace-relative working directory. Defaults to the workspace root." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web for up-to-date information. Returns top matches as title / URL / snippet lines.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: "Max results to return (1-10, default 5)." },
        },
        required: ["query"],
      },
    },
  },
];

export async function executeCliTool(call: ToolCall, opts: CliToolOptions): Promise<string> {
  try {
    switch (call.name) {
      case "read_file":
        return await readFile(opts.workspaceRoot, String(call.arguments.path ?? ""));
      case "list_files":
        return await listFiles(opts.workspaceRoot, String(call.arguments.path ?? "."));
      case "search_text":
        return await searchText(
          opts.workspaceRoot,
          String(call.arguments.query ?? ""),
          Boolean(call.arguments.is_regex),
          call.arguments.glob ? String(call.arguments.glob) : undefined
        );
      case "write_file":
        return await writeFile(
          opts,
          String(call.arguments.path ?? ""),
          String(call.arguments.content ?? "")
        );
      case "edit_file":
        return await editFileTool(
          opts,
          String(call.arguments.path ?? ""),
          String(call.arguments.search ?? ""),
          String(call.arguments.replace ?? "")
        );
      case "repo_map":
        return await repoMapTool(opts.workspaceRoot, call.arguments.path ? String(call.arguments.path) : ".");
      case "get_open_editors":
        return `CLI workspace: ${opts.workspaceRoot}\nOpen editors: (none; terminal app started in this folder)`;
      case "web_search":
        return await runWebSearch(opts, String(call.arguments.query ?? ""), Number(call.arguments.limit ?? 5));
      case "run_command":
        return await runShellCommand(opts, String(call.arguments.command ?? ""), call.arguments.cwd ? String(call.arguments.cwd) : undefined);
      default:
        return `ERROR: unknown tool '${call.name}'`;
    }
  } catch (e: any) {
    return `ERROR: ${e?.message ?? e}`;
  }
}

export function resolveInsideWorkspace(rootInput: string, rel: string): string {
  const root = path.resolve(rootInput);
  let r = String(rel).trim();
  if (r.includes("..")) throw new Error(`Path must not contain '..': ${rel}`);
  r = r.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^~\//, "").replace(/^\/+/, "");
  let abs = path.isAbsolute(r) ? path.resolve(r) : path.resolve(root, r || ".");
  if (path.isAbsolute(r)) {
    const relative = path.relative(root, abs);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Absolute path is outside the workspace: ${rel}`);
    }
  }
  const relative = path.relative(root, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

async function readFile(root: string, rel: string): Promise<string> {
  if (!rel) throw new Error("read_file: 'path' is required");
  const abs = resolveInsideWorkspace(root, rel);
  let data: Buffer;
  try {
    data = await fs.readFile(abs);
  } catch (e: any) {
    if (e?.code === "ENOENT" || /not found/i.test(String(e?.message ?? e))) {
      return `File not found: ${rel}. (Safe to create with write_file.)`;
    }
    throw e;
  }
  const slice = data.byteLength > MAX_READ_BYTES ? data.subarray(0, MAX_READ_BYTES) : data;
  const text = slice.toString("utf8");
  const numbered = text.split("\n").map((l, i) => `${String(i + 1).padStart(4, " ")}: ${l}`).join("\n");
  const truncated = data.byteLength > MAX_READ_BYTES ? `\n... [truncated: read ${MAX_READ_BYTES} of ${data.byteLength} bytes]` : "";
  return `File: ${rel} (${data.byteLength} bytes)\n${numbered}${truncated}`;
}

async function listFiles(root: string, rel: string): Promise<string> {
  const dir = rel === "." || rel === "" ? "." : rel;
  const abs = resolveInsideWorkspace(root, dir);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const sorted = entries.slice(0, MAX_LIST_ENTRIES).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const lines = sorted.map((e) => `${e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file"}  ${e.name}`);
  const more = entries.length > MAX_LIST_ENTRIES ? `\n... [${entries.length - MAX_LIST_ENTRIES} more entries truncated]` : "";
  return `Directory: ${dir}\n${lines.join("\n")}${more}`;
}

async function searchText(root: string, query: string, isRegex: boolean, glob: string | undefined): Promise<string> {
  if (!query) throw new Error("search_text: 'query' is required");
  let re: RegExp;
  try {
    re = isRegex ? new RegExp(query, "m") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m");
  } catch (e: any) {
    throw new Error(`bad regex: ${e.message}`);
  }
  const files = await collectFiles(root, ".", 1000);
  const results: string[] = [];
  for (const file of files) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (glob && !rel.includes(glob.replace(/^\*\*\//, "").replace(/\*+/g, ""))) continue;
    let data: Buffer;
    try {
      data = await fs.readFile(file);
    } catch {
      continue;
    }
    if (data.byteLength > MAX_FILE_BYTES_FOR_SCAN) continue;
    const lines = data.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  if (!results.length) return `No matches for ${isRegex ? "/" : '"'}${query}${isRegex ? "/" : '"'}.`;
  return `Found ${results.length}${results.length >= MAX_SEARCH_RESULTS ? "+" : ""} matches:\n${results.join("\n")}`;
}

async function writeFile(opts: CliToolOptions, rel: string, content: string): Promise<string> {
  if (!rel) throw new Error("write_file: 'path' is required");
  const abs = resolveInsideWorkspace(opts.workspaceRoot, rel);
  let existed = true;
  let oldText = "";
  try {
    oldText = await fs.readFile(abs, "utf8");
  } catch {
    existed = false;
  }
  if (existed && oldText === content) return `No changes: ${rel} already matches the requested content.`;
  if (opts.requireConfirmForWrites !== false) {
    const ok = await confirm(opts, `Ollama Free Coder CLI wants to ${existed ? "overwrite" : "create"} ${rel} (${content.length} chars) in ${opts.workspaceRoot}.`, existed ? "Overwrite" : "Create");
    if (!ok) return `User rejected write to ${rel}.`;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return `${existed ? "Updated" : "Created"} ${rel} (${content.length} chars).`;
}

async function editFileTool(opts: CliToolOptions, rel: string, search: string, replace: string): Promise<string> {
  if (!rel) return "ERROR: edit_file: 'path' is required";
  const abs = resolveInsideWorkspace(opts.workspaceRoot, rel);
  let oldText = "";
  let existed = true;
  try {
    oldText = await fs.readFile(abs, "utf8");
  } catch {
    existed = false;
  }
  const result = applySearchReplace(oldText, search, replace);
  if (!result.ok) return `ERROR: ${result.message}`;
  if (existed && result.newContent === oldText) return `No changes: ${rel} already matches the requested edit.`;
  if (opts.requireConfirmForWrites !== false) {
    const ok = await confirm(opts, `Ollama Free Coder CLI wants to ${existed ? "edit" : "create"} ${rel}. ${result.message}\nWorkspace: ${opts.workspaceRoot}`, existed ? "Apply" : "Create");
    if (!ok) return `User rejected edit to ${rel}.`;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, result.newContent!, "utf8");
  return `${existed ? "Edited" : "Created"} ${rel}. ${result.message}`;
}

async function repoMapTool(root: string, rel: string): Promise<string> {
  const base = resolveInsideWorkspace(root, rel || ".");
  const files = await collectFiles(root, path.relative(root, base) || ".", 2000);
  const entries: RepoMapEntry[] = [];
  for (const file of files) {
    let data: Buffer;
    try {
      data = await fs.readFile(file);
    } catch {
      continue;
    }
    if (data.byteLength > 200 * 1024) continue;
    const filename = path.relative(root, file).replace(/\\/g, "/");
    const symbols = extractSymbols(filename, data.toString("utf8"));
    if (symbols.length) entries.push({ path: filename, symbols });
  }
  if (!entries.length) return `No source files with extractable symbols under ${rel || "."}.`;
  return `Repo map (${entries.length} files):\n${renderRepoMap(entries)}`;
}

async function runWebSearch(opts: CliToolOptions, query: string, limit: number): Promise<string> {
  if (!query.trim()) return "ERROR: web_search: 'query' is required";
  const backend = opts.searchBackend ?? "duckduckgo";
  const results = await searchWeb(query, {
    backend,
    limit: Math.max(1, Math.min(10, limit || 5)),
    googleApiKey: opts.googleApiKey || undefined,
    googleCseId: opts.googleCseId || undefined,
  });
  if (!results.length) return `No web results for ${JSON.stringify(query)}.`;
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 240)}`);
  return `Search (${backend === "google" ? "Google CSE" : "DuckDuckGo"}) for "${query}":\n${lines.join("\n")}`;
}

async function runShellCommand(opts: CliToolOptions, command: string, cwdRel: string | undefined): Promise<string> {
  if (!command.trim()) return "ERROR: run_command: 'command' is required";
  if (!opts.enableRunCommand) {
    return "ERROR: run_command is disabled by default. Restart the CLI with --enable-run-command if you trust the agent to execute shell commands.";
  }
  const cwd = cwdRel ? resolveInsideWorkspace(opts.workspaceRoot, cwdRel) : opts.workspaceRoot;
  const ok = await confirm(opts, `Ollama Free Coder CLI wants to run:\n\n  ${command}\n\nin ${cwd}`, "Run");
  if (!ok) return `User rejected the command: ${command}`;
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWin ? ["/c", command] : ["-c", command];
  const timeoutMs = opts.runCommandTimeoutMs ?? 30000;
  return await new Promise<string>((resolve) => {
    const child = spawn(shell, shellArgs, { cwd, env: process.env });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const max = 16 * 1024;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    const onData = (b: Buffer) => {
      if (bytes >= max) return;
      const room = max - bytes;
      chunks.push(b.length <= room ? b : b.subarray(0, room));
      bytes += Math.min(b.length, room);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`ERROR: failed to spawn shell: ${e.message}`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const body = Buffer.concat(chunks).toString("utf8");
      const trailer = bytes >= max ? "\n... [truncated to 16KB]" : "";
      if (killed) {
        resolve(`command killed after ${timeoutMs}ms timeout. Output so far:\n${body}${trailer}`);
        return;
      }
      const tag = code === 0 ? "exit 0" : signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
      resolve(`Command finished (${tag}). Output:\n${body}${trailer}`);
    });
  });
}

export function openExternalUrl(url: string): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const cmd = isWin ? "cmd.exe" : isMac ? "open" : "xdg-open";
    const args = isWin ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => resolve(`ERROR: could not open ${url}: ${e.message}`));
    child.unref();
    resolve(`Opened ${url}`);
  });
}

async function collectFiles(root: string, rel: string, max: number): Promise<string[]> {
  const start = resolveInsideWorkspace(root, rel || ".");
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      if (DEFAULT_EXCLUDES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  await walk(start);
  return out;
}

async function confirm(opts: CliToolOptions, message: string, yesLabel: string): Promise<boolean> {
  if (!opts.confirm) return false;
  return await opts.confirm(message, yesLabel);
}

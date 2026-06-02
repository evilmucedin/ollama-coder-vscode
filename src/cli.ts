#!/usr/bin/env node
import * as path from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { chatFull, ChatMessage } from "./ollama";
import { runAgentLoop } from "./agentLoop";
import { routeWithModel, RoutePlan } from "./router";
import { detectProblemRef } from "./problemRef";
import { parsePlayIntent, normalizeService, buildMusicUrl, SERVICE_LABEL, MusicService } from "./music";
import { CLI_TOOL_SCHEMAS, executeCliTool, openExternalUrl, CliToolOptions } from "./cliTools";

const SYSTEM_CLI_AGENT =
  "You are Ollama Free Coder, an autonomous coding agent running locally in a terminal app.\n" +
  "The app was started in the user's current folder; treat that folder exactly like VS Code's first workspace folder.\n" +
  "IMPORTANT: you cannot read, write, list, or execute anything on the filesystem yourself. " +
  "Every read/write/run goes through the terminal app via a tool call. Writes and shell commands require user confirmation. " +
  "Saying 'I created the file' without calling write_file or edit_file means nothing was written.\n\n" +
  "Use tools to inspect and change the workspace. For a brand-new file, call edit_file with an empty search or write_file immediately. " +
  "If the user asks for a competitive-programming solution, create a source file in the workspace. " +
  "Respect the requested language and choose a sensible filename, e.g. leetcode_2222.cpp for a C++ LeetCode 2222 request. " +
  "For existing-file edits, read_file first, then use edit_file with a minimal SEARCH/REPLACE patch. " +
  "After changing files, give a short summary instead of pasting the whole file.";

interface CliConfig {
  endpoint: string;
  model: string;
  routerModel: string;
  workspaceRoot: string;
  maxSteps: number;
  temperature: number;
  enableRunCommand: boolean;
  runCommandTimeoutMs: number;
  musicService: MusicService;
  searchBackend: "duckduckgo" | "google";
  googleApiKey: string;
  googleCseId: string;
  oneShotPrompt?: string;
}

function parseArgs(argv: string[]): CliConfig {
  const cfg: CliConfig = {
    endpoint: process.env.OLLAMA_HOST || process.env.OLLAMA_CODER_ENDPOINT || "http://localhost:11434",
    model: process.env.OLLAMA_CODER_MODEL || process.env.OLLAMA_MODEL || "llama3.1:8b",
    routerModel: process.env.OLLAMA_CODER_ROUTER_MODEL || process.env.OLLAMA_CODER_MODEL || process.env.OLLAMA_MODEL || "qwen2.5-coder:1.5b-base",
    workspaceRoot: process.cwd(),
    maxSteps: Number(process.env.OLLAMA_CODER_AGENT_MAX_STEPS || 8),
    temperature: Number(process.env.OLLAMA_CODER_TEMPERATURE || 0.2),
    enableRunCommand: process.env.OLLAMA_CODER_ENABLE_RUN_COMMAND === "1",
    runCommandTimeoutMs: Number(process.env.OLLAMA_CODER_RUN_COMMAND_TIMEOUT_MS || 30000),
    musicService: normalizeService(process.env.OLLAMA_CODER_MUSIC_SERVICE, "amazon"),
    searchBackend: process.env.OLLAMA_CODER_SEARCH_BACKEND === "google" ? "google" : "duckduckgo",
    googleApiKey: process.env.OLLAMA_CODER_GOOGLE_API_KEY || "",
    googleCseId: process.env.OLLAMA_CODER_GOOGLE_CSE_ID || "",
  };

  const promptParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || "";
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--endpoint") {
      cfg.endpoint = next();
    } else if (a === "--model" || a === "-m") {
      cfg.model = next();
    } else if (a === "--router-model") {
      cfg.routerModel = next();
    } else if (a === "--cwd") {
      cfg.workspaceRoot = path.resolve(next());
    } else if (a === "--max-steps") {
      cfg.maxSteps = Number(next());
    } else if (a === "--enable-run-command") {
      cfg.enableRunCommand = true;
    } else if (a === "--music-service") {
      cfg.musicService = normalizeService(next(), cfg.musicService);
    } else if (a === "--search-backend") {
      cfg.searchBackend = next() === "google" ? "google" : "duckduckgo";
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      promptParts.push(a);
    }
  }
  if (promptParts.length) cfg.oneShotPrompt = promptParts.join(" ");
  return cfg;
}

function printHelp() {
  console.log(`Ollama Free Coder CLI\n\nUsage:\n  ollama-free-coder [options]\n  ollama-free-coder [options] "Generate a new C++ solution of LeetCode problem 2222"\n\nOptions:\n  -m, --model MODEL          Chat/agent model (default: llama3.1:8b)\n      --router-model MODEL   Small router model (default: qwen2.5-coder:1.5b-base)\n      --endpoint URL         Ollama endpoint (default: OLLAMA_HOST or http://localhost:11434)\n      --cwd DIR              Workspace folder (default: current directory)\n      --max-steps N          Max tool-calling rounds (default: 8)\n      --enable-run-command   Allow the run_command tool, still with per-call confirmation\n      --music-service NAME   amazon | spotify | youtube | apple (default: amazon)\n      --search-backend NAME  duckduckgo | google (default: duckduckgo)\n  -h, --help                 Show help\n\nEnvironment mirrors the VS Code settings where possible: OLLAMA_CODER_MODEL,\nOLLAMA_CODER_ROUTER_MODEL, OLLAMA_CODER_MUSIC_SERVICE, OLLAMA_CODER_SEARCH_BACKEND,\nOLLAMA_CODER_GOOGLE_API_KEY, OLLAMA_CODER_GOOGLE_CSE_ID.`);
}

async function main() {
  let cfg: CliConfig;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (e: any) {
    console.error(e?.message ?? e);
    printHelp();
    process.exitCode = 2;
    return;
  }

  const rl = createInterface({ input, output });
  const confirm = async (message: string, yesLabel: string): Promise<boolean> => {
    console.log(`\n${message}`);
    const answer = (await rl.question(`${yesLabel}? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };

  console.log(`Ollama Free Coder CLI`);
  console.log(`Workspace: ${cfg.workspaceRoot}`);
  console.log(`Model: ${cfg.model}  Endpoint: ${cfg.endpoint}`);
  console.log(`Type /exit to quit. Writes and shell commands require confirmation.\n`);

  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_CLI_AGENT }];
  try {
    if (cfg.oneShotPrompt) {
      await handleTurn(cfg.oneShotPrompt, cfg, messages, confirm);
    } else {
      for (;;) {
        const text = (await rl.question("ofc> ")).trim();
        if (!text) continue;
        if (/^\/(exit|quit|q)$/i.test(text)) break;
        if (/^\/(help|h)$/i.test(text)) {
          printHelp();
          continue;
        }
        await handleTurn(text, cfg, messages, confirm);
      }
    }
  } finally {
    rl.close();
  }
}

async function handleTurn(
  userText: string,
  cfg: CliConfig,
  messages: ChatMessage[],
  confirm: (message: string, yesLabel: string) => Promise<boolean>
): Promise<void> {
  const route = await routeWithModel({
    endpoint: cfg.endpoint,
    model: cfg.routerModel,
    userText,
    hasSelection: false,
    activeFile: undefined,
    openFiles: [],
    timeoutMs: 5000,
  });

  const play = musicPlan(userText, route, cfg.musicService);
  if (play) {
    const url = buildMusicUrl(play.query, play.service);
    console.log(`Opening ${SERVICE_LABEL[play.service]} for ${JSON.stringify(play.query)}...`);
    console.log(await openExternalUrl(url));
    return;
  }

  const augmented = augmentPrompt(userText, route, cfg.workspaceRoot);
  messages.push({ role: "user", content: augmented });

  const toolOpts: CliToolOptions = {
    workspaceRoot: cfg.workspaceRoot,
    requireConfirmForWrites: true,
    enableRunCommand: cfg.enableRunCommand,
    runCommandTimeoutMs: cfg.runCommandTimeoutMs,
    searchBackend: cfg.searchBackend,
    googleApiKey: cfg.googleApiKey,
    googleCseId: cfg.googleCseId,
    confirm,
  };

  const result = await runAgentLoop(
    {
      endpoint: cfg.endpoint,
      model: cfg.model,
      messages,
      tools: CLI_TOOL_SCHEMAS,
      temperature: cfg.temperature,
      maxSteps: cfg.maxSteps,
    },
    {
      chat: (opts) => chatFull(opts),
      executeTool: (call) => executeCliTool(call, toolOpts),
      onAssistantStart: () => process.stdout.write("\nassistant> "),
      onAssistantToken: (t) => process.stdout.write(t),
      onAssistantEnd: () => process.stdout.write("\n\n"),
      onToolCall: (name, args) => {
        process.stdout.write(`\n\n[tool] ${name} ${JSON.stringify(args)}\n`);
      },
      onToolResult: (_name, preview) => {
        process.stdout.write(`[tool result] ${preview.slice(0, 500)}${preview.length > 500 ? "..." : ""}\n`);
      },
      onStoppedAtMaxSteps: (steps) => {
        process.stdout.write(`\n[stopped after ${steps} agent steps]\n`);
      },
    }
  );

  messages.splice(0, messages.length, ...result.messages);
}

function musicPlan(
  userText: string,
  route: RoutePlan | null,
  fallbackService: MusicService
): { query: string; service: MusicService } | null {
  if (route?.kind === "play_music" && route.music_query) {
    return {
      query: route.music_query,
      service: normalizeService(route.music_service, fallbackService),
    };
  }
  const slash = userText.match(/^\s*\/(play|music)\s+([\s\S]+)$/i);
  const parsed = parsePlayIntent(slash ? `play ${slash[2].trim()}` : userText);
  if (!parsed) return null;
  return { query: parsed.query, service: normalizeService(parsed.service, fallbackService) };
}

function augmentPrompt(userText: string, route: RoutePlan | null, workspaceRoot: string): string {
  const lines = [
    userText,
    "",
    `Workspace root: ${workspaceRoot}`,
    "The terminal app was started in this folder; use workspace-relative paths for all tools.",
  ];
  if (route) {
    lines.push("", `Router plan: ${JSON.stringify(route)}`);
    if (route.kind === "create_file" && route.target_path) {
      lines.push(`Create the requested file at ${route.target_path}.`);
    } else if (route.kind === "edit_file" && route.target_path) {
      lines.push(`Edit the requested file at ${route.target_path}.`);
    } else if (route.kind === "web_search_then_chat" || route.needs_web) {
      lines.push("Use web_search before answering.");
    }
  }
  const problem = route?.problem_source && route.problem_id
    ? { source: route.problem_source, id: route.problem_id }
    : detectProblemRef(userText);
  if (problem) {
    lines.push("", `Competitive-programming reference: ${problem.source} ${problem.id}. Generate a complete solution file unless the user explicitly asked only to chat.`);
  }
  return lines.join("\n");
}

main().catch((e: any) => {
  console.error(`Fatal: ${e?.message ?? e}`);
  process.exitCode = 1;
});

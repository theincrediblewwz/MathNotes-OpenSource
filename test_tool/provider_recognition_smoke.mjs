import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

if (!args.imagePath) {
  printUsage();
  process.exit(1);
}

const imagePath = isAbsolute(args.imagePath) ? args.imagePath : resolve(process.cwd(), args.imagePath);
if (!existsSync(imagePath)) {
  console.error(`[provider-smoke] image not found: ${imagePath}`);
  process.exit(1);
}

const notesRoot = args.rootDir ?? defaultNotesRoot();
const configPath = join(notesRoot, "settings", "provider.json");
const config = readProviderConfig(configPath);
const prompt = buildFaithfulTranscriptionPrompt(args.context);

console.log(`[provider-smoke] notesRoot: ${notesRoot}`);
console.log(`[provider-smoke] config: ${configPath}`);
console.log(`[provider-smoke] provider: ${config.providerId}`);
console.log(`[provider-smoke] image: ${imagePath}`);

if (config.providerId === "mock" || args.mock) {
  const markdown = [
    `--- source: ${basename(imagePath)} | provider: mock ---`,
    "",
    "## Mock faithful transcription",
    "",
    `已收到图片：${basename(imagePath)}`,
    "",
    "[mock_provider_used]"
  ].join("\n");
  printMarkdown(markdown);
  process.exit(0);
}

if (config.providerId !== "codex_cli") {
  console.error(`[provider-smoke] provider ${config.providerId} is not supported by this smoke harness yet.`);
  console.error("[provider-smoke] supported providers: mock, codex_cli");
  process.exit(2);
}

const commandSpec = buildCodexCommand({
  config,
  imagePath,
  prompt
});

console.log(`[provider-smoke] runtime: ${config.codexRuntime ?? "windows"}`);
console.log(`[provider-smoke] command: ${commandSpec.command}`);
console.log(`[provider-smoke] args: ${commandSpec.args.map(quoteArg).join(" ")}`);

if (args.dryRun) {
  console.log("[provider-smoke] dry-run complete; no provider process was started.");
  process.exit(0);
}

const startedAt = performance.now();
console.log("[provider-smoke] starting provider process...");

const child = spawn(commandSpec.command, commandSpec.args, {
  cwd: dirname(imagePath),
  env: process.env,
  windowsHide: true,
  shell: false
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdout += text;
  process.stdout.write(text);
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderr += text;
  process.stderr.write(text);
});

const timeout = Number(args.timeoutMs ?? 240000);
const timer = setTimeout(() => {
  child.kill();
  console.error(`[provider-smoke] timed out after ${timeout}ms`);
}, timeout);

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(`[provider-smoke] failed to start provider: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  clearTimeout(timer);
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log("");
  console.log(`[provider-smoke] exitCode: ${code}`);
  console.log(`[provider-smoke] elapsedMs: ${elapsedMs}`);
  console.log(`[provider-smoke] stdoutChars: ${stdout.length}`);
  console.log(`[provider-smoke] stderrChars: ${stderr.length}`);

  if (code !== 0) {
    process.exit(code ?? 1);
  }

  const markdown = stdout.trim();
  if (!markdown) {
    console.error("[provider-smoke] provider returned empty stdout.");
    process.exit(1);
  }

  console.log("[provider-smoke] markdown preview:");
  printMarkdown(markdown.slice(0, 2000));
});

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--mock") parsed.mock = true;
    else if (arg === "--root") parsed.rootDir = rawArgs[++index];
    else if (arg === "--timeout-ms") parsed.timeoutMs = rawArgs[++index];
    else if (arg === "--context") parsed.context = rawArgs[++index];
    else if (!parsed.imagePath) parsed.imagePath = arg;
    else {
      console.error(`[provider-smoke] unexpected argument: ${arg}`);
      process.exit(1);
    }
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node test_tool/provider_recognition_smoke.mjs <imagePath> [--dry-run] [--timeout-ms 240000]

Examples:
  node test_tool/provider_recognition_smoke.mjs "C:\\path\\photo.png" --dry-run
  node test_tool/provider_recognition_smoke.mjs "C:\\path\\photo.png" --timeout-ms 300000

Options:
  --dry-run       Print the provider command without running it.
  --mock          Force mock output, ignoring provider.json.
  --root <dir>    Override notes root. Defaults to MATHNOTES_ROOT or Electron dev userData.
  --context <txt> Add context to the faithful transcription prompt.
`);
}

function readProviderConfig(path) {
  if (!existsSync(path)) {
    return {
      providerId: "mock",
      model: "mock-faithful-markdown",
      apiKeyEnvVar: "OPENAI_API_KEY"
    };
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultNotesRoot() {
  if (process.env.MATHNOTES_ROOT) return process.env.MATHNOTES_ROOT;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming"), "Electron", "MyMathNotes");
  }
  return join(process.env.HOME ?? process.cwd(), ".config", "Electron", "MyMathNotes");
}

function buildCodexCommand({ config, imagePath, prompt }) {
  const runtime = config.codexRuntime === "wsl" ? "wsl" : "windows";
  const codexCommand = config.commandPath || "codex";
  const codexArgs = [
    "exec",
    "--sandbox",
    "read-only",
    ...(config.model?.trim() ? ["--model", config.model.trim()] : []),
    "--image",
    runtime === "wsl" ? windowsPathToWslPath(imagePath) : imagePath,
    prompt
  ];

  if (runtime === "wsl") {
    return {
      command: "wsl.exe",
      args: [
        ...(config.wslDistro?.trim() ? ["--distribution", config.wslDistro.trim()] : []),
        "--exec",
        codexCommand,
        ...codexArgs
      ]
    };
  }

  return {
    command: codexCommand,
    args: codexArgs
  };
}

function windowsPathToWslPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!driveMatch) return normalized;
  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
}

function buildFaithfulTranscriptionPrompt(context) {
  return [
    "你将看到一张或多张数学板书/手写笔记/书页照片。请忠实转写为 Markdown。",
    "不要总结、不要润色、不要改写、不要补充证明。",
    "保持原始顺序。能识别的数学公式用 Markdown 中适合显示的形式表达。",
    "尽量保持原照片中的换行、分组、缩进、编号、箭头关系和公式排版；如果原图是分栏、列表或逐行推导，也请用 Markdown 中接近的布局呈现。",
    "看不清的地方标记为 \"[看不清]\"。不确定的符号标记为 \"[不确定：...]\"。",
    "不要生成完整 LaTeX 文档，不要添加 \"\\documentclass\"，不要输出解释性废话，只输出 Markdown 草稿内容。",
    context ? `上下文：${context}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function quoteArg(arg) {
  return /[\s"'|&<>]/.test(arg) ? JSON.stringify(arg) : arg;
}

function printMarkdown(markdown) {
  console.log("----- BEGIN MARKDOWN -----");
  console.log(markdown);
  console.log("----- END MARKDOWN -----");
}

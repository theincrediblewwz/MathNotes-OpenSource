import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { AssistantProvider, RecognitionProvider, RecognitionProviderEvent, RecognitionResult } from "@mathnotes/shared";
import { buildAssistantPrompt } from "./assistantPrompt";
import { buildFaithfulTranscriptionPrompt } from "./faithfulTranscriptionPrompt";

export type SpawnLike = (command: string, args: string[], options?: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export type CodexCliRuntime = "windows" | "wsl";

export type CodexCliRecognitionProviderArgs = {
  commandPath: string;
  runtime?: CodexCliRuntime;
  wslCommandPath?: string;
  wslDistro?: string;
  model?: string;
  timeoutMs?: number;
  promptTemplateContent?: string;
  spawnImpl?: SpawnLike;
};

export type CodexCliAvailability = {
  ok: boolean;
  detail: string;
};

export class CodexCliRecognitionProvider implements RecognitionProvider, AssistantProvider {
  readonly name = "codex_cli";
  private readonly spawnImpl: SpawnLike;

  constructor(private readonly args: CodexCliRecognitionProviderArgs) {
    this.spawnImpl = args.spawnImpl ?? ((command, commandArgs, options) => spawn(command, commandArgs, options));
  }

  async transcribe(input: Parameters<RecognitionProvider["transcribe"]>[0]): ReturnType<RecognitionProvider["transcribe"]> {
    return this.transcribeWithEvents({
      ...input,
      onEvent: () => undefined
    });
  }

  async transcribeWithEvents(
    input: Parameters<NonNullable<RecognitionProvider["transcribeWithEvents"]>>[0]
  ): ReturnType<RecognitionProvider["transcribe"]> {
    const prompt = buildFaithfulTranscriptionPrompt(input.context, this.args.promptTemplateContent);
    return this.runWithEvents({ ...input, prompt, taskLabel: "transcription" });
  }

  async assist(input: Parameters<AssistantProvider["assist"]>[0]): ReturnType<AssistantProvider["assist"]> {
    return this.assistWithEvents({ ...input, onEvent: () => undefined });
  }

  async assistWithEvents(
    input: Parameters<NonNullable<AssistantProvider["assistWithEvents"]>>[0]
  ): ReturnType<AssistantProvider["assist"]> {
    return this.runWithEvents({ ...input, prompt: buildAssistantPrompt(input), taskLabel: "assistant" });
  }

  private async runWithEvents(input: {
    imagePaths: string[];
    abortSignal?: AbortSignal;
    onEvent: (event: RecognitionProviderEvent) => void;
    prompt: string;
    taskLabel: "transcription" | "assistant";
  }): Promise<RecognitionResult> {
    const { command, args } = buildCodexTranscriptionCommand({
      ...this.args,
      imagePaths: input.imagePaths,
      prompt: input.prompt
    });

    input.onEvent({
      type: "started",
      message: `${command} ${args.map(quoteCommandArg).join(" ")}`
    });

    const { stdout, stderr, code } = await runProcess(this.spawnImpl(command, args, { windowsHide: true }), {
      timeoutMs: this.args.timeoutMs,
      stdinText: input.prompt,
      abortSignal: input.abortSignal,
      onStdout: (text) =>
        input.onEvent({
          type: "stdout",
          text
        }),
      onStderr: (text) =>
        input.onEvent({
          type: "stderr",
          text
        })
    });

    input.onEvent({
      type: "completed",
      message: `Codex CLI exited with code ${code}`
    });

    if (code !== 0) {
      throw new Error(`Codex CLI ${input.taskLabel} failed: ${code} ${stderr || stdout || "unknown error"}`.trim());
    }

    const markdown = stdout.trim();
    if (!markdown) {
      throw new Error(`Codex CLI ${input.taskLabel} failed: empty stdout`);
    }

    return {
      markdown,
      warnings: stderr ? [stderr] : undefined,
      rawResponse: stdout
    };
  }
}

export async function checkCodexCliAvailability(args: CodexCliRecognitionProviderArgs): Promise<CodexCliAvailability> {
  const spawnImpl = args.spawnImpl ?? ((command, commandArgs, options) => spawn(command, commandArgs, options));
  const command = buildCodexHealthCheckCommand(args);
  const { stdout, stderr, code } = await runProcess(spawnImpl(command.command, command.args, { windowsHide: true }), { timeoutMs: args.timeoutMs });
  const detail = (stdout || stderr || "no output").trim();
  return {
    ok: code === 0,
    detail
  };
}

function buildCodexTranscriptionCommand(args: CodexCliRecognitionProviderArgs & { imagePaths: string[]; prompt: string }): {
  command: string;
  args: string[];
} {
  const runtime = args.runtime ?? "windows";
  const codexCommand = args.commandPath || "codex";
  const runtimeImagePaths = imagePathsForRuntime(args.imagePaths, runtime);
  const codexArgs = [
    "exec",
    "--sandbox",
    "read-only",
    ...(args.model?.trim() ? ["--model", args.model.trim()] : []),
    ...(runtimeImagePaths.length > 0 ? ["--image", runtimeImagePaths.join(",")] : [])
  ];

  if (runtime === "wsl") {
    return {
      command: args.wslCommandPath || "wsl.exe",
      args: [...wslPrefixArgs(args.wslDistro), "--exec", codexCommand, ...codexArgs]
    };
  }

  return {
    command: codexCommand,
    args: codexArgs
  };
}

function buildCodexHealthCheckCommand(args: CodexCliRecognitionProviderArgs): { command: string; args: string[] } {
  const runtime = args.runtime ?? "windows";
  const codexCommand = args.commandPath || "codex";
  if (runtime === "wsl") {
    return {
      command: args.wslCommandPath || "wsl.exe",
      args: [...wslPrefixArgs(args.wslDistro), "--exec", codexCommand, "--version"]
    };
  }

  return {
    command: codexCommand,
    args: ["--version"]
  };
}

function imagePathsForRuntime(imagePaths: string[], runtime: CodexCliRuntime): string[] {
  if (runtime !== "wsl") {
    return imagePaths;
  }

  return imagePaths.map(windowsPathToWslPath);
}

export function windowsPathToWslPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }

  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return path.replace(/\\/g, "/");
  }

  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function wslPrefixArgs(wslDistro?: string): string[] {
  const distro = wslDistro?.trim();
  return distro ? ["--distribution", distro] : [];
}

function runProcess(
  child: ChildProcessWithoutNullStreams,
  listeners: {
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    stdinText?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeoutMs = listeners.timeoutMs ?? 120_000;
    const abort = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      reject(new Error("Recognition task cancelled by user"));
    };
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`Codex CLI transcription timed out after ${timeoutMs}ms. 请稍后在任务面板手动重试。`));
          }, timeoutMs)
        : undefined;
    if (listeners.abortSignal?.aborted) {
      abort();
      return;
    }
    listeners.abortSignal?.addEventListener("abort", abort, { once: true });

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      listeners.abortSignal?.removeEventListener("abort", abort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      listeners.onStdout?.(decodeProcessChunk(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      listeners.onStderr?.(decodeProcessChunk(chunk));
    });
    if (listeners.stdinText !== undefined) {
      child.stdin.write(listeners.stdinText);
      child.stdin.end();
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: decodeProcessChunk(Buffer.concat(stdout)),
        stderr: decodeProcessChunk(Buffer.concat(stderr)).trim(),
        code: code ?? 1
      });
    });
  });
}

function decodeProcessChunk(chunk: Buffer): string {
  const candidates = [chunk.toString("utf8")];

  try {
    candidates.push(new TextDecoder("gb18030").decode(chunk));
  } catch {
    // Older runtimes may not expose gb18030. UTF-8 remains the fallback.
  }

  if (looksLikeUtf16Le(chunk)) {
    candidates.push(new TextDecoder("utf-16le").decode(chunk));
  }

  return candidates.sort((left, right) => decodedTextScore(left) - decodedTextScore(right))[0];
}

function looksLikeUtf16Le(chunk: Buffer): boolean {
  if (chunk.length < 4) return false;
  let oddNulls = 0;
  let evenNulls = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] !== 0) continue;
    if (index % 2 === 0) {
      evenNulls += 1;
    } else {
      oddNulls += 1;
    }
  }
  return Math.max(oddNulls, evenNulls) >= Math.floor(chunk.length / 4);
}

function decodedTextScore(value: string): number {
  const replacementPenalty = (value.match(/\uFFFD/g) ?? []).length * 1000;
  const nullPenalty = (value.match(/\u0000/g) ?? []).length * 120;
  const controlPenalty = [...value].filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== "\n" && char !== "\r" && char !== "\t";
  }).length * 40;
  const mojibakePenalty = (value.match(/[ÃÂâ€�妫娴鎵閰嶇疆]/g) ?? []).length * 8;
  return replacementPenalty + nullPenalty + controlPenalty + mojibakePenalty;
}

function quoteCommandArg(arg: string): string {
  return /[\s"'|&<>]/.test(arg) ? JSON.stringify(arg) : arg;
}

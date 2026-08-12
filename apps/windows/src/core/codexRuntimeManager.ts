import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnLike } from "./codexCliRecognitionProvider";
import type { RecognitionProviderConfig } from "./providerConfigStore";

export type CodexRuntimeStatus = "stopped" | "starting" | "ready" | "error";

export type CodexRuntimeState = {
  status: CodexRuntimeStatus;
  progress: number;
  detail: string;
  command?: string;
  endpoint?: string;
  updatedAt: string;
};

type CodexRuntimeManagerArgs = {
  spawnImpl?: SpawnLike;
  readyTimeoutMs?: number;
  optimisticReadyMs?: number;
  now?: () => string;
};

type RuntimeCommand = {
  command: string;
  args: string[];
};

const stoppedState = (now: () => string): CodexRuntimeState => ({
  status: "stopped",
  progress: 0,
  detail: "Codex CLI runtime 未启动。",
  updatedAt: now()
});

export class CodexRuntimeManager {
  private readonly spawnImpl: SpawnLike;
  private readonly readyTimeoutMs: number;
  private readonly optimisticReadyMs: number;
  private readonly now: () => string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<CodexRuntimeState> | null = null;
  private state: CodexRuntimeState;
  private listeners = new Set<(state: CodexRuntimeState) => void>();
  private runtimeKey = "";

  constructor(args: CodexRuntimeManagerArgs = {}) {
    this.spawnImpl = args.spawnImpl ?? ((command, commandArgs, options) => spawn(command, commandArgs, options));
    this.readyTimeoutMs = args.readyTimeoutMs ?? 20_000;
    this.optimisticReadyMs = args.optimisticReadyMs ?? 1_200;
    this.now = args.now ?? (() => new Date().toISOString());
    this.state = stoppedState(this.now);
  }

  getState(): CodexRuntimeState {
    return this.state;
  }

  onStateChanged(listener: (state: CodexRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ensureStarted(config: RecognitionProviderConfig): Promise<CodexRuntimeState> {
    if (config.providerId !== "codex_cli") {
      this.stop();
      return this.getState();
    }

    const runtimeKey = JSON.stringify({
      commandPath: config.commandPath,
      runtime: config.codexRuntime,
      wslDistro: config.wslDistro
    });

    if ((this.state.status === "ready" || this.state.status === "starting") && this.child && this.runtimeKey === runtimeKey) {
      return this.startPromise ?? Promise.resolve(this.state);
    }

    this.stop();
    this.runtimeKey = runtimeKey;
    const runtimeCommand = buildCodexRuntimeCommand(config);
    this.setState({
      status: "starting",
      progress: 15,
      detail: "Codex CLI runtime 正在启动。",
      command: `${runtimeCommand.command} ${runtimeCommand.args.map(quoteCommandArg).join(" ")}`,
      updatedAt: this.now()
    });

    this.child = this.spawnImpl(runtimeCommand.command, runtimeCommand.args, { windowsHide: true });
    this.startPromise = this.waitUntilReady(this.child);
    return this.startPromise;
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
    }
    this.child = null;
    this.startPromise = null;
    this.runtimeKey = "";
    this.setState(stoppedState(this.now));
  }

  private waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<CodexRuntimeState> {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (this.child !== child) return;
        if (settled) return;
        settled = true;
        clearTimeout(optimisticReadyTimer);
        child.kill();
        this.child = null;
        this.startPromise = null;
        const state = this.setState({
          status: "error",
          progress: 0,
          detail: `Codex CLI runtime 启动超时：${this.readyTimeoutMs}ms。`,
          updatedAt: this.now()
        });
        resolve(state);
      }, this.readyTimeoutMs);
      const optimisticReadyTimer = setTimeout(() => {
        if (this.child !== child) return;
        if (settled) return;
        this.setState({
          ...this.state,
          status: "starting",
          progress: Math.max(this.state.progress, 45),
          detail: "Codex CLI runtime 已启动进程，正在等待 app-server 地址。",
          updatedAt: this.now()
        });
      }, this.optimisticReadyMs);

      const onChunk = (chunk: Buffer) => {
        if (this.child !== child) return;
        if (settled) return;
        const text = chunk.toString("utf8");
        const endpoint = extractEndpoint(text);
        this.setState({
          ...this.state,
          status: "starting",
          progress: Math.max(this.state.progress, 65),
          detail: text.trim() || "Codex CLI runtime 正在输出启动日志。",
          endpoint: endpoint ?? this.state.endpoint,
          updatedAt: this.now()
        });
        if (!endpoint) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        clearTimeout(optimisticReadyTimer);
        const readyState = this.setState({
          ...this.state,
          status: "ready",
          progress: 100,
          detail: "Codex CLI runtime 已启动，随时准备接收图片。",
          endpoint: endpoint ?? this.state.endpoint,
          updatedAt: this.now()
        });
        resolve(readyState);
      };

      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.on("error", (error) => {
        if (this.child !== child) return;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(optimisticReadyTimer);
        this.child = null;
        this.startPromise = null;
        const state = this.setState({
          status: "error",
          progress: 0,
          detail: error.message,
          updatedAt: this.now()
        });
        resolve(state);
      });
      child.on("close", (code) => {
        if (this.child !== child && this.state.status === "stopped") {
          clearTimeout(timeout);
          clearTimeout(optimisticReadyTimer);
          if (!settled) {
            settled = true;
            resolve(this.state);
          }
          return;
        }
        clearTimeout(timeout);
        clearTimeout(optimisticReadyTimer);
        this.child = null;
        this.startPromise = null;
        if (settled) {
          if (this.state.status === "ready") {
            this.setState({
              status: "error",
              progress: 0,
              detail: `Codex CLI runtime 已退出：${code ?? 1}`,
              updatedAt: this.now()
            });
          }
          return;
        }
        settled = true;
        const state = this.setState({
          status: "error",
          progress: 0,
          detail: `Codex CLI runtime exited before ready: ${code ?? 1}`,
          updatedAt: this.now()
        });
        resolve(state);
      });
    });
  }

  private setState(nextState: CodexRuntimeState): CodexRuntimeState {
    this.state = nextState;
    for (const listener of this.listeners) {
      listener(nextState);
    }
    return nextState;
  }
}

export function buildCodexRuntimeCommand(config: RecognitionProviderConfig): RuntimeCommand {
  const runtime = config.codexRuntime ?? "windows";
  const codexCommand = config.commandPath?.trim() || "codex";
  const codexArgs = ["app-server", "--listen", "ws://127.0.0.1:0"];

  if (runtime === "wsl") {
    return {
      command: "wsl.exe",
      args: [...(config.wslDistro?.trim() ? ["--distribution", config.wslDistro.trim()] : []), "--exec", codexCommand, ...codexArgs]
    };
  }

  return {
    command: codexCommand,
    args: codexArgs
  };
}

function extractEndpoint(text: string): string | undefined {
  return /ws:\/\/[^\s'"]+/.exec(text)?.[0];
}

function quoteCommandArg(arg: string): string {
  return /[\s"'|&<>]/.test(arg) ? JSON.stringify(arg) : arg;
}

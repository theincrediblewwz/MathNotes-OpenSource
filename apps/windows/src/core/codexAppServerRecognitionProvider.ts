import type { AssistantProvider, RecognitionProvider, RecognitionProviderEvent, RecognitionResult } from "@mathnotes/shared";
import { CodexAppServerClient, type JsonRpcNotification } from "./codexAppServerClient";
import { windowsPathToWslPath, type CodexCliRuntime } from "./codexCliRecognitionProvider";
import { buildFaithfulTranscriptionPrompt } from "./faithfulTranscriptionPrompt";
import { buildAssistantPrompt } from "./assistantPrompt";

export type CodexAppServerClientLike = {
  connect(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(listener: (message: JsonRpcNotification) => void): () => void;
  close(): void;
};

export type CodexAppServerRecognitionProviderArgs = {
  endpoint: string;
  cwd: string;
  runtime?: CodexCliRuntime;
  model?: string;
  timeoutMs?: number;
  promptTemplateContent?: string;
  clientFactory?: (endpoint: string) => CodexAppServerClientLike;
};

type ThreadStartResponse = {
  thread: {
    id: string;
  };
};

type AgentDeltaParams = {
  delta?: string;
};

export class CodexAppServerRecognitionProvider implements RecognitionProvider, AssistantProvider {
  readonly name = "codex_app_server";

  constructor(private readonly args: CodexAppServerRecognitionProviderArgs) {}

  async transcribe(input: Parameters<RecognitionProvider["transcribe"]>[0]): ReturnType<RecognitionProvider["transcribe"]> {
    return this.transcribeWithEvents({
      ...input,
      onEvent: () => undefined
    });
  }

  async transcribeWithEvents(
    input: Parameters<NonNullable<RecognitionProvider["transcribeWithEvents"]>>[0]
  ): ReturnType<RecognitionProvider["transcribe"]> {
    return this.runWithEvents({
      imagePaths: input.imagePaths,
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
      prompt: buildFaithfulTranscriptionPrompt(input.context, this.args.promptTemplateContent),
      taskKind: "transcription"
    });
  }

  async assist(input: Parameters<AssistantProvider["assist"]>[0]): ReturnType<AssistantProvider["assist"]> {
    return this.assistWithEvents({ ...input, onEvent: () => undefined });
  }

  async assistWithEvents(
    input: Parameters<NonNullable<AssistantProvider["assistWithEvents"]>>[0]
  ): ReturnType<AssistantProvider["assist"]> {
    return this.runWithEvents({
      imagePaths: input.imagePaths,
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
      prompt: buildAssistantPrompt(input),
      taskKind: "assistant"
    });
  }

  private async runWithEvents(input: {
    imagePaths: string[];
    abortSignal?: AbortSignal;
    onEvent: (event: RecognitionProviderEvent) => void;
    prompt: string;
    taskKind: "transcription" | "assistant";
  }): Promise<RecognitionResult> {
    const client = this.createClient();
    const timeoutMs = this.args.timeoutMs ?? 120_000;
    let markdown = "";
    const rawEvents: JsonRpcNotification[] = [];
    let firstDeltaReceived = false;
    const throwIfAborted = () => {
      if (input.abortSignal?.aborted) {
        throw new Error("Recognition task cancelled by user");
      }
    };

    input.onEvent({
      type: "started",
      message: `Codex app-server 热服务：${this.args.endpoint}`
    });

    try {
      throwIfAborted();
      await client.connect();
      throwIfAborted();
      input.onEvent({
        type: "started",
        message: "已连接 Codex app-server。"
      });

      await client.request("initialize", {
        clientInfo: {
          name: "mathnotes-windows",
          title: "MathNotes Windows",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: []
        }
      });
      input.onEvent({
        type: "started",
        message: "Codex app-server 已初始化。"
      });

      const thread = await client.request<ThreadStartResponse>("thread/start", {
        cwd: this.args.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        threadSource: "mathnotes"
      });
      input.onEvent({
        type: "started",
        message:
          input.taskKind === "transcription"
            ? `已创建临时识别线程：${thread.thread.id}。`
            : `已创建临时学习助手线程：${thread.thread.id}。`
      });

      const completion = waitForTurnCompletion({
        client,
        timeoutMs,
        abortSignal: input.abortSignal,
        onNotification: (message) => {
          rawEvents.push(message);
          if (message.method === "item/agentMessage/delta") {
            const delta = (message.params as AgentDeltaParams | undefined)?.delta ?? "";
            if (delta && !firstDeltaReceived) {
              firstDeltaReceived = true;
              input.onEvent({
                type: "started",
                message:
                  input.taskKind === "transcription"
                    ? "收到第一段转写输出，正在流式写入草稿块。"
                    : "收到第一段学习助手输出，正在流式写入独立草稿块。"
              });
            }
            markdown += delta;
            input.onEvent({ type: "stdout", text: delta });
          }
          if (message.method === "error" || message.method === "warning") {
            input.onEvent({ type: "stderr", text: JSON.stringify(message.params ?? {}) });
          }
        }
      });

      input.onEvent({
        type: "started",
        message:
          input.taskKind === "transcription"
            ? `正在发送 ${input.imagePaths.length} 张图片和忠实转写 prompt。`
            : `正在发送 ${input.imagePaths.length} 张图片和学习助手 prompt。`
      });
      throwIfAborted();
      await client.request("turn/start", {
        threadId: thread.thread.id,
        input: [
          {
            type: "text",
            text: input.prompt,
            text_elements: []
          },
          ...input.imagePaths.map((imagePath) => ({
            type: "localImage",
            path: imagePathForRuntime(imagePath, this.args.runtime ?? "windows")
          }))
        ],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: true },
        ...(this.args.model?.trim() ? { model: this.args.model.trim() } : {})
      });
      throwIfAborted();
      input.onEvent({
        type: "started",
        message: "图片已发送，正在等待模型输出。"
      });

      await completion;
      input.onEvent({
        type: "completed",
        message: "Codex app-server turn completed"
      });

      const trimmed = markdown.trim();
      if (!trimmed) {
        throw new Error(
          `Codex app-server ${input.taskKind === "transcription" ? "transcription" : "assistant"} failed: empty assistant output`
        );
      }

      return {
        markdown: trimmed,
        rawResponse: JSON.stringify(rawEvents)
      };
    } finally {
      client.close();
    }
  }

  private createClient(): CodexAppServerClientLike {
    return this.args.clientFactory?.(this.args.endpoint) ?? new CodexAppServerClient({ url: this.args.endpoint });
  }
}

function waitForTurnCompletion(args: {
  client: CodexAppServerClientLike;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onNotification: (message: JsonRpcNotification) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      args.abortSignal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Recognition task cancelled by user"));
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Codex app-server transcription timed out after ${args.timeoutMs}ms.`));
    }, args.timeoutMs);
    unsubscribe = args.client.onNotification((message) => {
      args.onNotification(message);
      if (message.method !== "turn/completed") {
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    });
    if (args.abortSignal?.aborted) {
      abort();
      return;
    }
    args.abortSignal?.addEventListener("abort", abort, { once: true });
  });
}

function imagePathForRuntime(imagePath: string, runtime: CodexCliRuntime): string {
  return runtime === "wsl" ? windowsPathToWslPath(imagePath) : imagePath;
}

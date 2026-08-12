import { describe, expect, it } from "vitest";
import type { RecognitionProviderEvent } from "@mathnotes/shared";
import { CodexAppServerRecognitionProvider, type CodexAppServerClientLike } from "./codexAppServerRecognitionProvider";

class FakeCodexAppServerClient implements CodexAppServerClientLike {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private notificationListeners = new Set<(message: { method: string; params?: unknown }) => void>();

  async connect(): Promise<void> {
    return;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "initialize") {
      return { userAgent: "fake-codex", platformOs: "linux" } as T;
    }
    if (method === "thread/start") {
      return { thread: { id: "thread_1" } } as T;
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.emit({ method: "item/agentMessage/delta", params: { delta: "## 标题\n\n" } });
        this.emit({ method: "item/agentMessage/delta", params: { delta: "$$x^2$$" } });
        this.emit({ method: "turn/completed", params: { threadId: "thread_1", turn: { id: "turn_1", status: "completed" } } });
      });
      return { turn: { id: "turn_1", status: "running" } } as T;
    }
    throw new Error(`unexpected request: ${method}`);
  }

  onNotification(listener: (message: { method: string; params?: unknown }) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    return;
  }

  private emit(message: { method: string; params?: unknown }): void {
    for (const listener of this.notificationListeners) {
      listener(message);
    }
  }
}

describe("CodexAppServerRecognitionProvider", () => {
  it("starts an app-server turn with local images and aggregates assistant deltas", async () => {
    const client = new FakeCodexAppServerClient();
    const events: RecognitionProviderEvent[] = [];
    const provider = new CodexAppServerRecognitionProvider({
      endpoint: "ws://127.0.0.1:4444",
      cwd: "E:/opensourceproject/readandanalysis",
      runtime: "wsl",
      clientFactory: () => client,
      timeoutMs: 100
    });

    const result = await provider.transcribeWithEvents({
      imagePaths: ["E:\\notes\\photo.png"],
      mode: "faithful",
      outputFormat: "markdown",
      context: "泛函分析",
      onEvent: (event) => events.push(event)
    });

    expect(result.markdown).toBe("## 标题\n\n$$x^2$$");
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "started", message: "Codex app-server 热服务：ws://127.0.0.1:4444" },
        { type: "started", message: "已连接 Codex app-server。" },
        { type: "started", message: "Codex app-server 已初始化。" },
        { type: "started", message: "已创建临时识别线程：thread_1。" },
        { type: "started", message: "正在发送 1 张图片和忠实转写 prompt。" },
        { type: "started", message: "图片已发送，正在等待模型输出。" },
        { type: "started", message: "收到第一段转写输出，正在流式写入草稿块。" },
        { type: "stdout", text: "## 标题\n\n" },
        { type: "stdout", text: "$$x^2$$" },
        { type: "completed", message: "Codex app-server turn completed" }
      ])
    );
    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "thread/start", "turn/start"]);
    expect(client.requests[2].params).toMatchObject({
      threadId: "thread_1",
      input: [
        { type: "text", text_elements: [] },
        { type: "localImage", path: "/mnt/e/notes/photo.png" }
      ],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: true }
    });
  });
});

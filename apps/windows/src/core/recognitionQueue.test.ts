import { describe, expect, it } from "vitest";
import type { RecognitionProvider } from "@mathnotes/shared";
import { RecognitionQueue } from "./recognitionQueue";
import type { BlockWriter } from "./blockWriter";

describe("RecognitionQueue", () => {
  it("enqueues and processes a recognition job into an ai transcript block", async () => {
    const provider = providerReturning("## OCR 草稿");
    const writer = writerReturning("0003");
    const queue = new RecognitionQueue({ provider, writer });

    const job = queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });

    expect(job.status).toBe("pending");

    const processed = await queue.processNext();

    expect(processed).toMatchObject({
      id: job.id,
      status: "succeeded",
      attempts: 1,
      transcriptBlockId: "0003",
      warnings: ["mock_provider_used"]
    });
    expect(queue.getJob(job.id)).toMatchObject({ status: "succeeded" });
    expect(writer.calls).toEqual([
      {
        notebookId: "functional_analysis",
        sessionId: "lecture",
        markdown: "## OCR 草稿",
        fromAssets: ["assets/photos/photo_001.jpg"],
        insertAfterBlockId: "0002",
        now: "2026-06-26T10:00:00.000Z"
      }
    ]);
  });

  it("emits basic runtime events for non-streaming providers", async () => {
    const provider = providerReturning("## OCR 草稿");
    const writer = writerReturning("0003");
    const runtimeEvents: string[] = [];
    const queue = new RecognitionQueue({
      provider,
      writer,
      async onRuntimeEvent(event) {
        runtimeEvents.push(`${event.level}:${event.previewChanged ? "preview" : "log"}:${event.message}`);
      }
    });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });

    await queue.processNext();

    expect(runtimeEvents).toEqual([
      "info:log:当前识别服务：假识别服务（验证管线）。",
      "info:preview:识别服务已完成：假识别服务（验证管线）。"
    ]);
  });

  it("persists one bounded context snapshot on the job and reuses it for provider input", async () => {
    let receivedContext: string | undefined;
    const provider: RecognitionProvider = {
      name: "context-fixture",
      async transcribe(input) {
        receivedContext = input.context;
        return { markdown: "## 新转写" };
      }
    };
    let contextBuilds = 0;
    const queue = new RecognitionQueue({
      provider,
      writer: writerReturning("0003"),
      async buildContext() {
        contextBuilds += 1;
        return { version: 1, summary: "前文1：函数在该点连续。", fingerprint: "f".repeat(64) };
      }
    });
    const job = queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });

    const processed = await queue.processNext(job.id);
    expect(receivedContext).toBe("前文1：函数在该点连续。");
    expect(processed).toMatchObject({
      recognitionContextVersion: 1,
      recognitionContext: "前文1：函数在该点连续。",
      recognitionContextFingerprint: "f".repeat(64)
    });
    expect(contextBuilds).toBe(1);
  });

  it("uses the image block id as the stable recognition job id", () => {
    const queue = new RecognitionQueue({
      provider: providerReturning("ok"),
      writer: writerReturning("0003")
    });

    const first = queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0010",
      assetPath: "assets/photos/a.jpg",
      imagePath: "C:/tmp/a.jpg",
      now: "2026-06-27T05:00:00.000Z"
    });
    const second = queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0012",
      assetPath: "assets/photos/b.jpg",
      imagePath: "C:/tmp/b.jpg",
      now: "2026-06-27T05:01:00.000Z"
    });

    expect(first.id).toBe("recognition_0010");
    expect(second.id).toBe("recognition_0012");
  });

  it("marks failed jobs and retries them on a later process call", async () => {
    let attempts = 0;
    const provider: RecognitionProvider = {
      name: "flaky",
      async transcribe() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("provider offline");
        }
        return { markdown: "retry ok" };
      }
    };
    const writer = writerReturning("0004");
    const queue = new RecognitionQueue({ provider, writer, maxAttempts: 2 });
    const job = queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });

    const failed = await queue.processNext();
    expect(failed).toMatchObject({
      id: job.id,
      status: "failed",
      attempts: 1,
      error: "provider offline"
    });

    const retried = await queue.processNext();
    expect(retried).toMatchObject({
      id: job.id,
      status: "succeeded",
      attempts: 2,
      transcriptBlockId: "0004"
    });
  });

  it("does not process succeeded jobs again", async () => {
    const provider = providerReturning("## OCR 草稿");
    const writer = writerReturning("0003");
    const queue = new RecognitionQueue({ provider, writer });
    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });

    await queue.processNext();
    const second = await queue.processNext();

    expect(second).toBeNull();
    expect(writer.calls).toHaveLength(1);
  });

  it("notifies job state changes for persistence", async () => {
    let attempts = 0;
    const provider: RecognitionProvider = {
      name: "flaky",
      async transcribe() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("provider offline");
        }
        return { markdown: "retry ok" };
      }
    };
    const writer = writerReturning("0004");
    const seen: Array<{ status: string; attempts: number; error?: string; transcriptBlockId?: string }> = [];
    const queue = new RecognitionQueue({
      provider,
      writer,
      maxAttempts: 2,
      async onJobChanged(job) {
        seen.push({
          status: job.status,
          attempts: job.attempts,
          error: job.error,
          transcriptBlockId: job.transcriptBlockId
        });
      }
    });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });
    await queue.processNext();
    await queue.processNext();

    expect(seen).toEqual([
      { status: "pending", attempts: 0, error: undefined, transcriptBlockId: undefined },
      { status: "running", attempts: 1, error: undefined, transcriptBlockId: undefined },
      { status: "failed", attempts: 1, error: "provider offline", transcriptBlockId: undefined },
      { status: "running", attempts: 2, error: undefined, transcriptBlockId: undefined },
      { status: "succeeded", attempts: 2, error: undefined, transcriptBlockId: "0004" }
    ]);
  });

  it("streams provider events into a draft transcript block", async () => {
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming provider");
      },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "started", message: "codex exec started" });
        input.onEvent({ type: "stderr", text: "loading image" });
        input.onEvent({ type: "stdout", text: "## 第一行\n" });
        input.onEvent({ type: "stdout", text: "公式内容" });
        input.onEvent({ type: "completed", message: "exit 0" });
        return { markdown: "## 第一行\n公式内容" };
      }
    };
    const writer = writerReturning("0005");
    const runtimeEvents: string[] = [];
    const queue = new RecognitionQueue({
      provider,
      writer,
      async onRuntimeEvent(event) {
        runtimeEvents.push(`${event.level}:${event.previewChanged ? "preview" : "log"}:${event.message.trim()}`);
      }
    });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });
    const processed = await queue.processNext();

    expect(processed).toMatchObject({
      status: "succeeded",
      transcriptBlockId: "0005"
    });
    expect(writer.calls[0]).toMatchObject({
      markdown: expect.stringContaining("正在识别（Mimo v2.5）")
    });
    expect(JSON.stringify(writer.calls)).not.toContain("Codex");
    expect(writer.updates.at(-1)).toMatchObject({
      blockId: "0005",
      markdown: "## 第一行\n公式内容"
    });
    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        "info:preview:已创建流式识别草稿块。",
        "info:log:codex exec started",
        "stderr:log:loading image",
        "stdout:log:## 第一行",
        "info:preview:最终 Markdown 已写入草稿块。"
      ])
    );
  });

  it("cancels a running streaming provider and marks the draft as interrupted", async () => {
    let capturedSignal: AbortSignal | undefined;
    let rejectRun!: (error: Error) => void;
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming provider");
      },
      async transcribeWithEvents(input) {
        capturedSignal = input.abortSignal;
        input.onEvent({ type: "started", message: "Mimo request started" });
        return new Promise((_, reject) => {
          rejectRun = reject;
          input.abortSignal?.addEventListener("abort", () => reject(new Error("Recognition task cancelled by user")));
        });
      }
    };
    const writer = writerReturning("0005");
    const seen: string[] = [];
    const queue = new RecognitionQueue({
      provider,
      writer,
      async onJobChanged(job) {
        seen.push(job.status);
      }
    });

    const job = queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });
    const running = queue.processNext();
    await waitFor(() => capturedSignal !== undefined);

    const cancelled = queue.cancel(job.id);

    expect(cancelled?.status).toBe("cancelled");
    expect(capturedSignal?.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({
      status: "cancelled",
      error: "用户已中断识别。"
    });
    expect(writer.updates.at(-1)).toMatchObject({
      blockId: "0005",
      markdown: expect.stringContaining("识别已中断（Mimo v2.5）")
    });
    expect(seen).toContain("cancelled");
    rejectRun(new Error("late reject should be ignored"));
  });

  it("coalesces bursty streaming drafts while preserving the latest output", async () => {
    const chunkCount = 80;
    const markdown = Array.from({ length: chunkCount }, (_, index) => `chunk-${index}\n`).join("");
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming provider");
      },
      async transcribeWithEvents(input) {
        for (let index = 0; index < chunkCount; index += 1) {
          input.onEvent({ type: "stdout", text: `chunk-${index}\n` });
        }
        return { markdown };
      }
    };
    const writer = writerReturning("0005");
    const queue = new RecognitionQueue({ provider, writer });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-07-18T10:00:00.000Z"
    });

    await expect(queue.processNext()).resolves.toMatchObject({ status: "succeeded" });
    expect(writer.updates).toHaveLength(2);
    expect(writer.updates.at(-1)).toMatchObject({ blockId: "0005", markdown });
  });

  it("cancels a pending recognition request before provider execution", async () => {
    const queue = new RecognitionQueue({
      provider: providerReturning("unused"),
      writer: writerReturning("0005")
    });
    const job = queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "pdf_page_02",
      assetPath: "assets/pdf-pages/pdf-page-02.png",
      imagePath: "C:/tmp/pdf-page-02.png",
      now: "2026-07-14T10:00:00.000Z"
    });

    expect(queue.cancel(job.id)).toMatchObject({
      id: job.id,
      status: "cancelled",
      error: "用户已中断识别。"
    });
    await expect(queue.processNext(job.id)).resolves.toBeNull();
  });

  it("updates the streaming draft block when a provider timeout fails the job", async () => {
    const provider: RecognitionProvider = {
      name: "streaming",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming provider");
      },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "started", message: "codex exec started" });
        throw new Error("Codex CLI transcription timed out after 120000ms. 请稍后在任务面板手动重试。");
      }
    };
    const writer = writerReturning("0005");
    const runtimeEvents: string[] = [];
    const queue = new RecognitionQueue({
      provider,
      writer,
      async onRuntimeEvent(event) {
        runtimeEvents.push(`${event.level}:${event.previewChanged ? "preview" : "log"}:${event.message.trim()}`);
      }
    });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });
    const processed = await queue.processNext();

    expect(processed).toMatchObject({
      status: "failed",
      attempts: 1,
      transcriptBlockId: "0005",
      error: expect.stringContaining("timed out")
    });
    expect(writer.updates.at(-1)).toMatchObject({
      blockId: "0005",
      markdown: expect.stringContaining("识别失败（streaming）")
    });
    expect(runtimeEvents).toEqual(expect.arrayContaining([expect.stringMatching(/^error:preview:识别服务失败（streaming）：/)]));
  });

  it("reuses a failed streaming draft block when the same queued job is processed again", async () => {
    let attempts = 0;
    const provider: RecognitionProvider = {
      name: "streaming",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming provider");
      },
      async transcribeWithEvents(input) {
        attempts += 1;
        input.onEvent({ type: "started", message: `attempt ${attempts}` });
        if (attempts === 1) {
          throw new Error("network timeout");
        }
        input.onEvent({ type: "stdout", text: "## 重试成功\n" });
        return { markdown: "## 重试成功" };
      }
    };
    const writer = writerReturning("0005");
    const queue = new RecognitionQueue({ provider, writer, maxAttempts: 2 });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });

    await expect(queue.processNext()).resolves.toMatchObject({
      status: "failed",
      transcriptBlockId: "0005"
    });
    await expect(queue.processNext()).resolves.toMatchObject({
      status: "succeeded",
      transcriptBlockId: "0005"
    });

    expect(writer.calls).toHaveLength(1);
    expect(writer.updates.at(-1)).toMatchObject({
      blockId: "0005",
      markdown: "## 重试成功"
    });
  });

  it("warns once and automatically stops sustained repeated output", async () => {
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming provider");
      },
      async transcribeWithEvents(input) {
        for (let index = 0; index < 4; index += 1) {
          input.onEvent({
            type: "stdout",
            text: `${index === 0 ? "## 推导\n" : ""}${"\\quad ".repeat(8)}`
          });
          if (input.abortSignal?.aborted) {
            throw new Error("provider stopped after abort");
          }
        }
        return { markdown: "provider ignored anomaly guard" };
      }
    };
    const writer = writerReturning("0005");
    const runtimeEvents: string[] = [];
    const queue = new RecognitionQueue({
      provider,
      writer,
      async onRuntimeEvent(event) {
        runtimeEvents.push(`${event.level}:${event.message}`);
      }
    });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-07-10T12:00:00.000Z"
    });
    const processed = await queue.processNext();

    expect(processed).toMatchObject({
      status: "failed",
      failureKind: "output_anomaly",
      error: expect.stringContaining("异常输出已停止")
    });
    expect(runtimeEvents.filter((event) => event.includes("疑似重复输出"))).toHaveLength(1);
    expect(runtimeEvents).toEqual(expect.arrayContaining([expect.stringContaining("异常输出已自动停止")]));
    expect(writer.updates.at(-1)).toMatchObject({
      blockId: "0005",
      markdown: expect.stringContaining("## 推导")
    });
    expect(JSON.stringify(writer.updates.at(-1))).not.toContain("\\quad ".repeat(16).trim());
  });

  it("keeps structured derivations with repeated symbols running", async () => {
    const markdown = Array.from(
      { length: 12 },
      (_, index) => `$$X_${index} = X_+ \\oplus X_-$$`
    ).join("\n");
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming provider");
      },
      async transcribeWithEvents(input) {
        for (const line of markdown.split("\n")) {
          input.onEvent({ type: "stdout", text: `${line}\n` });
        }
        return { markdown };
      }
    };
    const writer = writerReturning("0005");
    const queue = new RecognitionQueue({ provider, writer });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-07-10T12:00:00.000Z"
    });

    const processed = await queue.processNext();
    expect(processed).toMatchObject({ status: "succeeded" });
    expect(processed?.failureKind).toBeUndefined();
  });

  it("adds faithful transcription contract warnings to provider output", async () => {
    const provider = providerReturning(["这里是转写结果：", "\\[", "x^2", "\\]"].join("\n"));
    const writer = writerReturning("0003");
    const queue = new RecognitionQueue({ provider, writer });

    queue.enqueue({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      imageBlockId: "0002",
      assetPath: "assets/photos/photo_001.jpg",
      imagePath: "C:/tmp/photo_001.jpg",
      now: "2026-06-26T10:00:00.000Z"
    });

    const processed = await queue.processNext();

    expect(processed?.warnings).toEqual(
      expect.arrayContaining([
        "mock_provider_used",
        "不应输出解释性前言，只输出 Markdown 草稿内容。",
        "检测到 \\[...\\]，Provider 输出应优先使用 $$...$$ 以便导出兼容。"
      ])
    );
  });
});

function providerReturning(markdown: string): RecognitionProvider {
  return {
    name: "mock",
    async transcribe() {
      return {
        markdown,
        warnings: ["mock_provider_used"]
      };
    }
  };
}

function writerReturning(blockId: string): Pick<BlockWriter, "writeAiTranscript" | "updateAiTranscript"> & { calls: unknown[]; updates: unknown[] } {
  const calls: unknown[] = [];
  const updates: unknown[] = [];
  return {
    calls,
    updates,
    async writeAiTranscript(input) {
      calls.push(input);
      return {
        id: blockId,
        type: "markdown",
        path: `blocks/${blockId}_ai_transcript.md`,
        source: "ai_transcription",
        status: "draft",
        readonly: false,
        editableByAi: true,
        fromAssets: input.fromAssets,
        createdAt: input.now,
        updatedAt: input.now
      };
    },
    async updateAiTranscript(input) {
      updates.push(input);
      return {
        id: input.blockId,
        type: "markdown",
        path: `blocks/${input.blockId}_ai_transcript.md`,
        source: "ai_transcription",
        status: "draft",
        readonly: false,
        editableByAi: true,
        createdAt: input.now,
        updatedAt: input.now
      };
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

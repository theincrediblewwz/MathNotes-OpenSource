import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecognitionProvider } from "@mathnotes/shared";
import { BlockStore } from "./blockStore";
import { retryRecognitionJob } from "./recognitionRetry";
import { readRecognitionJobs, upsertRecognitionJob } from "./recognitionJobLog";

describe("retryRecognitionJob", () => {
  let rootDir: string;
  let store: BlockStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-retry-"));
    store = new BlockStore(rootDir);
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-27T02:00:00.000Z"
    });
    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/failed.jpg",
      now: "2026-06-27T02:00:00.000Z"
    });
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "after image",
      now: "2026-06-27T02:00:10.000Z"
    });
    await upsertRecognitionJob({
      rootDir,
      job: {
        id: "recognition_0001",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        imageBlockId: "0001",
        assetPath: "assets/photos/failed.jpg",
        imagePath: join(rootDir, "notebooks/functional_analysis/sessions/lecture/assets/photos/failed.jpg"),
        now: "2026-06-27T02:00:00.000Z",
        status: "failed",
        attempts: 1,
        maxAttempts: 2,
        error: "provider offline"
      }
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("retries a failed job and writes the transcript after its image block", async () => {
    const provider: RecognitionProvider = {
      name: "retry-provider",
      async transcribe() {
        return {
          markdown: "retry transcript",
          warnings: ["retried"]
        };
      }
    };

    const result = await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-06-27T02:05:00.000Z"
    });

    expect(result).toMatchObject({
      id: "recognition_0001",
      status: "succeeded",
      attempts: 2,
      transcriptBlockId: "0003",
      error: undefined,
      warnings: ["retried"]
    });
    await expect(
      readRecognitionJobs({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: "recognition_0001",
        status: "succeeded",
        attempts: 2,
        transcriptBlockId: "0003",
        error: undefined
      })
    ]);

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => `${block.id}:${block.type}:${block.source}`)).toEqual([
      "0001:image:android_camera",
      "0003:markdown:ai_transcription",
      "0002:markdown:user"
    ]);
    await expect(
      readFile(join(rootDir, "notebooks/functional_analysis/sessions/lecture/blocks/0003_ai_transcript.md"), "utf8")
    ).resolves.toBe("retry transcript");
  });

  it("allows a stopped output anomaly to retry and clears its failure kind on success", async () => {
    const [failedJob] = await readRecognitionJobs({
      rootDir,
      notebookId: "functional_analysis",
      sessionId: "lecture"
    });
    await upsertRecognitionJob({
      rootDir,
      job: {
        ...failedJob,
        failureKind: "output_anomaly",
        error: "异常输出已停止"
      }
    });
    const provider: RecognitionProvider = {
      name: "retry-provider",
      async transcribe() {
        return { markdown: "retry after anomaly" };
      }
    };

    const result = await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-07-10T12:10:00.000Z"
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(result.failureKind).toBeUndefined();
  });

  it("notifies callers while retrying a failed job", async () => {
    const changes: string[] = [];
    const provider: RecognitionProvider = {
      name: "retry-provider",
      async transcribe() {
        return {
          markdown: "retry transcript"
        };
      }
    };

    await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-06-27T02:05:00.000Z",
      onJobChanged: (job) => {
        changes.push(`${job.id}:${job.status}:${job.attempts}`);
      }
    });

    expect(changes).toEqual(["recognition_0001:running:2", "recognition_0001:succeeded:2"]);
  });

  it("allows a manual retry after automatic attempts are exhausted", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: {
        id: "recognition_0001",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        imageBlockId: "0001",
        assetPath: "assets/photos/failed.jpg",
        imagePath: join(rootDir, "notebooks/functional_analysis/sessions/lecture/assets/photos/failed.jpg"),
        now: "2026-06-27T02:00:00.000Z",
        status: "failed",
        attempts: 2,
        maxAttempts: 2,
        error: "network timeout"
      }
    });
    const provider: RecognitionProvider = {
      name: "retry-provider",
      async transcribe() {
        return {
          markdown: "manual retry transcript"
        };
      }
    };

    const result = await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-06-27T02:05:00.000Z"
    });

    expect(result).toMatchObject({
      status: "succeeded",
      attempts: 3,
      maxAttempts: 3,
      transcriptBlockId: "0003"
    });
    await expect(
      readRecognitionJobs({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: "recognition_0001",
        status: "succeeded",
        attempts: 3,
        maxAttempts: 3
      })
    ]);
  });

  it("streams provider events and updates a retry draft block", async () => {
    const runtimeEvents: string[] = [];
    const provider: RecognitionProvider = {
      name: "codex-cli",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming retry");
      },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "started", message: "Codex CLI 准备启动。" });
        input.onEvent({ type: "stderr", text: "Reading prompt from stdin...\n" });
        input.onEvent({ type: "stdout", text: "### 流式识别结果\n\n" });
        input.onEvent({ type: "stdout", text: "这是最终 Markdown。\n" });
        return {
          markdown: "### 流式识别结果\n\n这是最终 Markdown。"
        };
      }
    };

    const result = await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-06-27T02:05:00.000Z",
      onRuntimeEvent: (event) => {
        runtimeEvents.push(`${event.level}:${event.message.trim()}:${event.transcriptBlockId ?? "none"}:${event.previewChanged ? "preview" : "event"}`);
      }
    });

    expect(result).toMatchObject({
      status: "succeeded",
      transcriptBlockId: "0003"
    });
    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        "info:当前识别服务：codex-cli。:none:event",
        "info:已创建流式识别草稿块。:0003:preview",
        "stderr:Reading prompt from stdin...:0003:event",
        "stdout:### 流式识别结果:0003:event",
        "info:最终 Markdown 已写入草稿块。:0003:preview",
        "info:识别服务已完成：codex-cli。:0003:preview"
      ])
    );
    await expect(
      readFile(join(rootDir, "notebooks/functional_analysis/sessions/lecture/blocks/0003_ai_transcript.md"), "utf8")
    ).resolves.toBe("### 流式识别结果\n\n这是最终 Markdown。");
  });

  it("reuses an existing failed streaming transcript block instead of appending another block", async () => {
    const failedBlock = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "#### Codex CLI 识别失败\n\nnetwork timeout",
      fromAssets: ["assets/photos/failed.jpg"],
      insertAfterBlockId: "0001",
      now: "2026-06-27T02:01:00.000Z"
    });
    await upsertRecognitionJob({
      rootDir,
      job: {
        id: "recognition_0001",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        imageBlockId: "0001",
        assetPath: "assets/photos/failed.jpg",
        imagePath: join(rootDir, "notebooks/functional_analysis/sessions/lecture/assets/photos/failed.jpg"),
        now: "2026-06-27T02:00:00.000Z",
        status: "failed",
        attempts: 1,
        maxAttempts: 2,
        transcriptBlockId: failedBlock.id,
        error: "network timeout"
      }
    });
    const provider: RecognitionProvider = {
      name: "codex-cli",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming retry");
      },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "started", message: "Codex CLI 准备启动。" });
        input.onEvent({ type: "stdout", text: "### 重新识别\n\n" });
        input.onEvent({ type: "stdout", text: "复用旧块写入最终内容。\n" });
        return {
          markdown: "### 重新识别\n\n复用旧块写入最终内容。"
        };
      }
    };

    const result = await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-06-27T02:05:00.000Z"
    });

    expect(result).toMatchObject({
      status: "succeeded",
      transcriptBlockId: failedBlock.id
    });
    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => `${block.id}:${block.type}:${block.source}`)).toEqual([
      "0001:image:android_camera",
      `${failedBlock.id}:markdown:ai_transcription`,
      "0002:markdown:user"
    ]);
    await expect(
      readFile(join(rootDir, `notebooks/functional_analysis/sessions/lecture/${failedBlock.path}`), "utf8")
    ).resolves.toBe("### 重新识别\n\n复用旧块写入最终内容。");
  });

  it("stops anomalous retry output while reusing the existing transcript block", async () => {
    const failedBlock = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "#### 识别失败\n\nnetwork timeout",
      fromAssets: ["assets/photos/failed.jpg"],
      insertAfterBlockId: "0001",
      now: "2026-06-27T02:01:00.000Z"
    });
    await upsertRecognitionJob({
      rootDir,
      job: {
        id: "recognition_0001",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        imageBlockId: "0001",
        assetPath: "assets/photos/failed.jpg",
        imagePath: join(rootDir, "notebooks/functional_analysis/sessions/lecture/assets/photos/failed.jpg"),
        now: "2026-06-27T02:00:00.000Z",
        status: "failed",
        attempts: 1,
        maxAttempts: 2,
        transcriptBlockId: failedBlock.id,
        error: "network timeout"
      }
    });

    let providerSignal: AbortSignal | undefined;
    const runtimeEvents: string[] = [];
    const provider: RecognitionProvider = {
      name: "mimo_2_5",
      async transcribe() {
        throw new Error("transcribe should not be used for streaming retry");
      },
      async transcribeWithEvents(input) {
        providerSignal = input.abortSignal;
        for (let index = 0; index < 4; index += 1) {
          input.onEvent({
            type: "stdout",
            text: `${index === 0 ? "## 重试草稿\n" : ""}${"\\quad ".repeat(8)}`
          });
          if (input.abortSignal?.aborted) {
            throw new Error("provider stopped after abort");
          }
        }
        return { markdown: "provider ignored anomaly guard" };
      }
    };

    const result = await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-07-10T12:00:00.000Z",
      onRuntimeEvent: (event) => {
        runtimeEvents.push(`${event.level}:${event.message}`);
      }
    });

    expect(providerSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "failed",
      failureKind: "output_anomaly",
      transcriptBlockId: failedBlock.id
    });
    expect(runtimeEvents.filter((event) => event.includes("疑似重复输出"))).toHaveLength(1);
    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.filter((block) => block.source === "ai_transcription")).toHaveLength(1);
    await expect(
      readFile(join(rootDir, `notebooks/functional_analysis/sessions/lecture/${failedBlock.path}`), "utf8")
    ).resolves.toContain("异常输出已停止");
  });

  it("adds faithful transcription contract warnings when retry output violates the prompt contract", async () => {
    const provider: RecognitionProvider = {
      name: "retry-provider",
      async transcribe() {
        return {
          markdown: ["这里是转写结果：", "\\[", "x^2", "\\]"].join("\n"),
          warnings: ["provider raw warning"]
        };
      }
    };

    const result = await retryRecognitionJob({
      rootDir,
      store,
      provider,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      jobId: "recognition_0001",
      now: "2026-06-27T02:05:00.000Z"
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "provider raw warning",
        "不应输出解释性前言，只输出 Markdown 草稿内容。",
        "检测到 \\[...\\]，Provider 输出应优先使用 $$...$$ 以便导出兼容。"
      ])
    );
  });
});

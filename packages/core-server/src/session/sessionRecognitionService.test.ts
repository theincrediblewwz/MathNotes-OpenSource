import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecognitionProvider, SessionRecord } from "@mathnotes/shared";
import {
  SessionRecognitionError,
  SessionRecognitionService,
  type SessionRecognitionTask
} from "./sessionRecognitionService";

describe("SessionRecognitionService", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-session-recognition-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await mkdir(join(sessionDir, "assets", "photos"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "## 用户原文\n\n不可覆盖\n");
    await writeFile(join(sessionDir, "assets", "photos", "board.png"), Buffer.from([1, 2, 3]));
    await writeSession();
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("streams one draft immediately after the image and keeps existing Markdown unchanged", async () => {
    const service = new SessionRecognitionService(root, async () => streamingProvider());
    const started = await service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" });
    const completed = await waitForTerminal(service, started.id);

    expect(completed).toMatchObject({ status: "succeeded", attempts: 1, providerName: "fixture-stream", error: undefined });
    expect((await readSession()).blocks.map((block) => block.id)).toEqual(["0001", "0002", started.transcriptBlockId]);
    expect(await readFile(join(sessionDir, "blocks", `${started.transcriptBlockId}_ai_transcript.md`), "utf8"))
      .toBe("## 忠实转写\n\n$$x+y=z$$\n");
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe("## 用户原文\n\n不可覆盖\n");

    const events = service.eventsAfter(started.id);
    expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((a, b) => a - b));
    expect(events.some((event) => event.type === "stdout" && event.delta?.includes("忠实转写"))).toBe(true);
    expect(events.at(-1)?.task.status).toBe("succeeded");
    expect(JSON.stringify(completed)).not.toContain(sessionDir);
  });

  it("wakes an idle session listener as soon as recognition activity begins", async () => {
    const service = new SessionRecognitionService(root, async () => streamingProvider());
    const initialSequence = service.activitySequence({ notebookId: "analysis", sessionId: "lecture" });
    const wake = service.waitForActivity({
      notebookId: "analysis",
      sessionId: "lecture",
      afterSequence: initialSequence,
      timeoutMs: 1_000
    });

    const started = await service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" });
    await expect(wake).resolves.toBeGreaterThan(initialSequence);
    await waitForTerminal(service, started.id);

    const settledSequence = service.activitySequence({ notebookId: "analysis", sessionId: "lecture" });
    await expect(service.waitForActivity({
      notebookId: "analysis",
      sessionId: "lecture",
      afterSequence: settledSequence,
      timeoutMs: 5
    })).resolves.toBe(settledSequence);
  });

  it("rejects invalid targets, missing assets and duplicate active work without creating residue", async () => {
    const waiting = deferredProvider("waiting");
    const service = new SessionRecognitionService(root, async () => waiting.provider);

    await expect(service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0001" }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRecognitionError>>({ code: "not_image_block", statusCode: 422 }));
    await expect(service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "does-not-exist" }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRecognitionError>>({ code: "block_not_found", statusCode: 404 }));
    await expect(service.start({ notebookId: "../../outside", sessionId: "lecture", imageBlockId: "0002" }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRecognitionError>>({ code: "path_outside_session", statusCode: 400 }));
    await rm(join(sessionDir, "assets", "photos", "board.png"));
    await expect(service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRecognitionError>>({ code: "asset_not_found", statusCode: 404 }));
    expect((await readSession()).blocks.map((block) => block.id)).toEqual(["0001", "0002"]);

    await writeFile(join(sessionDir, "assets", "photos", "board.png"), Buffer.from([1, 2, 3]));
    const started = await service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" });
    await waitForStatus(service, started.id, "running");
    await expect(service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionRecognitionError>>({
        code: "recognition_in_progress", statusCode: 409, taskId: started.id
      }));
    await service.cancel({ notebookId: "analysis", sessionId: "lecture", taskId: started.id });
  });

  it("cancels through AbortSignal and retries the same transcript block", async () => {
    const first = deferredProvider("slow-provider");
    let providerCall = 0;
    const service = new SessionRecognitionService(root, async () => {
      providerCall += 1;
      return providerCall === 1 ? first.provider : streamingProvider("retry-provider");
    });
    const started = await service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" });
    await waitForStatus(service, started.id, "running");

    const cancelled = await service.cancel({ notebookId: "analysis", sessionId: "lecture", taskId: started.id });
    expect(cancelled.status).toBe("cancelled");
    expect(first.wasAborted()).toBe(true);
    expect(await readFile(join(sessionDir, "blocks", `${started.transcriptBlockId}_ai_transcript.md`), "utf8"))
      .toContain("识别已中断");

    const retried = await service.retry({ notebookId: "analysis", sessionId: "lecture", taskId: started.id });
    const completed = await waitForTerminal(service, retried.id);
    expect(completed).toMatchObject({ status: "succeeded", attempts: 2, providerName: "retry-provider", error: undefined });
    expect(completed.transcriptBlockId).toBe(started.transcriptBlockId);
    expect((await readSession()).blocks).toHaveLength(3);
  });

  it("stops repeated output and preserves only the last healthy prefix", async () => {
    const provider: RecognitionProvider = {
      name: "looping-provider",
      async transcribe() { throw new Error("event path expected"); },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "stdout", text: "## 安全前缀\n\n" });
        for (let index = 0; index < 40; index += 1) input.onEvent({ type: "stdout", text: "\\quad " });
        return { markdown: "should not be committed" };
      }
    };
    const service = new SessionRecognitionService(root, async () => provider);
    const started = await service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" });
    const completed = await waitForTerminal(service, started.id);
    const markdown = await readFile(join(sessionDir, "blocks", `${started.transcriptBlockId}_ai_transcript.md`), "utf8");

    expect(completed).toMatchObject({ status: "failed", failureKind: "output_anomaly" });
    expect(markdown).toContain("## 安全前缀");
    expect(markdown).toContain("异常输出已停止");
    expect(markdown).not.toContain("should not be committed");
    expect(service.eventsAfter(started.id).filter((event) => event.type === "warning" && event.message.includes("疑似重复")))
      .toHaveLength(1);
  });

  it("recovers an orphan running task as retryable after service restart", async () => {
    const first = deferredProvider("orphan-provider");
    const service = new SessionRecognitionService(root, async () => first.provider);
    const started = await service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" });
    await waitForStatus(service, started.id, "running");

    const restarted = new SessionRecognitionService(root, async () => streamingProvider("recovered-provider"));
    const recovered = await restarted.get({ notebookId: "analysis", sessionId: "lecture", taskId: started.id });
    expect(recovered).toMatchObject({ status: "failed", error: "上次识别运行被中断，请重试。" });
    const retried = await restarted.retry({ notebookId: "analysis", sessionId: "lecture", taskId: started.id });
    expect((await waitForTerminal(restarted, retried.id))).toMatchObject({ status: "succeeded", attempts: 2 });
    await service.cancel({ notebookId: "analysis", sessionId: "lecture", taskId: started.id }).catch(() => undefined);
  });

  it("surfaces a safe actionable reason when the recognition provider is unavailable", async () => {
    const service = new SessionRecognitionService(root, async () => {
      throw new Error("credential-store-internal-detail");
    });
    const started = await service.start({ notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002" });
    const completed = await waitForTerminal(service, started.id);

    expect(completed).toMatchObject({
      status: "failed",
      failureKind: "provider_unavailable",
      error: "识别服务尚未配置或未能恢复，请在设置中保存并测试识别服务。"
    });
    expect(service.eventsAfter(started.id).at(-1)?.message).toBe(completed.error);
    expect(JSON.stringify(completed)).not.toContain("credential-store-internal-detail");
  });

  it("re-runs the same transcription block and restores reviewed text when the new attempt fails", async () => {
    let providerCall = 0;
    const cancelledProvider = deferredProvider("cancelled-rerun");
    const failingProvider: RecognitionProvider = {
      name: "fixture-failure",
      async transcribe() { throw new Error("fixture provider failed"); },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "stdout", text: "## 不应覆盖旧稿\n" });
        throw new Error("fixture provider failed");
      }
    };
    const service = new SessionRecognitionService(root, async () => {
      providerCall += 1;
      if (providerCall === 1) return streamingProvider("initial-provider");
      if (providerCall === 2) return failingProvider;
      if (providerCall === 3) return streamingProvider("recovered-provider");
      return cancelledProvider.provider;
    });
    const started = await service.start({
      notebookId: "analysis", sessionId: "lecture", imageBlockId: "0002"
    });
    const initial = await waitForTerminal(service, started.id);
    expect(initial.status).toBe("succeeded");
    const transcriptPath = join(sessionDir, "blocks", `${started.transcriptBlockId}_ai_transcript.md`);
    const reviewed = "## 人工校订后的原稿\n\n这里绝对不能因重识别失败而丢失。\n";
    await writeFile(transcriptPath, reviewed);

    const lockedSession = await readSession();
    lockedSession.locks = [{
      id: `lock_block_${started.transcriptBlockId}`,
      blockId: started.transcriptBlockId,
      kind: "block",
      contentHash: "0".repeat(64),
      createdAt: "2026-07-24T01:00:00.000Z",
      createdBy: "user",
      aiEditable: false
    }];
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(lockedSession, null, 2)}\n`);
    await expect(service.rerun({
      notebookId: "analysis", sessionId: "lecture", transcriptBlockId: started.transcriptBlockId
    })).rejects.toMatchObject({ code: "block_locked", statusCode: 423, taskId: started.id });
    lockedSession.locks = [];
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(lockedSession, null, 2)}\n`);

    const rerun = await service.rerun({
      notebookId: "analysis", sessionId: "lecture", transcriptBlockId: started.transcriptBlockId
    });
    expect(rerun.id).toBe(started.id);
    expect(rerun.transcriptBlockId).toBe(started.transcriptBlockId);
    const failed = await waitForTerminal(service, rerun.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 2, providerName: "fixture-failure" });
    expect(await readFile(transcriptPath, "utf8")).toBe(reviewed);
    expect((await readSession()).blocks.filter((block) => block.id === started.transcriptBlockId)).toHaveLength(1);
    expect(service.eventsAfter(rerun.id).at(-1)?.message).toBe("重新识别未完成，已恢复原转写。");

    const recovered = await service.rerun({
      notebookId: "analysis", sessionId: "lecture", transcriptBlockId: started.transcriptBlockId
    });
    expect((await waitForTerminal(service, recovered.id))).toMatchObject({
      status: "succeeded", attempts: 3, providerName: "recovered-provider"
    });
    expect(await readFile(transcriptPath, "utf8")).toBe("## 忠实转写\n\n$$x+y=z$$\n");
    expect((await readSession()).blocks.filter((block) => block.id === started.transcriptBlockId)).toHaveLength(1);

    const reviewedAgain = "## 再次人工校订\n\n中断也必须恢复。\n";
    await writeFile(transcriptPath, reviewedAgain);
    const cancelledRerun = await service.rerun({
      notebookId: "analysis", sessionId: "lecture", transcriptBlockId: started.transcriptBlockId
    });
    await waitForStatus(service, cancelledRerun.id, "running");
    await service.cancel({ notebookId: "analysis", sessionId: "lecture", taskId: cancelledRerun.id });
    expect(cancelledProvider.wasAborted()).toBe(true);
    expect(await readFile(transcriptPath, "utf8")).toBe(reviewedAgain);
  });

  function streamingProvider(name = "fixture-stream"): RecognitionProvider {
    return {
      name,
      async transcribe() { return { markdown: "## 忠实转写\n\n$$x+y=z$$\n" }; },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "started", message: "fixture started" });
        input.onEvent({ type: "stdout", text: "## 忠实转写\n\n" });
        input.onEvent({ type: "stdout", text: "$$x+y=z$$\n" });
        input.onEvent({ type: "completed", message: "fixture completed" });
        return { markdown: "## 忠实转写\n\n$$x+y=z$$\n" };
      }
    };
  }

  function deferredProvider(name: string) {
    let aborted = false;
    const provider: RecognitionProvider = {
      name,
      async transcribe(input) { return waitForAbort(input.abortSignal); },
      async transcribeWithEvents(input) {
        input.onEvent({ type: "started", message: "waiting" });
        return waitForAbort(input.abortSignal);
      }
    };
    function waitForAbort(signal?: AbortSignal): Promise<{ markdown: string }> {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          aborted = true;
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
    return { provider, wasAborted: () => aborted };
  }

  async function waitForTerminal(service: SessionRecognitionService, taskId: string): Promise<SessionRecognitionTask> {
    for (let index = 0; index < 600; index += 1) {
      const task = await service.get({ notebookId: "analysis", sessionId: "lecture", taskId });
      if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`task ${taskId} did not reach terminal state`);
  }

  async function waitForStatus(
    service: SessionRecognitionService,
    taskId: string,
    status: SessionRecognitionTask["status"]
  ): Promise<SessionRecognitionTask> {
    let lastTask: SessionRecognitionTask | undefined;
    for (let index = 0; index < 600; index += 1) {
      const task = await service.get({ notebookId: "analysis", sessionId: "lecture", taskId });
      lastTask = task;
      if (task.status === status) return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`task ${taskId} did not reach ${status}: ${JSON.stringify(lastTask)}`);
  }

  async function readSession(): Promise<SessionRecord> {
    return JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
  }

  async function writeSession(): Promise<void> {
    const session: SessionRecord = {
      id: "lecture", title: "第三讲", status: "draft",
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
      currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
      locks: [],
      blocks: [
        {
          id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
          readonly: false, editableByAi: false,
          createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
        },
        {
          id: "0002", type: "image", path: "assets/photos/board.png", source: "user", status: "draft",
          readonly: false, editableByAi: false, renderInNote: true,
          createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
        }
      ]
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  }
});

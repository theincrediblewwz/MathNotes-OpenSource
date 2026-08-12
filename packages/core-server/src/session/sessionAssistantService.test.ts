import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBlockRef,
  createSessionRecord,
  type AssistantProvider
} from "@mathnotes/shared";
import {
  SessionAssistantService,
  type SessionAssistantTask
} from "./sessionAssistantService";

describe("SessionAssistantService", () => {
  let root: string;
  let sessionDir: string;
  let capturedContext = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-session-assistant-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "第一块：定义\n");
    await writeFile(join(sessionDir, "blocks", "0002.md"), "第二块：一致有界原理\n");
    const session = createSessionRecord({
      id: "lecture",
      title: "泛函分析",
      createdAt: "2026-07-28T00:00:00.000Z"
    });
    session.blocks = [
      createBlockRef({
        id: "0001",
        type: "markdown",
        path: "blocks/0001.md",
        source: "user",
        createdAt: session.createdAt
      }),
      createBlockRef({
        id: "0002",
        type: "markdown",
        path: "blocks/0002.md",
        source: "ai_transcription",
        createdAt: session.createdAt
      })
    ];
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("uses the same exact packet for preview and provider input, then stores a compatible remark", async () => {
    const service = new SessionAssistantService(root, async () => provider());
    const input = {
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "session" as const,
      question: "第 2 块说明了什么？"
    };
    const preview = await service.preview(input);
    const remark = await service.run({ ...input, mode: "explain" });

    expect(capturedContext).toContain("## 第 2 块 · stable ID 0002");
    expect(Array.from(capturedContext)).toHaveLength(preview.usage.textCharacters);
    expect(remark.usage).toEqual(preview.usage);
    expect(remark.html).toContain("<!doctype html>");
    expect((await service.list(input))).toHaveLength(1);
    const index = JSON.parse(await readFile(join(sessionDir, "assistant", "index.json"), "utf8"));
    expect(index).toMatchObject({ version: 1, remarks: [{ id: remark.id }] });
  });

  it("requires explicit selection text and only promotes after an explicit command", async () => {
    const service = new SessionAssistantService(root, async () => provider());
    await expect(service.preview({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "selection",
      activeBlockId: "0002"
    })).rejects.toMatchObject({ code: "selection_required", statusCode: 422 });

    const remark = await service.run({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "selection",
      activeBlockId: "0002",
      selectedText: "一致有界原理",
      mode: "teach"
    });
    const before = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
    expect(before.blocks).toHaveLength(2);

    const promoted = await service.promote({
      notebookId: "analysis",
      sessionId: "lecture",
      remarkId: remark.id
    });
    const after = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
    expect(promoted.promoted).toBe(true);
    expect(after.blocks).toHaveLength(3);
    expect(after.blocks[2]).toMatchObject({ id: promoted.blockId, source: "ai_explanation" });
    expect(await readFile(join(sessionDir, after.blocks[2].path), "utf8")).toContain("回答");
  });

  it("deletes the independent remark without changing note blocks", async () => {
    const service = new SessionAssistantService(root, async () => provider());
    const remark = await service.run({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "block",
      activeBlockId: "0001",
      mode: "summarize"
    });
    expect(await service.remove({
      notebookId: "analysis",
      sessionId: "lecture",
      remarkId: remark.id
    })).toBe(true);
    expect(await service.list({ notebookId: "analysis", sessionId: "lecture" })).toEqual([]);
    const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
    expect(session.blocks).toHaveLength(2);
  });

  it("starts an async task, forwards provider events and persists a terminal remark", async () => {
    const service = new SessionAssistantService(root, async () => streamingAssistantProvider());
    const started = await service.start({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "block",
      activeBlockId: "0001",
      question: "第 1 块讲了什么？",
      mode: "explain"
    });
    expect(started).toMatchObject({ status: "pending", attempts: 0, mode: "explain" });

    const completed = await waitForAssistantTerminal(service, started.id);
    expect(completed).toMatchObject({
      status: "succeeded",
      attempts: 1,
      providerName: "assistant-stream",
      error: undefined
    });

    const events = service.eventsAfter(started.id);
    expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((a, b) => a - b));
    expect(events.some((event) => event.type === "started")).toBe(true);
    expect(events.some((event) => event.type === "stage" && event.message.includes("assistant-stream"))).toBe(true);
    expect(events.some((event) => event.type === "stdout" && event.delta?.includes("完整回答"))).toBe(true);
    expect(events.some((event) => event.type === "stderr" && event.message.includes("warning"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "completed", task: { status: "succeeded" } });
    const tail = service.eventsAfter(started.id, events[1]?.sequence ?? 0);
    expect(tail.every((event) => event.sequence > (events[1]?.sequence ?? 0))).toBe(true);

    const remarks = await service.list({ notebookId: "analysis", sessionId: "lecture" });
    expect(remarks).toHaveLength(1);
    expect(remarks[0]).toMatchObject({
      markdown: "## 回答\n\n这里是完整回答。\n",
      providerName: "assistant-stream",
      sourceBlockIds: ["0001"]
    });
    const jobs = JSON.parse(await readFile(join(sessionDir, "logs", "session_assistant_jobs.json"), "utf8"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: started.id, status: "succeeded", timing: { firstOutputMs: expect.any(Number) } });
    expect(JSON.stringify(completed)).not.toContain(sessionDir);
  }, 15_000);

  it("cancels an async task through AbortSignal and persists the terminal state", async () => {
    const deferred = deferredAssistantProvider("slow-assistant");
    const service = new SessionAssistantService(root, async () => deferred.provider);
    const started = await service.start({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "block",
      activeBlockId: "0001",
      mode: "summarize"
    });
    await waitForAssistantStatus(service, started.id, "running");

    const cancelled = await service.cancel({ notebookId: "analysis", sessionId: "lecture", taskId: started.id });
    expect(cancelled).toMatchObject({ status: "cancelled", failureKind: "cancelled" });
    expect(deferred.wasAborted()).toBe(true);
    expect(await service.get({ notebookId: "analysis", sessionId: "lecture", taskId: started.id }))
      .toMatchObject({ status: "cancelled", error: "用户已取消回答。" });
    expect(service.eventsAfter(started.id).some((event) => event.type === "error" && event.message.includes("取消")))
      .toBe(true);
    await expect(service.cancel({ notebookId: "analysis", sessionId: "lecture", taskId: started.id }))
      .rejects.toEqual(expect.objectContaining<Partial<{ code: string; statusCode: number; taskId: string }>>({
        code: "task_not_cancellable",
        statusCode: 409,
        taskId: started.id
      }));
    expect(await service.list({ notebookId: "analysis", sessionId: "lecture" })).toEqual([]);
  }, 15_000);

  it("fails with a terminal first-byte timeout when a non-streaming provider never responds", async () => {
    const service = new SessionAssistantService(root, async () => ({
      name: "silent-assistant",
      async assist() {
        return new Promise<never>(() => undefined);
      }
    }));
    const started = await service.start({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "block",
      activeBlockId: "0001",
      mode: "explain",
      firstByteTimeoutMs: 60,
      streamIdleTimeoutMs: 30
    });
    const terminal = await waitForAssistantTerminal(service, started.id);
    expect(terminal).toMatchObject({
      status: "failed",
      failureKind: "first_byte_timeout",
      error: expect.stringContaining("首个回答字节")
    });
    expect(service.eventsAfter(started.id).some(
      (event) => event.type === "error" && event.message.includes("首个回答字节")
    )).toBe(true);
    expect(await service.list({ notebookId: "analysis", sessionId: "lecture" })).toEqual([]);
  }, 15_000);

  it("fails with a terminal stream-idle timeout when output stalls after the first byte", async () => {
    const service = new SessionAssistantService(root, async () => ({
      name: "stalling-assistant",
      async assist() { throw new Error("event path expected"); },
      async assistWithEvents(input) {
        input.onEvent({ type: "stdout", text: "开头" });
        return new Promise<never>(() => undefined);
      }
    }));
    const started = await service.start({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "block",
      activeBlockId: "0001",
      mode: "explain",
      firstByteTimeoutMs: 5_000,
      streamIdleTimeoutMs: 50
    });
    const terminal = await waitForAssistantTerminal(service, started.id);
    expect(terminal).toMatchObject({
      status: "failed",
      failureKind: "stream_idle_timeout",
      error: expect.stringContaining("空闲")
    });
    expect(service.eventsAfter(started.id).some(
      (event) => event.type === "error" && event.message.includes("空闲")
    )).toBe(true);
  }, 15_000);

  it("recovers an orphaned running task as a terminal failure after service restart", async () => {
    const deferred = deferredAssistantProvider("orphan-assistant");
    const service = new SessionAssistantService(root, async () => deferred.provider);
    const started = await service.start({
      notebookId: "analysis",
      sessionId: "lecture",
      scope: "block",
      activeBlockId: "0001",
      mode: "explain"
    });
    await waitForAssistantStatus(service, started.id, "running");

    const restarted = new SessionAssistantService(root, async () => streamingAssistantProvider());
    const recovered = await restarted.get({ notebookId: "analysis", sessionId: "lecture", taskId: started.id });
    expect(recovered).toMatchObject({
      status: "failed",
      failureKind: "provider_failed",
      error: "上次学习助手任务被中断，请重试。"
    });
    await service.cancel({ notebookId: "analysis", sessionId: "lecture", taskId: started.id }).catch(() => undefined);
  }, 15_000);

  function provider(): AssistantProvider {
    return {
      name: "fixture-assistant",
      async assist(input) {
        capturedContext = input.markdownContext;
        return { markdown: "## 回答\n\n这里解释一致有界原理。" };
      }
    };
  }

  function streamingAssistantProvider(): AssistantProvider {
    return {
      name: "assistant-stream",
      async assist() { throw new Error("event path expected"); },
      async assistWithEvents(input) {
        input.onEvent({ type: "started", message: "assistant started" });
        input.onEvent({ type: "stdout", text: "## 回答\n\n" });
        input.onEvent({ type: "stderr", text: "warning: fixture" });
        input.onEvent({ type: "stdout", text: "这里是完整回答。" });
        input.onEvent({ type: "completed", message: "assistant completed" });
        return { markdown: "## 回答\n\n这里是完整回答。" };
      }
    };
  }

  function deferredAssistantProvider(name: string) {
    let aborted = false;
    const provider: AssistantProvider = {
      name,
      async assist(input) { return waitForAbort(input.abortSignal); },
      async assistWithEvents(input) {
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

  async function waitForAssistantTerminal(service: SessionAssistantService, taskId: string): Promise<SessionAssistantTask> {
    for (let index = 0; index < 600; index += 1) {
      const task = await service.get({ notebookId: "analysis", sessionId: "lecture", taskId });
      if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`assistant task ${taskId} did not reach terminal state`);
  }

  async function waitForAssistantStatus(
    service: SessionAssistantService,
    taskId: string,
    status: SessionAssistantTask["status"]
  ): Promise<SessionAssistantTask> {
    let lastTask: SessionAssistantTask | undefined;
    for (let index = 0; index < 600; index += 1) {
      const task = await service.get({ notebookId: "analysis", sessionId: "lecture", taskId });
      lastTask = task;
      if (task.status === status) return task;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`assistant task ${taskId} did not reach ${status}: ${JSON.stringify(lastTask)}`);
  }
});

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import {
  ASSISTANT_CONTEXT_LIMITS,
  buildAssistantContextPacket,
  createBlockRef,
  type AssistantInput,
  type AssistantProviderEvent,
  type AssistantResult,
  type AssistantContextFocus,
  type AssistantContextUsage,
  type AssistantMode,
  type AssistantProvider,
  type BlockRef,
  type SessionRecord
} from "@mathnotes/shared";
import { renderPortableMarkdown } from "../render/portableMarkdown";
import { markdownBlockDocument } from "./sessionReadService";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { isSafeWorkspaceIdentifier } from "./workspaceIdentifier";

export type SessionAssistantInput = Readonly<{
  notebookId: string;
  sessionId: string;
  scope: "selection" | "block" | "session";
  activeBlockId?: string;
  selectedText?: string;
  focusLabel?: string;
  question?: string;
}>;

export type SessionAssistantPreview = Readonly<{
  version: 1;
  focus: AssistantContextFocus;
  usage: AssistantContextUsage;
  imageCount: number;
  sourceBlockIds: readonly string[];
}>;

export const DEFAULT_ASSISTANT_FIRST_BYTE_TIMEOUT_MS = 30_000;
export const DEFAULT_ASSISTANT_STREAM_IDLE_TIMEOUT_MS = 15_000;

export type SessionAssistantTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type SessionAssistantFailureKind =
  | "first_byte_timeout"
  | "stream_idle_timeout"
  | "provider_unavailable"
  | "provider_failed"
  | "cancelled";

export type SessionAssistantTiming = Readonly<{
  acceptedAt: string;
  providerStartedAt?: string;
  firstOutputAt?: string;
  completedAt?: string;
  firstOutputMs?: number;
  providerMs?: number;
  totalMs?: number;
}>;

export type SessionAssistantTask = Readonly<{
  version: 1;
  id: string;
  notebookId: string;
  sessionId: string;
  status: SessionAssistantTaskStatus;
  attempts: number;
  mode: AssistantMode;
  providerName?: string;
  error?: string;
  failureKind?: SessionAssistantFailureKind;
  timing?: SessionAssistantTiming;
  createdAt: string;
  updatedAt: string;
}>;

export type SessionAssistantTaskEvent = Readonly<{
  version: 1;
  sequence: number;
  taskId: string;
  type: "started" | "stage" | "stdout" | "stderr" | "completed" | "error";
  message: string;
  delta?: string;
  task: SessionAssistantTask;
}>;

export type SessionAssistantTaskInput = SessionAssistantInput & {
  mode: AssistantMode;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
};

export type SessionAssistantRemark = Readonly<{
  version: 1;
  id: string;
  mode: AssistantMode;
  focus: AssistantContextFocus;
  question?: string;
  markdown: string;
  html: string;
  providerName: string;
  sourceBlockIds: readonly string[];
  usage: AssistantContextUsage;
  imageCount: number;
  createdAt: string;
  updatedAt: string;
}>;

type StoredRemark = Omit<SessionAssistantRemark, "html">;
type RemarkIndexEntry = Omit<StoredRemark, "markdown"> & { file: string };
type RemarkIndex = Readonly<{ version: 1; remarks: readonly RemarkIndexEntry[] }>;
type PreparedAssistantInput = Readonly<{
  markdownContext: string;
  usage: AssistantContextUsage;
  focus: AssistantContextFocus;
  imagePaths: string[];
  sourceBlockIds: readonly string[];
}>;
type StoredAssistantTask = SessionAssistantTask & Readonly<{
  scope: SessionAssistantInput["scope"];
  activeBlockId?: string;
  selectedText?: string;
  focusLabel?: string;
  question?: string;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
  executionId?: string;
}>;

export class SessionAssistantError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "invalid_session"
      | "block_not_found"
      | "selection_required"
      | "assistant_unavailable"
      | "remark_not_found"
      | "task_not_found"
      | "task_not_cancellable"
      | "path_outside_session",
    readonly statusCode: number,
    readonly taskId?: string
  ) {
    super(code);
    this.name = "SessionAssistantError";
  }
}

export class SessionAssistantService {
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly events = new Map<string, SessionAssistantTaskEvent[]>();
  private readonly subscribers = new Map<string, Set<(event: SessionAssistantTaskEvent) => void>>();
  private sequence = 0;

  constructor(
    private readonly rootDir: string,
    private readonly createProvider: () => Promise<AssistantProvider>,
    private readonly coordinator = new SessionWriteCoordinator(),
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async preview(input: SessionAssistantInput): Promise<SessionAssistantPreview> {
    const prepared = await this.prepare(input);
    return {
      version: 1,
      focus: prepared.focus,
      usage: prepared.usage,
      imageCount: prepared.imagePaths.length,
      sourceBlockIds: prepared.sourceBlockIds
    };
  }

  async run(
    input: SessionAssistantInput & { mode: AssistantMode; abortSignal?: AbortSignal }
  ): Promise<SessionAssistantRemark> {
    const prepared = await this.prepare(input);
    let provider: AssistantProvider;
    try {
      provider = await this.createProvider();
    } catch {
      throw new SessionAssistantError("assistant_unavailable", 503);
    }
    const result = provider.assistWithEvents
      ? await provider.assistWithEvents({
          mode: input.mode,
          markdownContext: prepared.markdownContext,
          imagePaths: prepared.imagePaths,
          question: input.question,
          sessionId: input.sessionId,
          abortSignal: input.abortSignal,
          onEvent: () => undefined
        })
      : await provider.assist({
          mode: input.mode,
          markdownContext: prepared.markdownContext,
          imagePaths: prepared.imagePaths,
          question: input.question,
          sessionId: input.sessionId,
          abortSignal: input.abortSignal
        });
    input.abortSignal?.throwIfAborted();
    const timestamp = this.now();
    const stored: StoredRemark = {
      version: 1,
      id: `remark_${randomUUID()}`,
      mode: input.mode,
      focus: prepared.focus,
      question: input.question?.trim() || undefined,
      markdown: result.markdown.trim(),
      providerName: provider.name,
      sourceBlockIds: prepared.sourceBlockIds,
      usage: prepared.usage,
      imageCount: prepared.imagePaths.length,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.coordinator.run(input.notebookId, input.sessionId, () => this.append(input, stored));
    return this.renderRemark(stored);
  }

  async start(input: SessionAssistantTaskInput): Promise<SessionAssistantTask> {
    const prepared = await this.prepare(input);
    const timestamp = this.now();
    const task: StoredAssistantTask = {
      version: 1,
      id: `assistant_${randomUUID()}`,
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      status: "pending",
      attempts: 0,
      mode: input.mode,
      scope: input.scope,
      activeBlockId: input.activeBlockId,
      selectedText: input.selectedText,
      focusLabel: input.focusLabel,
      question: input.question,
      firstByteTimeoutMs: input.firstByteTimeoutMs ?? DEFAULT_ASSISTANT_FIRST_BYTE_TIMEOUT_MS,
      streamIdleTimeoutMs: input.streamIdleTimeoutMs ?? DEFAULT_ASSISTANT_STREAM_IDLE_TIMEOUT_MS,
      timing: { acceptedAt: timestamp },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.persistTask(task);
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);
    this.emit(task, "started", "学习助手任务已接受。");
    this.scheduleRun(task, prepared, controller);
    return publicTask(task);
  }

  async get(input: { notebookId: string; sessionId: string; taskId: string }): Promise<SessionAssistantTask> {
    const task = await this.requireTask(input);
    return publicTask(await this.recoverOrphan(task));
  }

  async cancel(input: { notebookId: string; sessionId: string; taskId: string }): Promise<SessionAssistantTask> {
    const task = await this.requireTask(input);
    if (task.status !== "pending" && task.status !== "running") {
      throw new SessionAssistantError("task_not_cancellable", 409, task.id);
    }
    this.abortControllers.get(task.id)?.abort(new Error("Assistant task cancelled"));
    const cancelled = await this.updateTask(task, {
      status: "cancelled",
      error: "用户已取消回答。",
      failureKind: "cancelled",
      timing: completedTiming(task, this.now())
    });
    this.emit(cancelled, "error", "回答已取消。");
    await this.waitForRun(task.id, 500);
    return publicTask(cancelled);
  }

  eventsAfter(taskId: string, afterSequence = 0): SessionAssistantTaskEvent[] {
    return (this.events.get(taskId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  subscribe(taskId: string, listener: (event: SessionAssistantTaskEvent) => void): () => void {
    const listeners = this.subscribers.get(taskId) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(taskId);
    };
  }

  async list(input: { notebookId: string; sessionId: string }): Promise<SessionAssistantRemark[]> {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const stored = await readStoredRemarks(context.sessionDir);
    return Promise.all(stored.map((remark) => this.renderRemark(remark)));
  }

  async remove(input: { notebookId: string; sessionId: string; remarkId: string }): Promise<boolean> {
    return this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
      const index = await readRemarkIndex(context.sessionDir);
      const entry = index.remarks.find((candidate) => candidate.id === input.remarkId);
      if (!entry) return false;
      await writeRemarkIndex(context.sessionDir, {
        version: 1,
        remarks: index.remarks.filter((candidate) => candidate.id !== input.remarkId)
      });
      await rm(resolveAssistantFile(context.sessionDir, entry.file), { force: true });
      return true;
    });
  }

  async promote(input: {
    notebookId: string;
    sessionId: string;
    remarkId: string;
  }): Promise<{ version: 1; promoted: true; blockId: string }> {
    return this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
      const remark = (await readStoredRemarks(context.sessionDir))
        .find((candidate) => candidate.id === input.remarkId);
      if (!remark) throw new SessionAssistantError("remark_not_found", 404);
      const timestamp = this.now();
      const blockId = nextBlockId(context.session);
      const blockPath = `blocks/${blockId}_ai_explanation.md`;
      const block = createBlockRef({
        id: blockId,
        type: "markdown",
        path: blockPath,
        source: "ai_explanation",
        createdAt: timestamp
      });
      const sourceIndexes = remark.sourceBlockIds
        .map((id) => context.session.blocks.findIndex((candidate) => candidate.id === id))
        .filter((index) => index >= 0);
      const insertAt = sourceIndexes.length > 0 ? Math.max(...sourceIndexes) + 1 : context.session.blocks.length;
      const nextSession: SessionRecord = {
        ...context.session,
        updatedAt: timestamp,
        blocks: [
          ...context.session.blocks.slice(0, insertAt),
          block,
          ...context.session.blocks.slice(insertAt)
        ]
      };
      const absoluteBlockPath = resolve(context.sessionDir, blockPath);
      assertInside(context.sessionDir, absoluteBlockPath);
      await writeAtomic(absoluteBlockPath, `${remark.markdown.trim()}\n`);
      try {
        await writeAtomic(context.sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
      } catch (error) {
        await rm(absoluteBlockPath, { force: true });
        throw error;
      }
      return { version: 1, promoted: true, blockId };
    });
  }

  private async prepare(input: SessionAssistantInput) {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const readableBlocks = context.session.blocks.filter(
      (block) => block.type === "markdown" && block.source !== "ai_explanation"
    );
    const markdownByBlockId = new Map(
      await Promise.all(readableBlocks.map(async (block) => {
        const target = resolve(context.sessionDir, block.path);
        assertInside(context.sessionDir, target);
        return [block.id, await readFile(target, "utf8")] as const;
      }))
    );
    const focusBlocks = input.scope === "session"
      ? readableBlocks
      : readableBlocks.filter((block) => block.id === input.activeBlockId);
    if (focusBlocks.length === 0) throw new SessionAssistantError("block_not_found", 404);
    const focus = buildFocus(input, focusBlocks, markdownByBlockId);
    const packet = buildAssistantContextPacket({
      focus,
      question: input.question,
      blocks: readableBlocks.map((block) => ({
        id: block.id,
        source: block.source,
        markdown: markdownByBlockId.get(block.id) ?? ""
      }))
    });
    const imagePaths = await collectImagePaths({
      sessionDir: context.sessionDir,
      selectedMarkdownBlocks: focusBlocks,
      allBlocks: context.session.blocks,
      includeSessionImages: input.scope === "session"
    });
    return {
      ...packet,
      focus,
      imagePaths,
      sourceBlockIds: focusBlocks.map((block) => block.id)
    };
  }

  private scheduleRun(
    task: StoredAssistantTask,
    prepared: PreparedAssistantInput,
    controller: AbortController
  ): void {
    const running = this.executeTask(task, prepared, controller);
    this.activeRuns.set(task.id, running);
    void running.then(
      () => { if (this.activeRuns.get(task.id) === running) this.activeRuns.delete(task.id); },
      (error) => {
        if (this.activeRuns.get(task.id) === running) this.activeRuns.delete(task.id);
        this.emit(task, "error", error instanceof Error ? error.message : "学习助手任务异常退出。");
      }
    );
  }

  private async waitForRun(taskId: string, timeoutMs: number): Promise<void> {
    const running = this.activeRuns.get(taskId);
    if (!running) return;
    await Promise.race([
      running.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  private async executeTask(
    initial: StoredAssistantTask,
    prepared: PreparedAssistantInput,
    controller: AbortController
  ): Promise<void> {
    let task = await this.requireTask({
      notebookId: initial.notebookId,
      sessionId: initial.sessionId,
      taskId: initial.id
    });
    if (task.status !== "pending") return;
    let firstOutputAt: string | undefined;
    let timeoutFired: { failureKind: SessionAssistantFailureKind; message: string } | undefined;
    let providerSettled = false;
    let watchdogReject: ((reason: Error) => void) | undefined;
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const fail = (failureKind: SessionAssistantFailureKind, message: string) => {
      if (providerSettled || timeoutFired) return;
      timeoutFired = { failureKind, message };
      controller.abort(new Error(message));
      watchdogReject?.(new Error(message));
    };
    const armFirstByte = () => {
      if (firstByteTimer) return;
      firstByteTimer = setTimeout(() => {
        fail("first_byte_timeout", `等待首个回答字节超过 ${task.firstByteTimeoutMs} 毫秒。`);
      }, task.firstByteTimeoutMs);
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail("stream_idle_timeout", `回答流空闲超过 ${task.streamIdleTimeoutMs} 毫秒。`);
      }, task.streamIdleTimeoutMs);
    };

    try {
      let provider: AssistantProvider;
      try {
        provider = await this.createProvider();
      } catch {
        throw new AssistantTaskFailure("provider_unavailable", "学习助手服务不可用。");
      }
      const running = await this.transitionTask(task, ["pending"], {
        status: "running",
        attempts: task.attempts + 1,
        executionId: randomUUID(),
        providerName: provider.name,
        error: undefined,
        failureKind: undefined,
        timing: {
          acceptedAt: task.timing?.acceptedAt ?? task.createdAt,
          providerStartedAt: this.now()
        }
      });
      if (!running) return;
      task = running;
      this.emit(task, "stage", `学习助手服务已启动：${provider.name}。`);
      armFirstByte();

      const onEvent = (event: AssistantProviderEvent) => {
        if (event.type === "started") {
          this.emit(task, "started", event.message);
          return;
        }
        if (event.type === "stdout") {
          if (event.text.length > 0 && !firstOutputAt) {
            firstOutputAt = this.now();
            if (firstByteTimer) {
              clearTimeout(firstByteTimer);
              firstByteTimer = undefined;
            }
          }
          this.emit(task, "stdout", "回答内容正在生成。", event.text);
          if (firstOutputAt) armIdle();
          return;
        }
        if (event.type === "stderr") {
          this.emit(task, "stderr", event.text);
          if (firstOutputAt) armIdle();
          return;
        }
        this.emit(task, "completed", event.message);
        if (firstByteTimer) {
          clearTimeout(firstByteTimer);
          firstByteTimer = undefined;
        }
        if (firstOutputAt) armIdle();
      };

      const providerInput: AssistantInput = {
        mode: task.mode,
        markdownContext: prepared.markdownContext,
        imagePaths: prepared.imagePaths,
        question: task.question,
        sessionId: task.sessionId,
        abortSignal: controller.signal
      };
      const providerPromise = provider.assistWithEvents
        ? provider.assistWithEvents({ ...providerInput, onEvent })
        : provider.assist(providerInput);
      const watchdog = new Promise<never>((_resolve, reject) => {
        watchdogReject = reject;
      });
      let result: AssistantResult;
      try {
        result = await Promise.race([providerPromise, watchdog]);
      } catch (error) {
        if (timeoutFired) {
          throw new AssistantTaskFailure(timeoutFired.failureKind, timeoutFired.message);
        }
        if (controller.signal.aborted) {
          const current = await this.requireTask({
            notebookId: task.notebookId,
            sessionId: task.sessionId,
            taskId: task.id
          });
          if (current.status === "cancelled" || current.executionId !== task.executionId) return;
          throw new AssistantTaskFailure("cancelled", "用户已取消回答。");
        }
        throw new AssistantTaskFailure(
          "provider_failed",
          error instanceof Error ? error.message : "学习助手回答失败。"
        );
      } finally {
        providerSettled = true;
        clearTimers();
      }

      const completedAt = this.now();
      const stored: StoredRemark = {
        version: 1,
        id: `remark_${randomUUID()}`,
        mode: task.mode,
        focus: prepared.focus,
        question: task.question?.trim() || undefined,
        markdown: result.markdown.trim(),
        providerName: provider.name,
        sourceBlockIds: prepared.sourceBlockIds,
        usage: prepared.usage,
        imageCount: prepared.imagePaths.length,
        createdAt: completedAt,
        updatedAt: completedAt
      };
      await this.coordinator.run(task.notebookId, task.sessionId, () => this.append(task, stored));
      const succeeded = await this.transitionTask(task, ["running"], {
        status: "succeeded",
        error: undefined,
        failureKind: undefined,
        timing: completedTiming(task, completedAt, firstOutputAt)
      });
      if (!succeeded) return;
      task = succeeded;
      this.emit(task, "completed", "回答完成。");
    } catch (error) {
      providerSettled = true;
      clearTimers();
      const current = await this.requireTask({
        notebookId: task.notebookId,
        sessionId: task.sessionId,
        taskId: task.id
      });
      if (current.executionId !== task.executionId) return;
      if (current.status === "cancelled") return;
      const failure = error instanceof AssistantTaskFailure
        ? error
        : new AssistantTaskFailure(
            "provider_failed",
            error instanceof Error ? error.message : "学习助手回答失败。"
          );
      const status: SessionAssistantTaskStatus = failure.failureKind === "cancelled" ? "cancelled" : "failed";
      const completedAt = this.now();
      task = await this.updateTask(current, {
        status,
        error: failure.message,
        failureKind: failure.failureKind,
        timing: completedTiming(current, completedAt, firstOutputAt)
      });
      this.emit(task, "error", failure.message);
    } finally {
      clearTimers();
      if (this.abortControllers.get(task.id) === controller) {
        this.abortControllers.delete(task.id);
      }
    }
  }

  private async requireTask(input: { notebookId: string; sessionId: string; taskId: string }): Promise<StoredAssistantTask> {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const task = (await readTasks(context.sessionDir)).find((candidate) => candidate.id === input.taskId);
    if (!task) throw new SessionAssistantError("task_not_found", 404);
    return task;
  }

  private async recoverOrphan(task: StoredAssistantTask): Promise<StoredAssistantTask> {
    if ((task.status !== "pending" && task.status !== "running") || this.abortControllers.has(task.id)) {
      return task;
    }
    return this.updateTask(task, {
      status: "failed",
      error: "上次学习助手任务被中断，请重试。",
      failureKind: "provider_failed"
    });
  }

  private async updateTask(task: StoredAssistantTask, changes: Partial<StoredAssistantTask>): Promise<StoredAssistantTask> {
    return this.coordinator.run(task.notebookId, task.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
      const current = (await readTasks(context.sessionDir)).find((candidate) => candidate.id === task.id);
      if (!current) throw new SessionAssistantError("task_not_found", 404, task.id);
      const updated: StoredAssistantTask = { ...current, ...changes, updatedAt: this.now() };
      await upsertTask(context.sessionDir, updated);
      return updated;
    });
  }

  private transitionTask(
    task: StoredAssistantTask,
    expected: readonly SessionAssistantTaskStatus[],
    changes: Partial<StoredAssistantTask>
  ): Promise<StoredAssistantTask | undefined> {
    return this.coordinator.run(task.notebookId, task.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
      const current = (await readTasks(context.sessionDir)).find((candidate) => candidate.id === task.id);
      if (!current) throw new SessionAssistantError("task_not_found", 404, task.id);
      if (!expected.includes(current.status)) return undefined;
      const updated: StoredAssistantTask = { ...current, ...changes, updatedAt: this.now() };
      await upsertTask(context.sessionDir, updated);
      return updated;
    });
  }

  private persistTask(task: StoredAssistantTask): Promise<void> {
    return this.coordinator.run(task.notebookId, task.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
      await upsertTask(context.sessionDir, task);
    });
  }

  private emit(task: StoredAssistantTask, type: SessionAssistantTaskEvent["type"], message: string, delta?: string): void {
    const event: SessionAssistantTaskEvent = {
      version: 1,
      sequence: ++this.sequence,
      taskId: task.id,
      type,
      message,
      delta,
      task: publicTask(task)
    };
    const events = [...(this.events.get(task.id) ?? []), event].slice(-500);
    this.events.set(task.id, events);
    for (const listener of this.subscribers.get(task.id) ?? []) listener(event);
  }

  private async append(
    input: Pick<SessionAssistantInput, "notebookId" | "sessionId">,
    remark: StoredRemark
  ): Promise<void> {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const index = await readRemarkIndex(context.sessionDir);
    const entry = toIndexEntry(remark);
    await writeAtomic(resolveAssistantFile(context.sessionDir, entry.file), `${remark.markdown.trim()}\n`);
    await writeRemarkIndex(context.sessionDir, {
      version: 1,
      remarks: [...index.remarks.filter((candidate) => candidate.id !== entry.id), entry]
    });
  }

  private async renderRemark(remark: StoredRemark): Promise<SessionAssistantRemark> {
    const body = await renderPortableMarkdown({ markdown: remark.markdown });
    return { ...remark, html: markdownBlockDocument(body) };
  }
}

class AssistantTaskFailure extends Error {
  constructor(readonly failureKind: SessionAssistantFailureKind, message: string) {
    super(message);
    this.name = "AssistantTaskFailure";
  }
}

function publicTask(task: StoredAssistantTask): SessionAssistantTask {
  return {
    version: task.version,
    id: task.id,
    notebookId: task.notebookId,
    sessionId: task.sessionId,
    status: task.status,
    attempts: task.attempts,
    mode: task.mode,
    providerName: task.providerName,
    error: task.error,
    failureKind: task.failureKind,
    timing: task.timing,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function completedTiming(
  task: StoredAssistantTask,
  completedAt: string,
  firstOutputAt?: string
): SessionAssistantTiming {
  const acceptedAt = task.timing?.acceptedAt ?? task.createdAt;
  const providerStartedAt = task.timing?.providerStartedAt;
  return {
    acceptedAt,
    providerStartedAt,
    firstOutputAt: firstOutputAt ?? task.timing?.firstOutputAt,
    completedAt,
    firstOutputMs: elapsedMilliseconds(providerStartedAt, firstOutputAt ?? task.timing?.firstOutputAt),
    providerMs: elapsedMilliseconds(providerStartedAt, completedAt),
    totalMs: elapsedMilliseconds(acceptedAt, completedAt)
  };
}

function elapsedMilliseconds(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

async function readTasks(sessionDir: string): Promise<StoredAssistantTask[]> {
  try {
    const parsed = JSON.parse(await readFile(taskLogPath(sessionDir), "utf8")) as StoredAssistantTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function upsertTask(sessionDir: string, task: StoredAssistantTask): Promise<void> {
  const tasks = await readTasks(sessionDir);
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index >= 0) tasks[index] = task;
  else tasks.push(task);
  await writeAtomicWithRetry(taskLogPath(sessionDir), `${JSON.stringify(tasks, null, 2)}\n`);
}

function taskLogPath(sessionDir: string): string {
  return resolve(sessionDir, "logs", "session_assistant_jobs.json");
}

async function writeAtomicWithRetry(target: string, content: string | Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, content);
    await renameWithTransientRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  const delays = [10, 20, 40, 80, 160, 320, 640, 1_280];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) || attempt >= delays.length) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
    }
  }
}

function buildFocus(
  input: SessionAssistantInput,
  focusBlocks: BlockRef[],
  markdownByBlockId: ReadonlyMap<string, string>
): AssistantContextFocus {
  if (input.scope === "selection") {
    const excerpt = input.selectedText?.trim();
    if (!excerpt) throw new SessionAssistantError("selection_required", 422);
    return {
      kind: "selection",
      blockId: input.activeBlockId,
      label: input.focusLabel?.trim() || `选区 · block ${input.activeBlockId}`,
      excerpt
    };
  }
  if (input.scope === "block") {
    const block = focusBlocks[0];
    return {
      kind: "block",
      blockId: block.id,
      label: input.focusLabel?.trim() || `第 ${block.id} 块`,
      excerpt: markdownByBlockId.get(block.id) ?? ""
    };
  }
  return { kind: "session", label: input.focusLabel?.trim() || "当前 Session" };
}

async function collectImagePaths(input: {
  sessionDir: string;
  selectedMarkdownBlocks: readonly BlockRef[];
  allBlocks: readonly BlockRef[];
  includeSessionImages: boolean;
}): Promise<string[]> {
  const relativePaths = new Set<string>();
  for (const block of input.selectedMarkdownBlocks) {
    if (block.sourcePageImagePath) relativePaths.add(block.sourcePageImagePath);
    for (const asset of block.fromAssets ?? []) relativePaths.add(asset);
  }
  if (input.includeSessionImages) {
    for (const block of input.allBlocks) {
      if (block.type === "image") relativePaths.add(block.path);
    }
  }
  const resolved: string[] = [];
  for (const path of relativePaths) {
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(extname(path).toLowerCase())) continue;
    const absolute = resolve(input.sessionDir, path);
    assertInside(input.sessionDir, absolute);
    try {
      await access(absolute);
      resolved.push(absolute);
      if (resolved.length >= ASSISTANT_CONTEXT_LIMITS.imageCount) break;
    } catch {
      // Missing source evidence is omitted; the Markdown uncertainty marker stays visible.
    }
  }
  return resolved;
}

async function readSessionContext(rootDir: string, notebookId: string, sessionId: string) {
  assertSafeId(notebookId);
  assertSafeId(sessionId);
  const notebooksDir = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
  assertInside(notebooksDir, sessionDir);
  const sessionPath = resolve(sessionDir, "session.json");
  try {
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks) || !Array.isArray(session.locks)) {
      throw new SessionAssistantError("invalid_session", 422);
    }
    return { session, sessionDir, sessionPath };
  } catch (error) {
    if (error instanceof SessionAssistantError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionAssistantError("session_not_found", 404);
    }
    if (error instanceof SyntaxError) throw new SessionAssistantError("invalid_session", 422);
    throw error;
  }
}

async function readStoredRemarks(sessionDir: string): Promise<StoredRemark[]> {
  const index = await readRemarkIndex(sessionDir);
  const remarks = await Promise.all(index.remarks.map(async (entry): Promise<StoredRemark | undefined> => {
    try {
      const { file, ...metadata } = entry;
      return { ...metadata, markdown: await readFile(resolveAssistantFile(sessionDir, file), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
  return remarks.filter((remark): remark is StoredRemark => Boolean(remark));
}

async function readRemarkIndex(sessionDir: string): Promise<RemarkIndex> {
  try {
    const parsed = JSON.parse(await readFile(resolve(sessionDir, "assistant", "index.json"), "utf8")) as RemarkIndex;
    if (parsed.version === 1 && Array.isArray(parsed.remarks)) return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return { version: 1, remarks: [] };
}

function toIndexEntry(remark: StoredRemark): RemarkIndexEntry {
  const { markdown: _markdown, ...metadata } = remark;
  return { ...metadata, file: `remarks/${safeRemarkId(remark.id)}.md` };
}

function resolveAssistantFile(sessionDir: string, portablePath: string): string {
  const root = resolve(sessionDir, "assistant");
  const target = resolve(root, portablePath);
  assertInside(root, target);
  return target;
}

async function writeRemarkIndex(sessionDir: string, index: RemarkIndex): Promise<void> {
  await writeAtomic(resolve(sessionDir, "assistant", "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

function nextBlockId(session: SessionRecord): string {
  const max = session.blocks.reduce((current, block) => {
    const value = Number.parseInt(block.id, 10);
    return Number.isFinite(value) ? Math.max(current, value) : current;
  }, 0);
  return String(max + 1).padStart(4, "0");
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new SessionAssistantError("path_outside_session", 400);
  }
}

function assertSafeId(value: string): void {
  if (!isSafeWorkspaceIdentifier(value)) {
    throw new SessionAssistantError("path_outside_session", 400);
  }
}

function safeRemarkId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

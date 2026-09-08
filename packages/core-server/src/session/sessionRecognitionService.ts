import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createBlockRef, type RecognitionProvider, type RecognitionProviderEvent, type SessionRecord } from "@mathnotes/shared";
import { StreamingOutputGuard } from "../domain/streamingOutputGuard";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { buildSessionRecognitionContext } from "./sessionRecognitionContext";
import { sessionManifestRevision } from "./sessionRevision";
import { bindSourceImageMarkers } from "../domain/sourceImageMarkers";

export type SessionRecognitionStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type SessionRecognitionFailureKind = "output_anomaly" | "provider_unavailable";

export type SessionRecognitionTiming = Readonly<{
  acceptedAt: string;
  providerStartedAt?: string;
  firstOutputAt?: string;
  completedAt?: string;
  firstOutputMs?: number;
  providerMs?: number;
  totalMs?: number;
}>;

export type SessionRecognitionTask = Readonly<{
  version: 1;
  id: string;
  notebookId: string;
  sessionId: string;
  imageBlockId: string;
  transcriptBlockId: string;
  status: SessionRecognitionStatus;
  attempts: number;
  providerName?: string;
  error?: string;
  failureKind?: SessionRecognitionFailureKind;
  batchId?: string;
  pageNumber?: number;
  pageCount?: number;
  batchConcurrency?: number;
  warnings?: string[];
  timing?: SessionRecognitionTiming;
  createdAt: string;
  updatedAt: string;
}>;

export type PreparePdfRecognitionBatchInput = Readonly<{
  notebookId: string;
  sessionId: string;
  pdfBlockId: string;
  pdfAssetPath: string;
  batchId: string;
  pageCount: number;
  concurrency: number;
  baseRevision: string;
  pages: ReadonlyArray<Readonly<{
    pageNumber: number;
    imageAssetPath: string;
  }>>;
}>;

export type SessionRecognitionEvent = Readonly<{
  version: 1;
  sequence: number;
  taskId: string;
  type: "status" | "stdout" | "stderr" | "warning" | "preview";
  message: string;
  delta?: string;
  task: SessionRecognitionTask;
}>;

type StoredTask = SessionRecognitionTask & Readonly<{
  assetPath: string;
  imagePath: string;
  recognitionContext?: string;
  recognitionContextFingerprint?: string;
  executionId?: string;
  previousTranscriptMarkdown?: string;
}>;

export class SessionRecognitionError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "invalid_session"
      | "path_outside_session"
      | "block_not_found"
      | "block_locked"
      | "asset_not_found"
      | "not_image_block"
      | "not_pdf_block"
      | "revision_conflict"
      | "invalid_pdf_batch"
      | "recognition_in_progress"
      | "task_not_found"
      | "task_not_retryable"
      | "task_not_cancellable"
      | "provider_unavailable",
    readonly statusCode: number,
    readonly taskId?: string
  ) {
    super(code);
    this.name = "SessionRecognitionError";
  }
}

export class SessionRecognitionService {
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly events = new Map<string, SessionRecognitionEvent[]>();
  private readonly subscribers = new Map<string, Set<(event: SessionRecognitionEvent) => void>>();
  private readonly sessionSubscribers = new Map<string, Set<(sequence: number) => void>>();
  private readonly sessionSequences = new Map<string, number>();
  private sequence = 0;

  constructor(
    private readonly rootDir: string,
    private readonly createProvider: () => Promise<RecognitionProvider>,
    private readonly coordinator = new SessionWriteCoordinator(),
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async start(input: { notebookId: string; sessionId: string; imageBlockId: string }): Promise<SessionRecognitionTask> {
    const task = await this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
      const existing = (await readTasks(context.sessionDir)).find(
        (candidate) => candidate.imageBlockId === input.imageBlockId &&
          (candidate.status === "pending" || candidate.status === "running")
      );
      if (existing) throw new SessionRecognitionError("recognition_in_progress", 409, existing.id);
      const imageBlock = context.session.blocks.find((block) => block.id === input.imageBlockId);
      if (!imageBlock) throw new SessionRecognitionError("block_not_found", 404);
      if (imageBlock.type !== "image") throw new SessionRecognitionError("not_image_block", 422);
      const imagePath = resolve(context.sessionDir, imageBlock.path);
      assertInside(context.sessionDir, imagePath);
      try {
        const imageStat = await stat(imagePath);
        if (!imageStat.isFile()) throw new SessionRecognitionError("asset_not_found", 404);
      } catch (error) {
        if (error instanceof SessionRecognitionError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new SessionRecognitionError("asset_not_found", 404);
        }
        throw error;
      }

      const timestamp = this.now();
      const recognitionContext = await buildSessionRecognitionContext({
        sessionDir: context.sessionDir,
        session: context.session,
        beforeBlockId: imageBlock.id,
        now: timestamp
      });
      const transcriptId = nextBlockId(context.session);
      const transcriptPath = `blocks/${transcriptId}_ai_transcript.md`;
      const transcriptAbsolutePath = resolve(context.sessionDir, transcriptPath);
      const transcript = createBlockRef({
        id: transcriptId,
        type: "markdown",
        path: transcriptPath,
        source: "ai_transcription",
        fromAssets: [imageBlock.path],
        createdAt: timestamp
      });
      const imageIndex = context.session.blocks.findIndex((block) => block.id === imageBlock.id);
      const nextSession: SessionRecord = {
        ...context.session,
        updatedAt: timestamp,
        blocks: [...context.session.blocks.slice(0, imageIndex + 1), transcript, ...context.session.blocks.slice(imageIndex + 1)]
      };
      const task: StoredTask = {
        version: 1,
        id: `recognition_${randomUUID()}`,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        imageBlockId: imageBlock.id,
        transcriptBlockId: transcript.id,
        assetPath: imageBlock.path,
        imagePath,
        recognitionContext: recognitionContext.summary || undefined,
        recognitionContextFingerprint: recognitionContext.fingerprint,
        status: "pending",
        attempts: 0,
        timing: { acceptedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const previousSessionText = await readFile(context.sessionPath, "utf8");
      await writeAtomically(transcriptAbsolutePath, initialDraft());
      try {
        await writeAtomically(context.sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
        await upsertTask(context.sessionDir, task);
      } catch (error) {
        await writeAtomically(context.sessionPath, previousSessionText).catch(() => undefined);
        await rm(transcriptAbsolutePath, { force: true });
        throw error;
      }
      return task;
    });
    this.emit(task, "status", "识别任务已排队。");
    this.scheduleRun(task);
    return publicTask(task);
  }

  async preparePdfBatch(input: PreparePdfRecognitionBatchInput): Promise<SessionRecognitionTask[]> {
    const prepared = await this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
      if (input.baseRevision !== sessionManifestRevision(context.session)) {
        throw new SessionRecognitionError("revision_conflict", 409);
      }
      if (!isSafeBatchId(input.batchId) || !Number.isInteger(input.pageCount) || input.pageCount < 1 ||
          !Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4 ||
          input.pages.length === 0) {
        throw new SessionRecognitionError("invalid_pdf_batch", 400);
      }
      const pdfBlock = context.session.blocks.find((block) => block.id === input.pdfBlockId);
      if (!pdfBlock) throw new SessionRecognitionError("block_not_found", 404);
      if (pdfBlock.type !== "pdf") throw new SessionRecognitionError("not_pdf_block", 422);
      if (normalizeRelativePath(pdfBlock.path) !== normalizeRelativePath(input.pdfAssetPath) ||
          (pdfBlock.pageCount !== undefined && pdfBlock.pageCount !== input.pageCount)) {
        throw new SessionRecognitionError("invalid_pdf_batch", 409);
      }

      const existingTasks = await readTasks(context.sessionDir);
      if (existingTasks.some((task) => task.batchId === input.batchId)) {
        throw new SessionRecognitionError("recognition_in_progress", 409);
      }
      const pages = [...input.pages].sort((left, right) => left.pageNumber - right.pageNumber);
      const seenPages = new Set<number>();
      for (const page of pages) {
        if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > input.pageCount ||
            seenPages.has(page.pageNumber)) {
          throw new SessionRecognitionError("invalid_pdf_batch", 400);
        }
        seenPages.add(page.pageNumber);
        const imagePath = assertInside(context.sessionDir, resolve(context.sessionDir, page.imageAssetPath));
        const imageStat = await stat(imagePath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new SessionRecognitionError("asset_not_found", 404);
          }
          throw error;
        });
        if (!imageStat.isFile()) throw new SessionRecognitionError("asset_not_found", 404);
      }

      const timestamp = this.now();
      const recognitionContext = await buildSessionRecognitionContext({
        sessionDir: context.sessionDir,
        session: context.session,
        beforeBlockId: pdfBlock.id,
        now: timestamp
      });
      const firstNumericId = maxNumericBlockId(context.session) + 1;
      const transcripts = pages.map((page, index) => {
        const id = String(firstNumericId + index).padStart(4, "0");
        return createBlockRef({
          id,
          type: "markdown",
          path: `blocks/${id}_ai_transcript.md`,
          source: "ai_transcription",
          sourceName: `PDF 第 ${page.pageNumber} 页`,
          fromAssets: [pdfBlock.path],
          sourcePageNumber: page.pageNumber,
          sourcePageImagePath: normalizeRelativePath(page.imageAssetPath),
          createdAt: timestamp
        });
      });
      const tasks: StoredTask[] = pages.map((page, index) => ({
        version: 1,
        id: `recognition_${input.batchId}_page_${String(page.pageNumber).padStart(4, "0")}`,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        imageBlockId: pdfBlock.id,
        transcriptBlockId: transcripts[index].id,
        assetPath: pdfBlock.path,
        imagePath: assertInside(context.sessionDir, resolve(context.sessionDir, page.imageAssetPath)),
        recognitionContext: recognitionContext.summary || undefined,
        recognitionContextFingerprint: recognitionContext.fingerprint,
        batchId: input.batchId,
        pageNumber: page.pageNumber,
        pageCount: input.pageCount,
        batchConcurrency: input.concurrency,
        status: "pending",
        attempts: 0,
        timing: { acceptedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp
      }));
      const pdfIndex = context.session.blocks.findIndex((block) => block.id === pdfBlock.id);
      const nextSession: SessionRecord = {
        ...context.session,
        updatedAt: timestamp,
        blocks: [
          ...context.session.blocks.slice(0, pdfIndex + 1),
          ...transcripts,
          ...context.session.blocks.slice(pdfIndex + 1)
        ]
      };
      const previousSessionText = await readFile(context.sessionPath, "utf8");
      const previousTaskText = await readOptionalText(taskLogPath(context.sessionDir));
      const createdTranscriptPaths: string[] = [];
      try {
        for (let index = 0; index < transcripts.length; index += 1) {
          const path = assertInside(context.sessionDir, resolve(context.sessionDir, transcripts[index].path));
          await writeAtomically(path, initialDraft(pages[index].pageNumber));
          createdTranscriptPaths.push(path);
        }
        await writeAtomically(context.sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
        await writeTasks(context.sessionDir, [...existingTasks, ...tasks]);
      } catch (error) {
        await writeAtomically(context.sessionPath, previousSessionText).catch(() => undefined);
        if (previousTaskText === undefined) await rm(taskLogPath(context.sessionDir), { force: true });
        else await writeAtomically(taskLogPath(context.sessionDir), previousTaskText).catch(() => undefined);
        await Promise.all(createdTranscriptPaths.map((path) => rm(path, { force: true })));
        throw error;
      }
      return tasks;
    });
    for (const task of prepared) this.emit(task, "status", `PDF 第 ${task.pageNumber} 页已进入识别队列。`);
    return prepared.map(publicTask);
  }

  async runPrepared(input: {
    notebookId: string;
    sessionId: string;
    taskId: string;
  }): Promise<SessionRecognitionTask> {
    const task = await this.requireTask(input);
    if (task.status !== "pending") return publicTask(task);
    await this.trackRun(task);
    return this.get(input);
  }

  async prepareRetry(input: {
    notebookId: string;
    sessionId: string;
    taskId: string;
  }): Promise<SessionRecognitionTask> {
    const task = await this.requireTask(input);
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new SessionRecognitionError("task_not_retryable", 409, task.id);
    }
    await this.waitForRun(task.id, 1_000);
    await this.assertTranscriptWritable(task);
    const pending = await this.updateTask(task, {
      status: "pending",
      error: undefined,
      failureKind: undefined,
      warnings: undefined,
      executionId: undefined,
      timing: { acceptedAt: this.now() }
    });
    try {
      await this.writeTranscript(pending, initialDraft(pending.pageNumber));
    } catch (error) {
      await this.updateTask(pending, {
        status: task.status,
        error: task.error,
        failureKind: task.failureKind,
        warnings: task.warnings,
        executionId: task.executionId,
        timing: task.timing
      });
      throw error;
    }
    this.emit(pending, "status", pending.pageNumber
      ? `PDF 第 ${pending.pageNumber} 页已重新排队。`
      : "识别任务已重新排队。");
    return publicTask(pending);
  }

  async get(input: { notebookId: string; sessionId: string; taskId: string }): Promise<SessionRecognitionTask> {
    const task = await this.requireTask(input);
    return publicTask(await this.recoverOrphan(task));
  }

  async list(input: { notebookId: string; sessionId: string }): Promise<SessionRecognitionTask[]> {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const tasks = await Promise.all(
      (await readTasks(context.sessionDir)).map((task) => this.recoverOrphan(task))
    );
    return tasks
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(publicTask);
  }

  async latest(input: { notebookId: string; sessionId: string; imageBlockId: string }): Promise<SessionRecognitionTask | undefined> {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const tasks = await readTasks(context.sessionDir);
    const match = [...tasks].reverse().find((task) => task.imageBlockId === input.imageBlockId);
    return match ? publicTask(await this.recoverOrphan(match)) : undefined;
  }

  async latestForTranscript(input: {
    notebookId: string;
    sessionId: string;
    transcriptBlockId: string;
  }): Promise<SessionRecognitionTask | undefined> {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const tasks = await readTasks(context.sessionDir);
    const match = [...tasks].reverse().find((task) => task.transcriptBlockId === input.transcriptBlockId);
    return match ? publicTask(await this.recoverOrphan(match)) : undefined;
  }

  async cancel(input: { notebookId: string; sessionId: string; taskId: string }): Promise<SessionRecognitionTask> {
    const task = await this.requireTask(input);
    if (task.status !== "pending" && task.status !== "running") {
      throw new SessionRecognitionError("task_not_cancellable", 409, task.id);
    }
    this.abortControllers.get(task.id)?.abort(new Error("User cancelled recognition"));
    const cancelled = await this.updateTask(task, {
      status: "cancelled",
      error: "用户已中断识别。"
    });
    await this.writeTranscript(
      cancelled,
      task.previousTranscriptMarkdown ?? cancelledDraft(cancelled.providerName)
    ).catch((error) => {
      if (!(error instanceof SessionRecognitionError) || error.code !== "block_locked") throw error;
    });
    this.emit(cancelled, "status", "识别已中断。");
    await this.waitForRun(task.id, 500);
    return publicTask(cancelled);
  }

  async retry(input: { notebookId: string; sessionId: string; taskId: string }): Promise<SessionRecognitionTask> {
    const pending = await this.prepareRetry(input);
    this.scheduleRun(await this.requireTask(input));
    return pending;
  }

  async rerun(input: {
    notebookId: string;
    sessionId: string;
    transcriptBlockId: string;
  }): Promise<SessionRecognitionTask> {
    const pending = await this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
      const tasks = await readTasks(context.sessionDir);
      const task = [...tasks].reverse().find(
        (candidate) => candidate.transcriptBlockId === input.transcriptBlockId
      );
      if (!task) throw new SessionRecognitionError("task_not_found", 404);
      if (task.status === "pending" || task.status === "running") {
        throw new SessionRecognitionError("recognition_in_progress", 409, task.id);
      }
      const transcriptBlock = context.session.blocks.find(
        (candidate) => candidate.id === task.transcriptBlockId
      );
      if (!transcriptBlock || transcriptBlock.type !== "markdown" || transcriptBlock.source !== "ai_transcription") {
        throw new SessionRecognitionError("block_not_found", 404, task.id);
      }
      if (isBlockProtected(context.session, transcriptBlock.id)) {
        throw new SessionRecognitionError("block_locked", 423, task.id);
      }
      const transcriptPath = resolve(context.sessionDir, transcriptBlock.path);
      assertInside(context.sessionDir, transcriptPath);
      const updated: StoredTask = {
        ...task,
        status: "pending",
        error: undefined,
        failureKind: undefined,
        warnings: undefined,
        executionId: undefined,
        previousTranscriptMarkdown: await readFile(transcriptPath, "utf8"),
        timing: { acceptedAt: this.now() },
        updatedAt: this.now()
      };
      await upsertTask(context.sessionDir, updated);
      return updated;
    });
    this.emit(pending, "status", "已保留当前转写，重新识别任务正在排队。");
    this.scheduleRun(pending);
    return publicTask(pending);
  }

  eventsAfter(taskId: string, afterSequence = 0): SessionRecognitionEvent[] {
    return (this.events.get(taskId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  subscribe(taskId: string, listener: (event: SessionRecognitionEvent) => void): () => void {
    const listeners = this.subscribers.get(taskId) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(taskId);
    };
  }

  private scheduleRun(task: StoredTask): void {
    void this.trackRun(task).catch(() => undefined);
  }

  private trackRun(task: StoredTask): Promise<void> {
    const existing = this.activeRuns.get(task.id);
    if (existing) return existing;
    const running = this.run(task);
    this.activeRuns.set(task.id, running);
    void running.then(
      () => { if (this.activeRuns.get(task.id) === running) this.activeRuns.delete(task.id); },
      (error) => {
        if (this.activeRuns.get(task.id) === running) this.activeRuns.delete(task.id);
        this.emit(task, "stderr", error instanceof Error ? error.message : "识别任务异常退出。");
      }
    );
    return running;
  }

  private async waitForRun(taskId: string, timeoutMs: number): Promise<void> {
    const running = this.activeRuns.get(taskId);
    if (!running) return;
    await Promise.race([
      running.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  private async run(initial: StoredTask): Promise<void> {
    let task = await this.requireTask({
      notebookId: initial.notebookId,
      sessionId: initial.sessionId,
      taskId: initial.id
    });
    if (task.status !== "pending") return;
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);
    const guard = new StreamingOutputGuard();
    let markdown = "";
    let anomaly: { detail: string; safeText: string } | undefined;
    let anomalyWarningEmitted = false;
    let writeChain = Promise.resolve();
    let pendingDraft: string | undefined;
    let draftTimer: ReturnType<typeof setTimeout> | undefined;
    let firstOutputAt: string | undefined;
    let draftWriteError: unknown;
    const persistPendingDraft = () => {
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = undefined;
      }
      const next = pendingDraft;
      pendingDraft = undefined;
      if (next !== undefined) {
        writeChain = writeChain.then(() => this.writeTranscript(task, next));
      }
      return writeChain;
    };
    const scheduleDraft = (next: string) => {
      pendingDraft = next;
      if (draftTimer) return;
      draftTimer = setTimeout(() => {
        draftTimer = undefined;
        void persistPendingDraft().catch((error) => {
          draftWriteError ??= error;
          controller.abort(error);
        });
      }, 80);
    };
    try {
      let provider: RecognitionProvider;
      try {
        provider = await this.createProvider();
      } catch (error) {
        throw new SessionRecognitionError("provider_unavailable", 503, task.id);
      }
      const running = await this.transitionPendingTask(task, {
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
      this.emit(task, "status", `识别服务已启动：${provider.name}。`);
      const onEvent = (event: RecognitionProviderEvent) => {
        if (event.type === "stdout") {
          if (!firstOutputAt && event.text.length > 0) firstOutputAt = this.now();
          const observed = guard.observe(event.text);
          markdown = observed.state === "tripped" ? observed.safeText : observed.text;
          this.emit(task, "stdout", "识别内容正在生成。", event.text);
          scheduleDraft(markdown || initialDraft());
          if (observed.state === "suspicious" && !anomalyWarningEmitted) {
            anomalyWarningEmitted = true;
            this.emit(task, "warning", "检测到疑似重复输出；继续异常将自动停止。");
          }
          if (observed.state === "tripped" && !anomaly) {
            anomaly = { detail: observed.message ?? "检测到持续异常输出。", safeText: observed.safeText };
            controller.abort(new Error("Recognition output anomaly"));
          }
        } else if (event.type === "stderr") {
          this.emit(task, "stderr", event.text);
        } else {
          this.emit(task, "status", event.message);
        }
      };
      const input = {
        imagePaths: [task.imagePath],
        mode: "faithful" as const,
        outputFormat: "markdown" as const,
        sessionId: task.sessionId,
        context: task.recognitionContext,
        abortSignal: controller.signal
      };
      const result = provider.transcribeWithEvents
        ? await provider.transcribeWithEvents({ ...input, onEvent })
        : await provider.transcribe(input);
      if (anomaly) throw new Error("Recognition output anomaly");
      await persistPendingDraft();
      if (draftWriteError) throw draftWriteError;
      await this.writeTranscript(task, result.markdown);
      const completedAt = this.now();
      const succeeded = await this.transitionTask(task, ["running"], {
        status: "succeeded",
        warnings: result.warnings,
        error: undefined,
        previousTranscriptMarkdown: undefined,
        timing: completedTiming(task, completedAt, firstOutputAt)
      });
      if (!succeeded) return;
      task = succeeded;
      this.emit(task, "preview", "Markdown 草稿已生成。");
      this.emit(task, "status", "识别完成。");
    } catch (error) {
      await persistPendingDraft().catch(() => undefined);
      const current = await this.requireTask({
        notebookId: task.notebookId,
        sessionId: task.sessionId,
        taskId: task.id
      });
      if (current.executionId !== task.executionId) return;
      if (current.status === "cancelled") return;
      const effectiveError = draftWriteError ?? error;
      const cancelled = controller.signal.aborted && !anomaly;
      const providerUnavailable = effectiveError instanceof SessionRecognitionError && effectiveError.code === "provider_unavailable";
      const blockLocked = effectiveError instanceof SessionRecognitionError && effectiveError.code === "block_locked";
      const message = anomaly?.detail
        ?? (providerUnavailable
          ? "识别服务尚未配置或未能恢复，请在设置中保存并测试识别服务。"
          : blockLocked ? "内容已锁定，识别没有继续写入。" : effectiveError instanceof Error ? effectiveError.message : "识别失败");
      const status: SessionRecognitionStatus = cancelled && !blockLocked ? "cancelled" : "failed";
      const completedAt = this.now();
      const restoredMarkdown = current.previousTranscriptMarkdown;
      if (!blockLocked) {
        await this.writeTranscript(current, restoredMarkdown ?? (anomaly
          ? anomalyDraft(anomaly.safeText, current.providerName, message)
          : cancelled ? cancelledDraft(current.providerName) : failureDraft(current.providerName, message)));
      }
      task = await this.updateTask(current, {
        status,
        error: cancelled && !blockLocked ? "用户已中断识别。" : message,
        failureKind: anomaly ? "output_anomaly" : providerUnavailable ? "provider_unavailable" : undefined,
        previousTranscriptMarkdown: undefined,
        timing: completedTiming(current, completedAt, firstOutputAt)
      });
      this.emit(
        task,
        anomaly ? "warning" : "status",
        restoredMarkdown
          ? "重新识别未完成，已恢复原转写。"
          : anomaly ? "异常输出已停止。" : status === "cancelled" ? "识别已中断。" : message
      );
    } finally {
      if (draftTimer) clearTimeout(draftTimer);
      if (this.abortControllers.get(task.id) === controller) {
        this.abortControllers.delete(task.id);
      }
    }
  }

  private async requireTask(input: { notebookId: string; sessionId: string; taskId: string }): Promise<StoredTask> {
    const context = await readSessionContext(this.rootDir, input.notebookId, input.sessionId);
    const task = (await readTasks(context.sessionDir)).find((candidate) => candidate.id === input.taskId);
    if (!task) throw new SessionRecognitionError("task_not_found", 404);
    return task;
  }

  private async recoverOrphan(task: StoredTask): Promise<StoredTask> {
    if (task.status !== "running" || this.abortControllers.has(task.id)) return task;
    return this.coordinator.run(task.notebookId, task.sessionId, async () => {
      // A stale poll must not restore an older transcript over a completed run.
      task = await this.requireTask({ notebookId: task.notebookId, sessionId: task.sessionId, taskId: task.id });
      if (task.status !== "running" || this.abortControllers.has(task.id) || this.activeRuns.has(task.id)) return task;
      let restoredPrevious = false;
      if (task.previousTranscriptMarkdown !== undefined) {
        try {
          await this.writeTranscriptWithinBarrier(task, task.previousTranscriptMarkdown);
          restoredPrevious = true;
        } catch (error) {
          if (!(error instanceof SessionRecognitionError) || error.code !== "block_locked") throw error;
        }
      }
      const updated: StoredTask = {
        ...task,
        updatedAt: this.now(),
        status: "failed",
        error: task.previousTranscriptMarkdown !== undefined
          ? restoredPrevious
            ? "上次重新识别被中断，已恢复原转写。"
            : "上次重新识别被中断；内容已锁定，未改动当前笔记。"
          : "上次识别运行被中断，请重试。",
        previousTranscriptMarkdown: undefined
      };
      const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
      await upsertTask(context.sessionDir, updated);
      return updated;
    });
  }

  activitySequence(input: { notebookId: string; sessionId: string }): number {
    return this.sessionSequences.get(sessionActivityKey(input.notebookId, input.sessionId)) ?? 0;
  }

  async waitForActivity(input: {
    notebookId: string;
    sessionId: string;
    afterSequence: number;
    timeoutMs: number;
  }): Promise<number> {
    const current = this.activitySequence(input);
    if (current > input.afterSequence || input.timeoutMs <= 0) return current;
    const key = sessionActivityKey(input.notebookId, input.sessionId);
    return await new Promise<number>((resolve) => {
      const listeners = this.sessionSubscribers.get(key) ?? new Set<(sequence: number) => void>();
      let settled = false;
      const finish = (sequence: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(listener);
        if (listeners.size === 0) this.sessionSubscribers.delete(key);
        resolve(sequence);
      };
      const listener = (sequence: number) => finish(sequence);
      listeners.add(listener);
      this.sessionSubscribers.set(key, listeners);
      const timer = setTimeout(() => finish(this.activitySequence(input)), Math.min(input.timeoutMs, 30_000));
    });
  }

  private async updateTask(task: StoredTask, changes: Partial<StoredTask>): Promise<StoredTask> {
    return this.coordinator.run(task.notebookId, task.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
      const current = (await readTasks(context.sessionDir)).find((candidate) => candidate.id === task.id);
      if (!current) throw new SessionRecognitionError("task_not_found", 404, task.id);
      const updated: StoredTask = { ...current, ...changes, updatedAt: this.now() };
      await upsertTask(context.sessionDir, updated);
      return updated;
    });
  }

  private async assertTranscriptWritable(task: StoredTask): Promise<void> {
    const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
    const block = context.session.blocks.find((candidate) => candidate.id === task.transcriptBlockId);
    if (!block || block.type !== "markdown" || block.source !== "ai_transcription") {
      throw new SessionRecognitionError("block_not_found", 404, task.id);
    }
    if (isBlockProtected(context.session, block.id)) {
      throw new SessionRecognitionError("block_locked", 423, task.id);
    }
  }

  private transitionPendingTask(task: StoredTask, changes: Partial<StoredTask>): Promise<StoredTask | undefined> {
    return this.transitionTask(task, ["pending"], changes);
  }

  private transitionTask(
    task: StoredTask,
    expected: readonly SessionRecognitionStatus[],
    changes: Partial<StoredTask>
  ): Promise<StoredTask | undefined> {
    return this.coordinator.run(task.notebookId, task.sessionId, async () => {
      const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
      const current = (await readTasks(context.sessionDir)).find((candidate) => candidate.id === task.id);
      if (!current) throw new SessionRecognitionError("task_not_found", 404, task.id);
      if (!expected.includes(current.status)) return undefined;
      const updated: StoredTask = { ...current, ...changes, updatedAt: this.now() };
      await upsertTask(context.sessionDir, updated);
      return updated;
    });
  }

  private writeTranscript(task: StoredTask, markdown: string): Promise<void> {
    return this.coordinator.run(task.notebookId, task.sessionId, () => this.writeTranscriptWithinBarrier(task, markdown));
  }

  private async writeTranscriptWithinBarrier(task: StoredTask, markdown: string): Promise<void> {
    const context = await readSessionContext(this.rootDir, task.notebookId, task.sessionId);
    const block = context.session.blocks.find((candidate) => candidate.id === task.transcriptBlockId);
    if (!block || block.type !== "markdown" || block.source !== "ai_transcription") {
      throw new SessionRecognitionError("block_not_found", 404, task.id);
    }
    if (isBlockProtected(context.session, block.id)) {
      throw new SessionRecognitionError("block_locked", 423, task.id);
    }
    const timestamp = this.now();
    const blockPath = resolve(context.sessionDir, block.path);
    const beforeMarkdown = await readFile(blockPath, "utf8");
    await writeAtomically(blockPath, bindSourceImageMarkers(markdown, task.assetPath));
    block.updatedAt = timestamp;
    context.session.updatedAt = timestamp;
    try {
      await writeAtomically(context.sessionPath, `${JSON.stringify(context.session, null, 2)}\n`);
    } catch (error) {
      await writeAtomically(blockPath, beforeMarkdown);
      throw error;
    }
    this.emit(task, "preview", "草稿已更新。");
  }

  private emit(task: StoredTask, type: SessionRecognitionEvent["type"], message: string, delta?: string): void {
    const event: SessionRecognitionEvent = {
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
    const sessionKey = sessionActivityKey(task.notebookId, task.sessionId);
    this.sessionSequences.set(sessionKey, event.sequence);
    for (const listener of this.sessionSubscribers.get(sessionKey) ?? []) listener(event.sequence);
  }
}

function sessionActivityKey(notebookId: string, sessionId: string): string {
  return `${notebookId}\u0000${sessionId}`;
}

function publicTask(task: StoredTask): SessionRecognitionTask {
  return {
    version: task.version,
    id: task.id,
    notebookId: task.notebookId,
    sessionId: task.sessionId,
    imageBlockId: task.imageBlockId,
    transcriptBlockId: task.transcriptBlockId,
    status: task.status,
    attempts: task.attempts,
    providerName: task.providerName,
    error: task.error,
    failureKind: task.failureKind,
    batchId: task.batchId,
    pageNumber: task.pageNumber,
    pageCount: task.pageCount,
    batchConcurrency: task.batchConcurrency,
    warnings: task.warnings,
    timing: task.timing,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function completedTiming(
  task: StoredTask,
  completedAt: string,
  firstOutputAt?: string
): SessionRecognitionTiming {
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

async function readSessionContext(rootDir: string, notebookId: string, sessionId: string) {
  const notebooksDir = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
  assertInside(notebooksDir, sessionDir);
  const sessionPath = resolve(sessionDir, "session.json");
  try {
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks) || !Array.isArray(session.locks)) {
      throw new SessionRecognitionError("invalid_session", 422);
    }
    return { session, sessionDir, sessionPath };
  } catch (error) {
    if (error instanceof SessionRecognitionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionRecognitionError("session_not_found", 404);
    if (error instanceof SyntaxError) throw new SessionRecognitionError("invalid_session", 422);
    throw error;
  }
}

function nextBlockId(session: SessionRecord): string {
  return String(maxNumericBlockId(session) + 1).padStart(4, "0");
}

function isBlockProtected(session: SessionRecord, blockId: string): boolean {
  return session.blocks.some((block) => block.id === blockId && block.status === "locked") ||
    session.locks.some((lock) => lock.blockId === blockId && lock.aiEditable === false);
}

function maxNumericBlockId(session: SessionRecord): number {
  return session.blocks.reduce((current, block) => {
    const value = Number.parseInt(block.id, 10);
    return Number.isFinite(value) ? Math.max(current, value) : current;
  }, 0);
}

function assertInside(root: string, target: string): string {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new SessionRecognitionError("path_outside_session", 400);
  }
  return normalizedTarget;
}

async function readTasks(sessionDir: string): Promise<StoredTask[]> {
  try {
    const parsed = JSON.parse(await readFile(taskLogPath(sessionDir), "utf8")) as StoredTask[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function upsertTask(sessionDir: string, task: StoredTask): Promise<void> {
  const tasks = await readTasks(sessionDir);
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index >= 0) tasks[index] = task;
  else tasks.push(task);
  await writeTasks(sessionDir, tasks);
}

async function writeTasks(sessionDir: string, tasks: readonly StoredTask[]): Promise<void> {
  await writeAtomically(taskLogPath(sessionDir), `${JSON.stringify(tasks, null, 2)}\n`);
}

function taskLogPath(sessionDir: string): string {
  return resolve(sessionDir, "logs", "session_recognition_jobs.json");
}

async function writeAtomically(target: string, content: string | Buffer): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temp, content);
    await renameWithTransientRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
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

function initialDraft(pageNumber?: number): string {
  return pageNumber
    ? `#### PDF 第 ${pageNumber} 页正在识别\n\n识别服务正在准备。`
    : "#### 正在识别\n\n识别服务正在准备。";
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSafeBatchId(value: string): boolean {
  return /^pdf_[a-zA-Z0-9_-]{1,120}$/.test(value);
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function cancelledDraft(provider?: string): string {
  return `#### 识别已中断${provider ? `（${provider}）` : ""}\n\n用户已中断当前识别，可以稍后重试。`;
}

function failureDraft(provider: string | undefined, message: string): string {
  return `#### 识别失败${provider ? `（${provider}）` : ""}\n\n${message}\n\n请检查识别服务后重试。`;
}

function anomalyDraft(safeText: string, provider: string | undefined, message: string): string {
  const diagnostic = `#### 异常输出已停止${provider ? `（${provider}）` : ""}\n\n${message}\n\n已丢弃异常重复尾部，可以重试。`;
  return safeText.trim() ? `${safeText.trim()}\n\n---\n\n${diagnostic}` : diagnostic;
}

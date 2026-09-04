import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { SessionRecord } from "@mathnotes/shared";
import { MAX_LOCAL_IMAGE_BYTES } from "./sessionImageImportService";
import {
  SessionRecognitionService,
  type SessionRecognitionTask
} from "./sessionRecognitionService";
import { sessionManifestRevision } from "./sessionRevision";

export type StagePdfRecognitionPageInput = Readonly<{
  notebookId: string;
  sessionId: string;
  pdfBlockId: string;
  pageNumber: number;
  baseRevision: string;
  bytes: Buffer;
}>;

export type StagedPdfRecognitionPage = Readonly<{
  version: 1;
  pageNumber: number;
  assetPath: string;
  byteLength: number;
  sha256: string;
}>;

export type StartPdfRecognitionBatchInput = Readonly<{
  notebookId: string;
  sessionId: string;
  pdfBlockId: string;
  pdfAssetPath: string;
  pageCount: number;
  concurrency: number;
  baseRevision: string;
  pages: ReadonlyArray<Readonly<{
    pageNumber: number;
    assetPath: string;
  }>>;
}>;

export type PdfRecognitionBatchStatus = "running" | "pausing" | "paused" | "completed" | "cancelled";

export type PdfRecognitionBatch = Readonly<{
  version: 1;
  batchId: string;
  notebookId: string;
  sessionId: string;
  pdfBlockId: string;
  pageCount: number;
  selectedPages: readonly number[];
  taskIds: readonly string[];
  status: PdfRecognitionBatchStatus;
  concurrency: number;
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  createdAt: string;
  updatedAt: string;
}>;

export class SessionPdfRecognitionBatchError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "session_not_found"
      | "invalid_session"
      | "revision_conflict"
      | "block_not_found"
      | "not_pdf_block"
      | "page_out_of_range"
      | "unsupported_image"
      | "image_too_large"
      | "path_outside_session"
      | "batch_not_found"
      | "batch_not_running"
      | "batch_not_resumable",
    readonly statusCode: number
  ) {
    super(code);
    this.name = "SessionPdfRecognitionBatchError";
  }
}

type BatchRuntime = {
  batchId: string;
  notebookId: string;
  sessionId: string;
  status: "running" | "pausing" | "paused" | "cancelled";
  pauseRequested: boolean;
  cancelRequested: boolean;
  currentConcurrency: number;
  maxConcurrency: number;
  consecutiveSuccesses: number;
  activeTaskIds: Set<string>;
};

export class SessionPdfRecognitionBatchService {
  private readonly runtimes = new Map<string, BatchRuntime>();

  constructor(
    private readonly rootDir: string,
    private readonly recognition: SessionRecognitionService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly retryDelayMs = 750
  ) {}

  async stagePage(input: StagePdfRecognitionPageInput): Promise<StagedPdfRecognitionPage> {
    if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1 || input.bytes.byteLength === 0) {
      throw new SessionPdfRecognitionBatchError("invalid_input", 400);
    }
    if (input.bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) {
      throw new SessionPdfRecognitionBatchError("image_too_large", 413);
    }
    if (!isPng(input.bytes)) throw new SessionPdfRecognitionBatchError("unsupported_image", 415);
    const context = await readSession(this.rootDir, input.notebookId, input.sessionId);
    if (input.baseRevision !== sessionManifestRevision(context.session)) {
      throw new SessionPdfRecognitionBatchError("revision_conflict", 409);
    }
    const pdfBlock = context.session.blocks.find((block) => block.id === input.pdfBlockId);
    if (!pdfBlock) throw new SessionPdfRecognitionBatchError("block_not_found", 404);
    if (pdfBlock.type !== "pdf") throw new SessionPdfRecognitionBatchError("not_pdf_block", 422);
    if (pdfBlock.pageCount && input.pageNumber > pdfBlock.pageCount) {
      throw new SessionPdfRecognitionBatchError("page_out_of_range", 400);
    }

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const relativePath = `assets/pdf-pages/${input.pdfBlockId}/page-${String(input.pageNumber).padStart(4, "0")}-${sha256.slice(0, 12)}.png`;
    const target = assertInside(resolve(context.sessionDir, "assets"), resolve(context.sessionDir, relativePath));
    if (!await exists(target)) await writeAtomically(target, input.bytes);
    return {
      version: 1,
      pageNumber: input.pageNumber,
      assetPath: relativePath,
      byteLength: input.bytes.byteLength,
      sha256
    };
  }

  async start(input: StartPdfRecognitionBatchInput): Promise<PdfRecognitionBatch> {
    if (!Number.isInteger(input.pageCount) || input.pageCount < 1 ||
        !Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4 ||
        input.pages.length === 0) {
      throw new SessionPdfRecognitionBatchError("invalid_input", 400);
    }
    const batchId = `pdf_${safeBatchPart(input.pdfBlockId)}_${compactTimestamp(this.now())}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const tasks = await this.recognition.preparePdfBatch({
      ...input,
      batchId,
      pages: input.pages.map((page) => ({ pageNumber: page.pageNumber, imageAssetPath: page.assetPath }))
    });
    this.launch(tasks);
    return this.summarize(tasks);
  }

  async list(input: { notebookId: string; sessionId: string }): Promise<PdfRecognitionBatch[]> {
    const tasks = await this.recognition.list(input);
    const grouped = new Map<string, SessionRecognitionTask[]>();
    for (const task of tasks) {
      if (!task.batchId) continue;
      const group = grouped.get(task.batchId) ?? [];
      group.push(task);
      grouped.set(task.batchId, group);
    }
    return [...grouped.values()]
      .map((group) => this.summarize(group))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(input: { notebookId: string; sessionId: string; batchId: string }): Promise<PdfRecognitionBatch> {
    return this.summarize(await this.requireBatchTasks(input));
  }

  async pause(input: { notebookId: string; sessionId: string; batchId: string }): Promise<PdfRecognitionBatch> {
    const runtime = this.runtimes.get(input.batchId);
    if (!runtime || runtime.notebookId !== input.notebookId || runtime.sessionId !== input.sessionId) {
      const batch = await this.get(input);
      if (batch.status === "paused") return batch;
      throw new SessionPdfRecognitionBatchError("batch_not_running", 409);
    }
    runtime.pauseRequested = true;
    runtime.status = "pausing";
    return this.get(input);
  }

  async resume(input: { notebookId: string; sessionId: string; batchId: string }): Promise<PdfRecognitionBatch> {
    const existing = this.runtimes.get(input.batchId);
    if (existing?.status === "running" || existing?.status === "pausing") return this.get(input);
    let tasks = await this.requireBatchTasks(input);
    for (const task of tasks) {
      if (task.status === "failed" && task.attempts < 2 && isTransientProviderFailure(task.error)) {
        await this.recognition.prepareRetry({ ...input, taskId: task.id });
      }
    }
    tasks = await this.requireBatchTasks(input);
    if (!tasks.some((task) => task.status === "pending")) {
      throw new SessionPdfRecognitionBatchError("batch_not_resumable", 409);
    }
    this.launch(tasks);
    return this.get(input);
  }

  async cancel(input: { notebookId: string; sessionId: string; batchId: string }): Promise<PdfRecognitionBatch> {
    const tasks = await this.requireBatchTasks(input);
    const runtime = this.runtimes.get(input.batchId);
    if (runtime) {
      runtime.cancelRequested = true;
      runtime.status = "cancelled";
    }
    await Promise.all(tasks
      .filter((task) => task.status === "pending" || task.status === "running")
      .map((task) => this.recognition.cancel({ ...input, taskId: task.id }).catch(() => undefined)));
    if (!runtime || runtime.activeTaskIds.size === 0) this.runtimes.delete(input.batchId);
    return this.get(input);
  }

  private launch(tasks: readonly SessionRecognitionTask[]): void {
    const first = tasks[0];
    if (!first?.batchId) throw new SessionPdfRecognitionBatchError("batch_not_found", 404);
    const existing = this.runtimes.get(first.batchId);
    if (existing?.status === "running" || existing?.status === "pausing") return;
    const initialConcurrency = clampConcurrency(first.batchConcurrency ?? 2);
    const runtime: BatchRuntime = existing ?? {
      batchId: first.batchId,
      notebookId: first.notebookId,
      sessionId: first.sessionId,
      status: "running",
      pauseRequested: false,
      cancelRequested: false,
      currentConcurrency: initialConcurrency,
      maxConcurrency: 4,
      consecutiveSuccesses: 0,
      activeTaskIds: new Set()
    };
    runtime.status = "running";
    runtime.pauseRequested = false;
    runtime.cancelRequested = false;
    this.runtimes.set(runtime.batchId, runtime);
    void this.run(runtime).catch(() => {
      runtime.pauseRequested = true;
      runtime.status = "paused";
    });
  }

  private async run(runtime: BatchRuntime): Promise<void> {
    const initialTasks = await this.requireBatchTasks(runtime);
    const pending = initialTasks.filter((task) => task.status === "pending").map((task) => task.id);
    const active = new Map<string, Promise<{
      taskId: string;
      task?: SessionRecognitionTask;
      error?: unknown;
    }>>();

    while (true) {
      if (runtime.cancelRequested && active.size === 0) {
        this.runtimes.delete(runtime.batchId);
        return;
      }
      if (runtime.pauseRequested && active.size === 0) {
        runtime.status = "paused";
        return;
      }
      while (!runtime.pauseRequested && !runtime.cancelRequested &&
             active.size < runtime.currentConcurrency && pending.length > 0) {
        const taskId = pending.shift()!;
        runtime.activeTaskIds.add(taskId);
        const execution = this.recognition.runPrepared({
          notebookId: runtime.notebookId,
          sessionId: runtime.sessionId,
          taskId
        }).then(
          (task) => ({ taskId, task }),
          (error) => ({ taskId, error })
        );
        active.set(taskId, execution);
      }
      if (active.size === 0) {
        this.runtimes.delete(runtime.batchId);
        return;
      }

      const settled = await Promise.race(active.values());
      active.delete(settled.taskId);
      runtime.activeTaskIds.delete(settled.taskId);
      if (settled.error) {
        runtime.pauseRequested = true;
        runtime.status = "pausing";
        continue;
      }
      const task = settled.task!;
      if (task.status === "succeeded") {
        runtime.consecutiveSuccesses += 1;
        if (runtime.consecutiveSuccesses >= 4 && runtime.currentConcurrency < runtime.maxConcurrency && pending.length > 0) {
          runtime.currentConcurrency += 1;
          runtime.consecutiveSuccesses = 0;
        }
      } else if (task.status === "failed" && task.attempts < 2 && isTransientProviderFailure(task.error) &&
                 !runtime.pauseRequested && !runtime.cancelRequested) {
        runtime.currentConcurrency = Math.max(1, Math.floor(runtime.currentConcurrency / 2));
        runtime.consecutiveSuccesses = 0;
        await delay(this.retryDelayMs);
        await this.recognition.prepareRetry({
          notebookId: runtime.notebookId,
          sessionId: runtime.sessionId,
          taskId: task.id
        });
        pending.push(task.id);
      }
    }
  }

  private async requireBatchTasks(input: {
    notebookId: string;
    sessionId: string;
    batchId: string;
  }): Promise<SessionRecognitionTask[]> {
    const tasks = (await this.recognition.list(input))
      .filter((task) => task.batchId === input.batchId)
      .sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0));
    if (tasks.length === 0) throw new SessionPdfRecognitionBatchError("batch_not_found", 404);
    return tasks;
  }

  private summarize(tasks: readonly SessionRecognitionTask[]): PdfRecognitionBatch {
    const first = tasks[0];
    if (!first?.batchId) throw new SessionPdfRecognitionBatchError("batch_not_found", 404);
    const counts = {
      running: tasks.filter((task) => task.status === "running").length,
      pending: tasks.filter((task) => task.status === "pending").length,
      succeeded: tasks.filter((task) => task.status === "succeeded").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      cancelled: tasks.filter((task) => task.status === "cancelled").length
    };
    const runtime = this.runtimes.get(first.batchId);
    const status: PdfRecognitionBatchStatus = runtime?.status ?? (
      counts.running > 0 ? "running" :
      counts.pending > 0 ? "paused" :
      counts.cancelled > 0 ? "cancelled" : "completed"
    );
    return {
      version: 1,
      batchId: first.batchId,
      notebookId: first.notebookId,
      sessionId: first.sessionId,
      pdfBlockId: first.imageBlockId,
      pageCount: first.pageCount ?? tasks.length,
      selectedPages: tasks.map((task) => task.pageNumber).filter((page): page is number => page !== undefined),
      taskIds: tasks.map((task) => task.id),
      status,
      concurrency: runtime?.currentConcurrency ?? first.batchConcurrency ?? 1,
      ...counts,
      createdAt: tasks.map((task) => task.createdAt).sort()[0],
      updatedAt: tasks.map((task) => task.updatedAt).sort().at(-1)!
    };
  }
}

export function isTransientProviderFailure(error?: string): boolean {
  return Boolean(error && /(429|rate.?limit|timed?\s*out|timeout|503|overloaded|disconnect|temporar|interrupt|限流|超时|暂时|中断)/i.test(error));
}

async function readSession(rootDir: string, notebookId: string, sessionId: string) {
  const notebooksDir = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
  assertInside(notebooksDir, sessionDir);
  const sessionPath = resolve(sessionDir, "session.json");
  try {
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks) || !Array.isArray(session.locks)) {
      throw new SessionPdfRecognitionBatchError("invalid_session", 422);
    }
    return { session, sessionDir };
  } catch (error) {
    if (error instanceof SessionPdfRecognitionBatchError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionPdfRecognitionBatchError("session_not_found", 404);
    }
    if (error instanceof SyntaxError) throw new SessionPdfRecognitionBatchError("invalid_session", 422);
    throw error;
  }
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function safeBatchPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  return safe || "pdf";
}

function compactTimestamp(value: string): string {
  return value.replace(/\D/g, "").slice(0, 17) || String(Date.now());
}

function clampConcurrency(value: number): number {
  return Math.min(4, Math.max(1, Math.floor(value)));
}

function assertInside(root: string, target: string): string {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new SessionPdfRecognitionBatchError("path_outside_session", 400);
  }
  return normalizedTarget;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomically(target: string, content: Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

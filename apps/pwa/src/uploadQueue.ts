import { CompanionApiError, type UploadMaterialResult } from "./apiClient";
import type { PairingTarget, UploadMaterialKind, UploadTask } from "./domain";
import { createClientId } from "./clientId";

export type UploadTaskRepository = Readonly<{
  loadUploadTask(id: string): Promise<UploadTask | undefined>;
  loadUploadTasks(profileId: string): Promise<UploadTask[]>;
  saveUploadTask(task: UploadTask): Promise<void>;
  deleteUploadTask(id: string): Promise<void>;
}>;

export type UploadTransport = Readonly<{
  upload(task: UploadTask, signal: AbortSignal): Promise<UploadMaterialResult>;
}>;

export async function migratePendingUploadTasks(
  repository: UploadTaskRepository,
  fromProfileId: string,
  toProfileId: string,
  targets: readonly PairingTarget[],
  now = new Date()
): Promise<number> {
  if (!fromProfileId || fromProfileId === toProfileId) return 0;
  const validTargets = new Set(targets.map((target) => `${target.notebookId}\u0000${target.sessionId}`));
  const tasks = await repository.loadUploadTasks(fromProfileId);
  const migratable = tasks.filter((task) =>
    task.status !== "succeeded" &&
    Boolean(task.bytes) &&
    validTargets.has(`${task.notebookId}\u0000${task.sessionId}`)
  );
  await Promise.all(migratable.map((task) => repository.saveUploadTask({
    ...task,
    profileId: toProfileId,
    status: "pending",
    attempts: 0,
    nextAttemptAt: undefined,
    lastError: undefined,
    updatedAt: now.toISOString()
  })));
  return migratable.length;
}

type QueueOptions = Readonly<{
  profileId: string;
  repository: UploadTaskRepository;
  transport: UploadTransport;
  onChange?: () => void | Promise<void>;
  now?: () => Date;
  maxAttempts?: number;
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}>;

export class ForegroundUploadQueue {
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly schedule: NonNullable<QueueOptions["schedule"]>;
  private readonly cancelSchedule: NonNullable<QueueOptions["cancelSchedule"]>;
  private active?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private abortController?: AbortController;

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 4;
    this.schedule = options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
  }

  async recover(): Promise<void> {
    const tasks = await this.options.repository.loadUploadTasks(this.options.profileId);
    let changed = false;
    for (const task of tasks) {
      if (task.status !== "uploading") continue;
      await this.options.repository.saveUploadTask({
        ...task,
        status: "pending",
        updatedAt: this.now().toISOString(),
        lastError: "上次上传被页面关闭打断，已重新排队。"
      });
      changed = true;
    }
    if (changed) await this.notify();
  }

  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.active) {
      this.active = this.run().finally(() => {
        this.active = undefined;
      });
    }
    return this.active;
  }

  async retry(id: string): Promise<void> {
    const task = await this.options.repository.loadUploadTask(id);
    if (!task || task.profileId !== this.options.profileId || task.status === "uploading") return;
    if (!task.bytes) {
      await this.options.repository.saveUploadTask({
        ...task,
        status: "failed",
        updatedAt: this.now().toISOString(),
        lastError: "本地素材已经被清理，无法重试。"
      });
      await this.notify();
      return;
    }
    await this.options.repository.saveUploadTask({
      ...task,
      status: "pending",
      attempts: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
      updatedAt: this.now().toISOString()
    });
    await this.notify();
    await this.drain();
  }

  async remove(id: string): Promise<void> {
    await this.options.repository.deleteUploadTask(id);
    await this.notify();
  }

  async clearSucceeded(): Promise<void> {
    const tasks = await this.options.repository.loadUploadTasks(this.options.profileId);
    await Promise.all(tasks.filter(isFullyComplete)
      .map((task) => this.options.repository.deleteUploadTask(task.id)));
    await this.notify();
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
    if (this.retryTimer) this.cancelSchedule(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async run(): Promise<void> {
    if (this.retryTimer) this.cancelSchedule(this.retryTimer);
    this.retryTimer = undefined;
    while (!this.stopped) {
      const tasks = await this.options.repository.loadUploadTasks(this.options.profileId);
      const now = this.now();
      const next = tasks
        .filter((task) => isReady(task, now))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!next) {
        this.scheduleNext(tasks, now);
        return;
      }
      await this.process(next);
    }
  }

  private async process(task: UploadTask): Promise<void> {
    const attempt = task.attempts + 1;
    const uploading: UploadTask = {
      ...task,
      status: "uploading",
      attempts: attempt,
      nextAttemptAt: undefined,
      lastError: undefined,
      updatedAt: this.now().toISOString()
    };
    await this.options.repository.saveUploadTask(uploading);
    await this.notify();
    this.abortController = new AbortController();
    try {
      const result = await this.options.transport.upload(uploading, this.abortController.signal);
      await this.options.repository.saveUploadTask({
        ...uploading,
        bytes: undefined,
        status: "succeeded",
        ...result,
        updatedAt: this.now().toISOString()
      });
    } catch (error) {
      if (this.stopped && this.abortController.signal.aborted) return;
      const failure = classifyUploadFailure(error);
      const canRetry = failure.retryable && attempt < this.maxAttempts;
      await this.options.repository.saveUploadTask({
        ...uploading,
        status: failure.authBlocked ? "blocked_auth" : canRetry ? "retry_wait" : "failed",
        nextAttemptAt: canRetry ? new Date(this.now().getTime() + retryDelay(attempt)).toISOString() : undefined,
        lastError: failure.message,
        updatedAt: this.now().toISOString()
      });
    } finally {
      this.abortController = undefined;
      await this.notify();
    }
  }

  private scheduleNext(tasks: readonly UploadTask[], now: Date): void {
    const nextTime = tasks
      .filter((task) => task.status === "retry_wait" && task.nextAttemptAt)
      .map((task) => Date.parse(task.nextAttemptAt!))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (nextTime === undefined || this.stopped) return;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = undefined;
      void this.drain();
    }, Math.max(0, nextTime - now.getTime()));
  }

  private async notify(): Promise<void> {
    await this.options.onChange?.();
  }
}

export function isFullyComplete(task: UploadTask): boolean {
  return task.status === "succeeded" &&
    (!task.recognitionJobId || task.recognitionStatus === "succeeded");
}

export function createUploadTask(input: {
  profileId: string;
  kind: UploadMaterialKind;
  file: File;
  previewBytes?: Blob;
  target: PairingTarget;
  now?: Date;
  id?: string;
}): UploadTask {
  const now = input.now ?? new Date();
  return {
    id: input.id ?? createClientId(),
    version: 1,
    profileId: input.profileId,
    kind: input.kind,
    fileName: input.file.name || `${input.kind}-${now.getTime()}`,
    mimeType: input.file.type || (input.kind === "pdf" ? "application/pdf" : "image/jpeg"),
    byteLength: input.file.size,
    bytes: input.file,
    previewBytes: input.previewBytes,
    notebookId: input.target.notebookId,
    notebookTitle: input.target.notebookTitle || input.target.notebookId,
    sessionId: input.target.sessionId,
    sessionTitle: input.target.title,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    attempts: 0,
    status: "pending"
  };
}

export function classifyUploadFailure(error: unknown): {
  message: string;
  retryable: boolean;
  authBlocked: boolean;
} {
  if (error instanceof CompanionApiError) {
    const authBlocked = error.status === 401 || error.status === 403;
    return {
      message: error.message,
      authBlocked,
      retryable: !authBlocked && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500)
    };
  }
  if (error instanceof TypeError) {
    return { message: "网络连接中断，素材仍保存在本机。", retryable: true, authBlocked: false };
  }
  return {
    message: error instanceof Error && error.message ? error.message : "上传没有完成，素材仍保存在本机。",
    retryable: true,
    authBlocked: false
  };
}

function isReady(task: UploadTask, now: Date): boolean {
  if (task.status === "pending") return Boolean(task.bytes);
  return task.status === "retry_wait" &&
    Boolean(task.bytes) &&
    Boolean(task.nextAttemptAt) &&
    Date.parse(task.nextAttemptAt!) <= now.getTime();
}

function retryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

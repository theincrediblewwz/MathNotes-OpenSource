import { describe, expect, it, vi } from "vitest";
import { CompanionApiError } from "./apiClient";
import type { PairingTarget, UploadTask } from "./domain";
import {
  ForegroundUploadQueue,
  classifyUploadFailure,
  createUploadTask,
  migratePendingUploadTasks,
  type UploadTaskRepository
} from "./uploadQueue";

class MemoryRepository implements UploadTaskRepository {
  readonly tasks = new Map<string, UploadTask>();

  loadUploadTask(id: string) {
    return Promise.resolve(this.tasks.get(id));
  }

  loadUploadTasks(profileId: string) {
    return Promise.resolve([...this.tasks.values()].filter((task) => task.profileId === profileId));
  }

  saveUploadTask(task: UploadTask) {
    this.tasks.set(task.id, task);
    return Promise.resolve();
  }

  deleteUploadTask(id: string) {
    this.tasks.delete(id);
    return Promise.resolve();
  }
}

const target: PairingTarget = {
  notebookId: "analysis",
  notebookTitle: "泛函分析",
  sessionId: "lecture",
  title: "第 3 讲"
};

function task(id = "task-1") {
  return createUploadTask({
    profileId: "device-1",
    kind: "image",
    file: new File(["photo"], "board.jpg", { type: "image/jpeg" }),
    previewBytes: new Blob(["thumbnail"], { type: "image/jpeg" }),
    target,
    now: new Date("2026-07-26T08:00:00.000Z"),
    id
  });
}

describe("ForegroundUploadQueue", () => {
  it("uploads one task at a time and removes the stored blob after success", async () => {
    const repository = new MemoryRepository();
    await repository.saveUploadTask(task());
    const upload = vi.fn().mockResolvedValue({
      uploadId: "upload-1",
      duplicate: false,
      recognitionJobId: "recognition-1",
      recognitionStatus: "running"
    });
    const queue = new ForegroundUploadQueue({
      profileId: "device-1",
      repository,
      transport: { upload },
      now: () => new Date("2026-07-26T08:01:00.000Z")
    });

    await Promise.all([queue.drain(), queue.drain()]);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(repository.tasks.get("task-1")).toMatchObject({
      status: "succeeded",
      attempts: 1,
      uploadId: "upload-1",
      recognitionJobId: "recognition-1",
      recognitionStatus: "running"
    });
    expect(repository.tasks.get("task-1")?.bytes).toBeUndefined();
    expect(repository.tasks.get("task-1")?.previewBytes?.size).toBeGreaterThan(0);
  });

  it("keeps recognition work visible when clearing completed uploads", async () => {
    const repository = new MemoryRepository();
    await repository.saveUploadTask({
      ...task("recognizing"),
      bytes: undefined,
      status: "succeeded",
      uploadId: "upload-recognizing",
      recognitionJobId: "recognition-1",
      recognitionStatus: "running"
    });
    await repository.saveUploadTask({
      ...task("complete"),
      bytes: undefined,
      status: "succeeded",
      uploadId: "upload-complete",
      recognitionJobId: "recognition-2",
      recognitionStatus: "succeeded"
    });
    const queue = new ForegroundUploadQueue({
      profileId: "device-1",
      repository,
      transport: { upload: vi.fn() }
    });

    await queue.clearSucceeded();

    expect(repository.tasks.has("recognizing")).toBe(true);
    expect(repository.tasks.has("complete")).toBe(false);
  });

  it("recovers an interrupted upload without losing its bytes", async () => {
    const repository = new MemoryRepository();
    await repository.saveUploadTask({ ...task(), status: "uploading", attempts: 1 });
    const queue = new ForegroundUploadQueue({
      profileId: "device-1",
      repository,
      transport: { upload: vi.fn() }
    });

    await queue.recover();

    expect(repository.tasks.get("task-1")).toMatchObject({
      status: "pending",
      attempts: 1
    });
    expect(repository.tasks.get("task-1")?.bytes).toBeInstanceOf(Blob);
  });

  it("blocks expired authorization and retries transient failures later", async () => {
    const repository = new MemoryRepository();
    await repository.saveUploadTask(task("auth"));
    await repository.saveUploadTask(task("transient"));
    const upload = vi.fn()
      .mockRejectedValueOnce(new CompanionApiError("重新配对", 401, "unauthorized"))
      .mockRejectedValueOnce(new CompanionApiError("电脑繁忙", 503, "busy"));
    const queue = new ForegroundUploadQueue({
      profileId: "device-1",
      repository,
      transport: { upload },
      now: () => new Date("2026-07-26T08:01:00.000Z"),
      schedule: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>)
    });

    await queue.drain();

    expect(repository.tasks.get("auth")?.status).toBe("blocked_auth");
    expect(repository.tasks.get("transient")).toMatchObject({
      status: "retry_wait",
      attempts: 1
    });
  });
});

describe("classifyUploadFailure", () => {
  it("distinguishes authentication, permanent requests and network failures", () => {
    expect(classifyUploadFailure(new CompanionApiError("expired", 403, "forbidden"))).toMatchObject({
      authBlocked: true,
      retryable: false
    });
    expect(classifyUploadFailure(new CompanionApiError("bad", 400, "bad_request"))).toMatchObject({
      authBlocked: false,
      retryable: false
    });
    expect(classifyUploadFailure(new TypeError("Failed to fetch"))).toMatchObject({
      authBlocked: false,
      retryable: true
    });
  });
});

describe("migratePendingUploadTasks", () => {
  it("moves recoverable work to a renewed device credential without changing its frozen target", async () => {
    const repository = new MemoryRepository();
    await repository.saveUploadTask({
      ...task("blocked"),
      status: "blocked_auth",
      attempts: 2,
      lastError: "请重新配对"
    });
    await repository.saveUploadTask({
      ...task("finished"),
      status: "succeeded",
      bytes: undefined,
      uploadId: "upload-finished"
    });

    await expect(migratePendingUploadTasks(
      repository,
      "device-1",
      "device-2",
      [target],
      new Date("2026-07-26T09:00:00.000Z")
    )).resolves.toBe(1);

    expect(repository.tasks.get("blocked")).toMatchObject({
      profileId: "device-2",
      notebookId: "analysis",
      sessionId: "lecture",
      status: "pending",
      attempts: 0,
      updatedAt: "2026-07-26T09:00:00.000Z"
    });
    expect(repository.tasks.get("blocked")?.lastError).toBeUndefined();
    expect(repository.tasks.get("finished")?.profileId).toBe("device-1");
  });

  it("does not move material whose original target no longer exists", async () => {
    const repository = new MemoryRepository();
    await repository.saveUploadTask(task("orphan"));

    await expect(migratePendingUploadTasks(
      repository,
      "device-1",
      "device-2",
      [{ ...target, sessionId: "another-session" }]
    )).resolves.toBe(0);

    expect(repository.tasks.get("orphan")?.profileId).toBe("device-1");
  });
});

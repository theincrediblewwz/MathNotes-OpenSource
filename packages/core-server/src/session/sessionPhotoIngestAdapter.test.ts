import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPhotoIngestAdapter } from "./sessionPhotoIngestAdapter";
import type { SessionImageImportService } from "./sessionImageImportService";
import type { SessionRecognitionService } from "./sessionRecognitionService";

describe("SessionPhotoIngestAdapter receipt reads", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-receipt-"));
    await writeFile(join(root, "network-photo-uploads.json"), JSON.stringify({
      version: 1,
      uploads: [{ version: 1, notebookId: "analysis", sessionId: "lecture", result: {
        uploadId: "upload_fixture", notebookId: "analysis", sessionId: "lecture",
        assetPath: "assets/images/processed.png", imageBlockId: "0002",
        transcriptBlockId: "0003", recognitionJobId: "task_fixture", recognitionStatus: "succeeded"
      } }]
    }));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("reports the current re-recognition state instead of the persisted original success", async () => {
    const get = vi.fn().mockResolvedValue({ status: "running", transcriptBlockId: "0003", warnings: [] });
    const adapter = createAdapter(get);
    expect(await adapter.getAcceptedUpload("upload_fixture", { notebookId: "analysis", sessionId: "lecture" }))
      .toMatchObject({ recognitionStatus: "running", notebookId: "analysis", sessionId: "lecture", transcriptBlockId: "0003" });
    get.mockResolvedValue({ status: "failed", transcriptBlockId: "0003", warnings: ["provider unavailable"] });
    expect(await adapter.getAcceptedUpload("upload_fixture"))
      .toMatchObject({ recognitionStatus: "failed", warnings: ["provider unavailable"] });
    expect(get).toHaveBeenCalledWith({ notebookId: "analysis", sessionId: "lecture", taskId: "task_fixture" });
  });

  it("rejects another session before reading its recognition task", async () => {
    const get = vi.fn();
    await expect(createAdapter(get).getAcceptedUpload("upload_fixture", { notebookId: "analysis", sessionId: "other" }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(get).not.toHaveBeenCalled();
  });

  it("does not report success for a missing upload record", async () => {
    const get = vi.fn();
    await expect(createAdapter(get).getAcceptedUpload("missing")).rejects.toMatchObject({ statusCode: 404 });
    expect(get).not.toHaveBeenCalled();
  });

  it("retries a current failure even when the original upload receipt still records success", async () => {
    const get = vi.fn().mockResolvedValue({ status: "failed", transcriptBlockId: "0003" });
    const retry = vi.fn().mockResolvedValue({ status: "running", transcriptBlockId: "0003", warnings: [] });
    expect(await createAdapter(get, retry).retryAcceptedRecognition("upload_fixture"))
      .toMatchObject({ recognitionStatus: "running", transcriptBlockId: "0003" });
    expect(retry).toHaveBeenCalledWith({ notebookId: "analysis", sessionId: "lecture", taskId: "task_fixture" });
    get.mockResolvedValue({ status: "running" });
    await expect(createAdapter(get, retry).retryAcceptedRecognition("upload_fixture")).rejects.toMatchObject({ statusCode: 409 });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  function createAdapter(get: ReturnType<typeof vi.fn>, retry = vi.fn()) {
    return new SessionPhotoIngestAdapter({
      userDataDir: root, notesRootDir: join(root, "unused-notes"),
      imageImporter: {} as SessionImageImportService,
      recognition: { get, retry } as unknown as SessionRecognitionService
    });
  }
});

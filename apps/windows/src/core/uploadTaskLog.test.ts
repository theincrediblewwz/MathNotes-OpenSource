import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertRecognitionJob } from "./recognitionJobLog";
import { readRecognitionTaskSummaries } from "./uploadTaskLog";

describe("readRecognitionTaskSummaries", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-tasks-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns an empty list when the upload log is missing", async () => {
    await expect(
      readRecognitionTaskSummaries({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([]);
  });

  it("returns newest upload tasks first and normalizes legacy records", async () => {
    const logDir = join(rootDir, "notebooks/functional_analysis/sessions/lecture/logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      join(logDir, "uploads.json"),
      `${JSON.stringify(
        [
          {
            uploadId: "upload_old",
            originalName: "old.jpg",
            mimeType: "image/jpeg",
            sha256: "old_hash",
            assetPath: "assets/photos/old.jpg",
            imageBlockId: "0001",
            transcriptBlockId: "0002",
            receivedAt: "2026-06-27T00:01:00.000Z"
          },
          {
            uploadId: "upload_new",
            originalName: "new.png",
            mimeType: "image/png",
            sha256: "new_hash",
            assetPath: "assets/photos/new.png",
            imageBlockId: "0003",
            transcriptBlockId: "0004",
            recognitionJobId: "recognition_0002",
            recognitionStatus: "succeeded",
            receivedAt: "2026-06-27T00:02:00.000Z"
          }
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      readRecognitionTaskSummaries({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      {
        id: "upload_new",
        fileName: "new.png",
        assetPath: "assets/photos/new.png",
        recognitionJobId: "recognition_0002",
        recognitionStatus: "succeeded",
        imageBlockId: "0003",
        transcriptBlockId: "0004",
        receivedAt: "2026-06-27T00:02:00.000Z"
      },
      {
        id: "upload_old",
        fileName: "old.jpg",
        assetPath: "assets/photos/old.jpg",
        recognitionJobId: "legacy_upload_old",
        recognitionStatus: "succeeded",
        imageBlockId: "0001",
        transcriptBlockId: "0002",
        receivedAt: "2026-06-27T00:01:00.000Z"
      }
    ]);
  });

  it("returns failed recognition jobs when no upload record was committed", async () => {
    await upsertRecognitionJob({
      rootDir,
      job: {
        id: "recognition_0001",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        imageBlockId: "0001",
        assetPath: "assets/photos/failed.jpg",
        imagePath: "C:/tmp/failed.jpg",
        now: "2026-06-27T02:00:00.000Z",
        status: "failed",
        attempts: 1,
        maxAttempts: 2,
        error: "provider offline"
      }
    });

    await expect(
      readRecognitionTaskSummaries({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      {
        id: "recognition_0001",
        fileName: "failed.jpg",
        assetPath: "assets/photos/failed.jpg",
        recognitionJobId: "recognition_0001",
        recognitionStatus: "failed",
        imageBlockId: "0001",
        transcriptBlockId: "-",
        receivedAt: "2026-06-27T02:00:00.000Z",
        error: "provider offline"
      }
    ]);
  });

  it("keeps a live running job running while preferring it over stale upload state", async () => {
    const logDir = join(rootDir, "notebooks/functional_analysis/sessions/lecture/logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      join(logDir, "uploads.json"),
      `${JSON.stringify(
        [
          {
            uploadId: "upload_stale",
            originalName: "stale.jpg",
            assetPath: "assets/photos/stale.jpg",
            imageBlockId: "0012",
            transcriptBlockId: "0013",
            recognitionJobId: "recognition_0012",
            recognitionStatus: "running",
            receivedAt: "2026-06-27T02:00:00.000Z"
          }
        ],
        null,
        2
      )}\n`,
      "utf8"
    );
    await upsertRecognitionJob({
      rootDir,
      job: {
        id: "recognition_0012",
        notebookId: "functional_analysis",
        sessionId: "lecture",
        imageBlockId: "0012",
        assetPath: "assets/photos/stale.jpg",
        imagePath: "C:/tmp/stale.jpg",
        now: "2026-06-27T02:00:00.000Z",
        status: "running",
        attempts: 1,
        maxAttempts: 2,
        transcriptBlockId: "0013"
      }
    });

    await expect(
      readRecognitionTaskSummaries({
        rootDir,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      {
        id: "recognition_0012",
        fileName: "stale.jpg",
        assetPath: "assets/photos/stale.jpg",
        recognitionJobId: "recognition_0012",
        recognitionStatus: "running",
        imageBlockId: "0012",
        transcriptBlockId: "0013",
        receivedAt: "2026-06-27T02:00:00.000Z"
      }
    ]);
  });
});

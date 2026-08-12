import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecognitionProvider } from "@mathnotes/shared";
import { BlockStore } from "./blockStore";
import { MockRecognitionProvider } from "./mockRecognitionProvider";
import { PhotoIngestPipeline, UploadError } from "./photoIngestPipeline";
import { readRecognitionJobs } from "./recognitionJobLog";

describe("PhotoIngestPipeline", () => {
  let root: string;
  let store: BlockStore;
  let pipeline: PhotoIngestPipeline;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-ingest-"));
    store = new BlockStore(root);
    pipeline = new PhotoIngestPipeline({
      store,
      provider: new MockRecognitionProvider()
    });

    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves a photo, appends an image block, and appends a mock AI transcript block", async () => {
    const bytes = Buffer.from("fake jpeg bytes");

    const result = await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo 001.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      captureId: "capture_001",
      deviceId: "android_phone",
      imageTransform: {
        version: 1,
        sourceAsset: "blackboard-original.jpg",
        sourceSha256: "a".repeat(64),
        outputAsset: "edited.png",
        outputMimeType: "image/png",
        operations: [{ type: "crop", rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } }],
        createdAt: "2026-06-26T10:00:30.000Z"
      },
      receivedAt: "2026-06-26T10:01:00.000Z"
    });

    expect(result).toMatchObject({
      duplicate: false,
      assetPath: "assets/photos/photo_001.jpg",
      imageBlockId: "0001",
      transcriptBlockId: "0002",
      recognitionJobId: "recognition_0001",
      recognitionStatus: "succeeded"
    });

    expect(
      await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/assets/photos/photo_001.jpg"), "utf8")
    ).toBe("fake jpeg bytes");
    expect(
      JSON.parse(
        await readFile(
          join(root, "notebooks/functional_analysis/sessions/lecture/assets/photos/photo_001.annotation.json"),
          "utf8"
        )
      )
    ).toMatchObject({
      sourceAsset: "blackboard-original.jpg",
      outputAsset: "assets/photos/photo_001.jpg",
      operations: [{ type: "crop", rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } }]
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => `${block.id}:${block.type}:${block.source}`)).toEqual([
      "0001:image:android_camera",
      "0002:markdown:ai_transcription"
    ]);
    expect(session.blocks[1].fromAssets).toEqual(["assets/photos/photo_001.jpg"]);

    const transcript = await readFile(
      join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0002_ai_transcript.md"),
      "utf8"
    );
    expect(transcript).not.toContain("source: photo_001.jpg");
    expect(transcript).toContain("Mock 识别占位");

    const uploadLog = JSON.parse(
      await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/logs/uploads.json"), "utf8")
    );
    expect(uploadLog).toHaveLength(1);
    expect(uploadLog[0]).toMatchObject({
      assetPath: "assets/photos/photo_001.jpg",
      sha256: sha256(bytes),
      imageBlockId: "0001",
      transcriptBlockId: "0002",
      recognitionStatus: "succeeded"
    });
  });

  it("deduplicates uploads by sha256 without appending duplicate blocks", async () => {
    const bytes = Buffer.from("same image bytes");

    await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo 001.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:01:00.000Z"
    });

    const duplicate = await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo duplicate.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:02:00.000Z"
    });

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.assetPath).toBe("assets/photos/photo_001.jpg");

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks).toHaveLength(2);
  });

  it("recovers an accepted receipt after pipeline restart without duplicating blocks", async () => {
    const bytes = Buffer.from("accepted before restart");
    const accepted = await pipeline.acceptPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "restart.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      captureId: "capture_restart",
      deviceId: "android_phone",
      receivedAt: "2026-06-26T10:01:00.000Z"
    });
    expect(accepted).toMatchObject({ duplicate: false, recognitionStatus: "pending" });

    const restartedPipeline = new PhotoIngestPipeline({
      store: new BlockStore(root),
      provider: new MockRecognitionProvider()
    });
    const recovered = await restartedPipeline.acceptPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "restart-again.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      captureId: "capture_restart",
      deviceId: "android_phone",
      receivedAt: "2026-06-26T10:02:00.000Z"
    });

    expect(recovered).toMatchObject({
      duplicate: true,
      uploadId: accepted.uploadId,
      imageBlockId: accepted.imageBlockId,
      recognitionJobId: accepted.recognitionJobId,
      recognitionStatus: "pending"
    });
    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => block.type)).toEqual(["image"]);
  });

  it("reimports the same photo when the previous transcript block no longer exists", async () => {
    const bytes = Buffer.from("same image bytes after deleted transcript");

    const first = await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo 001.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:01:00.000Z"
    });
    await store.deleteMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: first.transcriptBlockId!,
      now: "2026-06-26T10:01:30.000Z"
    });

    const second = await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo 001.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:02:00.000Z"
    });

    expect(second.duplicate).toBe(false);
    expect(second.uploadId).not.toBe(first.uploadId);
    expect(second.transcriptBlockId).not.toBe(first.transcriptBlockId);

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => `${block.id}:${block.type}:${block.source}`)).toEqual([
      "0001:image:android_camera",
      "0002:image:android_camera",
      "0003:markdown:ai_transcription"
    ]);
  });

  it("notifies callers when a duplicate upload is ignored", async () => {
    const onIngested = vi.fn();
    pipeline = new PhotoIngestPipeline({
      store,
      provider: new MockRecognitionProvider(),
      onIngested
    });
    const bytes = Buffer.from("same observable image bytes");

    await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo 001.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:01:00.000Z"
    });
    onIngested.mockClear();

    const duplicate = await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo duplicate.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:02:00.000Z"
    });

    expect(duplicate.duplicate).toBe(true);
    expect(onIngested).toHaveBeenCalledTimes(1);
    expect(onIngested).toHaveBeenCalledWith(
      expect.objectContaining({
        duplicate: true,
        assetPath: "assets/photos/photo_001.jpg",
        transcriptBlockId: "0002"
      })
    );
  });

  it("inserts image and transcript blocks after the requested block", async () => {
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "before",
      now: "2026-06-26T10:00:30.000Z"
    });
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "after",
      now: "2026-06-26T10:00:40.000Z"
    });

    const bytes = Buffer.from("insert me");
    await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "inserted.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      insertAfterBlockId: "0001",
      receivedAt: "2026-06-26T10:02:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => `${block.id}:${block.type}:${block.source}`)).toEqual([
      "0001:markdown:user",
      "0003:image:android_camera",
      "0004:markdown:ai_transcription",
      "0002:markdown:user"
    ]);
  });

  it("normalizes legacy duplicate upload records without recognition job fields", async () => {
    const bytes = Buffer.from("legacy duplicate image");
    const logPath = join(root, "notebooks/functional_analysis/sessions/lecture/logs/uploads.json");

    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/legacy.jpg",
      now: "2026-06-26T09:00:00.000Z"
    });
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "legacy transcript",
      fromAssets: ["assets/photos/legacy.jpg"],
      now: "2026-06-26T09:01:00.000Z"
    });

    await mkdir(join(root, "notebooks/functional_analysis/sessions/lecture/logs"), { recursive: true });
    await writeFile(
      logPath,
      `${JSON.stringify(
        [
          {
            uploadId: `upload_${sha256(bytes).slice(0, 16)}`,
            originalName: "legacy.jpg",
            mimeType: "image/jpeg",
            sha256: sha256(bytes),
            assetPath: "assets/photos/legacy.jpg",
            imageBlockId: "0001",
            transcriptBlockId: "0002",
            receivedAt: "2026-06-26T09:00:00.000Z"
          }
        ],
        null,
        2
      )}\n`,
      "utf8"
    );

    const duplicate = await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "legacy-again.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:02:00.000Z"
    });

    expect(duplicate).toMatchObject({
      duplicate: true,
      assetPath: "assets/photos/legacy.jpg",
      recognitionJobId: expect.stringContaining("legacy_upload_"),
      recognitionStatus: "succeeded"
    });
  });

  it("notifies callers after a successful upload is committed", async () => {
    const onIngested = vi.fn();
    pipeline = new PhotoIngestPipeline({
      store,
      provider: new MockRecognitionProvider(),
      onIngested
    });
    const bytes = Buffer.from("callback image bytes");

    const result = await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "photo 002.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      captureId: "capture_002",
      receivedAt: "2026-06-26T10:03:00.000Z"
    });

    expect(onIngested).toHaveBeenCalledTimes(1);
    expect(onIngested).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: result.uploadId,
        duplicate: false,
        assetPath: "assets/photos/photo_002.jpg",
        imageBlockId: "0001",
        recognitionStatus: "pending"
      })
    );
  });

  it("notifies callers as recognition jobs change status", async () => {
    const onRecognitionJobChanged = vi.fn();
    pipeline = new PhotoIngestPipeline({
      store,
      provider: new MockRecognitionProvider(),
      onRecognitionJobChanged
    });
    const bytes = Buffer.from("observable image bytes");

    await pipeline.ingestPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "observable.jpg",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256(bytes),
      receivedAt: "2026-06-26T10:04:00.000Z"
    });

    expect(onRecognitionJobChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "recognition_0001",
        status: "pending"
      })
    );
    expect(onRecognitionJobChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "recognition_0001",
        status: "running",
        attempts: 1
      })
    );
    expect(onRecognitionJobChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "recognition_0001",
        status: "succeeded",
        transcriptBlockId: "0002"
      })
    );
  });

  it("rejects mismatched client hashes", async () => {
    await expect(
      pipeline.ingestPhoto({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        originalName: "photo 001.jpg",
        mimeType: "image/jpeg",
        bytes: Buffer.from("fake jpeg bytes"),
        sha256: "not-the-real-hash",
        receivedAt: "2026-06-26T10:01:00.000Z"
      })
    ).rejects.toMatchObject({
      name: "UploadError",
      statusCode: 400
    } satisfies Partial<UploadError>);
  });

  it("processes the accepted job by id when a shared queue contains several pending uploads", async () => {
    const first = await pipeline.acceptPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "first.jpg",
      mimeType: "image/jpeg",
      bytes: Buffer.from("first pending image"),
      receivedAt: "2026-06-26T10:01:00.000Z"
    });
    const second = await pipeline.acceptPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      originalName: "second.jpg",
      mimeType: "image/jpeg",
      bytes: Buffer.from("second pending image"),
      receivedAt: "2026-06-26T10:02:00.000Z"
    });

    const processedSecond = await pipeline.processAcceptedRecognition(second);
    const processedFirst = await pipeline.processAcceptedRecognition(first);

    expect(processedSecond.recognitionJobId).toBe(second.recognitionJobId);
    expect(processedSecond.recognitionStatus).toBe("succeeded");
    expect(processedFirst.recognitionJobId).toBe(first.recognitionJobId);
    expect(processedFirst.recognitionStatus).toBe("succeeded");
  });

  it("persists failed recognition jobs before rejecting the upload", async () => {
    const failingProvider: RecognitionProvider = {
      name: "failing",
      async transcribe() {
        throw new Error("provider offline");
      }
    };
    pipeline = new PhotoIngestPipeline({
      store,
      provider: failingProvider
    });
    const bytes = Buffer.from("bad provider image");

    await expect(
      pipeline.ingestPhoto({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        originalName: "failed.jpg",
        mimeType: "image/jpeg",
        bytes,
        sha256: sha256(bytes),
        receivedAt: "2026-06-27T02:00:00.000Z"
      })
    ).rejects.toMatchObject({
      name: "UploadError",
      statusCode: 500
    } satisfies Partial<UploadError>);

    await expect(
      readRecognitionJobs({
        rootDir: root,
        notebookId: "functional_analysis",
        sessionId: "lecture"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        id: "recognition_0001",
        assetPath: "assets/photos/failed.jpg",
        imageBlockId: "0001",
        status: "failed",
        attempts: 1,
        error: "provider offline"
      })
    ]);
  });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecognitionProvider, SessionRecord } from "@mathnotes/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionPdfRecognitionBatchService } from "./sessionPdfRecognitionBatchService";
import { SessionRecognitionService } from "./sessionRecognitionService";
import { sessionManifestRevision } from "./sessionRevision";

describe("SessionPdfRecognitionBatchService", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-pdf-batch-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "paper");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await mkdir(join(sessionDir, "assets", "pdfs"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "# 论文阅读\n");
    await writeFile(join(sessionDir, "assets", "pdfs", "paper.pdf"), "%PDF-1.7 fixture");
    await writeSession();
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("stages selected pages and writes ordered PDF transcripts with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    let releasePair!: () => void;
    const firstPairEntered = new Promise<void>((resolve) => { releasePair = resolve; });
    const provider: RecognitionProvider = {
      name: "pdf-fixture",
      async transcribe(input) {
        active += 1;
        peak = Math.max(peak, active);
        calls += 1;
        if (calls === 2) releasePair();
        // Wait for both workers rather than assuming filesystem staging takes under 20 ms.
        if (calls <= 2) await firstPairEntered;
        active -= 1;
        return { markdown: `## 第 ${input.imagePaths[0].match(/page-(\d+)/)?.[1]} 页\n` };
      }
    };
    const recognition = new SessionRecognitionService(root, async () => provider);
    const service = new SessionPdfRecognitionBatchService(root, recognition, () => "2026-08-30T10:00:00.000Z", 1);
    const baseRevision = sessionManifestRevision(await readSession());
    const pages = await Promise.all([1, 2, 3].map((pageNumber) => service.stagePage({
      notebookId: "analysis",
      sessionId: "paper",
      pdfBlockId: "0002",
      pageNumber,
      baseRevision,
      bytes: png(pageNumber)
    })));
    const started = await service.start({
      notebookId: "analysis",
      sessionId: "paper",
      pdfBlockId: "0002",
      pdfAssetPath: "assets/pdfs/paper.pdf",
      pageCount: 3,
      concurrency: 2,
      baseRevision,
      pages: pages.map((page) => ({ pageNumber: page.pageNumber, assetPath: page.assetPath }))
    });
    const completed = await waitForBatch(service, started.batchId, "completed");

    expect(completed).toMatchObject({ selectedPages: [1, 2, 3], succeeded: 3, failed: 0 });
    expect(peak).toBe(2);
    const stored = await readSession();
    expect(stored.blocks.map((block) => block.id)).toEqual(["0001", "0002", "0003", "0004", "0005"]);
    expect(stored.blocks.slice(2).map((block) => ({
      page: block.sourcePageNumber,
      source: block.fromAssets,
      pageImage: block.sourcePageImagePath
    }))).toEqual([
      expect.objectContaining({ page: 1, source: ["assets/pdfs/paper.pdf"] }),
      expect.objectContaining({ page: 2, source: ["assets/pdfs/paper.pdf"] }),
      expect.objectContaining({ page: 3, source: ["assets/pdfs/paper.pdf"] })
    ]);
    expect(await readFile(join(sessionDir, "blocks", "0003_ai_transcript.md"), "utf8")).toContain("第 0001 页");
  });

  it("pauses after the active page and resumes the remaining pages", async () => {
    let releaseFirst: (() => void) | undefined;
    let callCount = 0;
    const provider: RecognitionProvider = {
      name: "pausable-pdf-fixture",
      async transcribe() {
        callCount += 1;
        if (callCount === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { markdown: `## 完成 ${callCount}\n` };
      }
    };
    const recognition = new SessionRecognitionService(root, async () => provider);
    const service = new SessionPdfRecognitionBatchService(root, recognition, undefined, 1);
    const started = await stageAndStart(service, 1);
    await waitFor(() => callCount === 1 && Boolean(releaseFirst));
    expect((await service.pause(batchInput(started.batchId))).status).toBe("pausing");
    releaseFirst?.();
    const paused = await waitForBatch(service, started.batchId, "paused");
    expect(paused).toMatchObject({ succeeded: 1, pending: 2 });

    expect((await service.resume(batchInput(started.batchId))).status).toBe("running");
    const completed = await waitForBatch(service, started.batchId, "completed");
    expect(completed).toMatchObject({ succeeded: 3, pending: 0 });
  });

  it("cancels active and waiting pages without deleting the source PDF", async () => {
    const provider: RecognitionProvider = {
      name: "cancel-pdf-fixture",
      async transcribe(input) {
        return new Promise((_resolve, reject) => {
          input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal?.reason), { once: true });
        });
      }
    };
    const recognition = new SessionRecognitionService(root, async () => provider);
    const service = new SessionPdfRecognitionBatchService(root, recognition, undefined, 1);
    const started = await stageAndStart(service, 2);
    await waitFor(async () => (await service.get(batchInput(started.batchId))).running === 2);
    const cancelled = await service.cancel(batchInput(started.batchId));

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelled).toBe(3);
    expect(await readFile(join(sessionDir, "assets", "pdfs", "paper.pdf"), "utf8")).toContain("%PDF-1.7");
  });

  it("rejects stale revisions, invalid pages, and non-PNG staging data", async () => {
    const recognition = new SessionRecognitionService(root, async () => ({
      name: "unused",
      async transcribe() { return { markdown: "unused" }; }
    }));
    const service = new SessionPdfRecognitionBatchService(root, recognition);
    await expect(service.stagePage({
      notebookId: "analysis", sessionId: "paper", pdfBlockId: "0002", pageNumber: 1,
      baseRevision: "0".repeat(64), bytes: png(1)
    })).rejects.toMatchObject({ code: "revision_conflict", statusCode: 409 });
    await expect(service.stagePage({
      notebookId: "analysis", sessionId: "paper", pdfBlockId: "0002", pageNumber: 4,
      baseRevision: sessionManifestRevision(await readSession()), bytes: png(4)
    })).rejects.toMatchObject({ code: "page_out_of_range", statusCode: 400 });
    await expect(service.stagePage({
      notebookId: "analysis", sessionId: "paper", pdfBlockId: "0002", pageNumber: 1,
      baseRevision: sessionManifestRevision(await readSession()), bytes: Buffer.from("not a png")
    })).rejects.toMatchObject({ code: "unsupported_image", statusCode: 415 });
  });

  async function stageAndStart(service: SessionPdfRecognitionBatchService, concurrency: number) {
    const baseRevision = sessionManifestRevision(await readSession());
    const pages = [];
    for (const pageNumber of [1, 2, 3]) {
      pages.push(await service.stagePage({
        notebookId: "analysis", sessionId: "paper", pdfBlockId: "0002", pageNumber,
        baseRevision, bytes: png(pageNumber)
      }));
    }
    return service.start({
      notebookId: "analysis", sessionId: "paper", pdfBlockId: "0002",
      pdfAssetPath: "assets/pdfs/paper.pdf", pageCount: 3, concurrency, baseRevision,
      pages: pages.map((page) => ({ pageNumber: page.pageNumber, assetPath: page.assetPath }))
    });
  }

  function batchInput(batchId: string) {
    return { notebookId: "analysis", sessionId: "paper", batchId };
  }

  async function waitForBatch(
    service: SessionPdfRecognitionBatchService,
    batchId: string,
    status: "paused" | "completed"
  ) {
    let last;
    for (let index = 0; index < 600; index += 1) {
      last = await service.get(batchInput(batchId));
      if (last.status === status) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`batch did not reach ${status}: ${JSON.stringify(last)}`);
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>) {
    for (let index = 0; index < 600; index += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition was not reached");
  }

  function png(seed: number): Buffer {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed]);
  }

  async function readSession(): Promise<SessionRecord> {
    return JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
  }

  async function writeSession(): Promise<void> {
    const session: SessionRecord = {
      id: "paper",
      title: "论文",
      status: "draft",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      currentDraftPolicy: "append_only",
      exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
      locks: [],
      blocks: [
        {
          id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
          readonly: false, editableByAi: false,
          createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z"
        },
        {
          id: "0002", type: "pdf", path: "assets/pdfs/paper.pdf", source: "pdf_import", status: "draft",
          readonly: true, editableByAi: false, renderInNote: true, pageCount: 3,
          createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z"
        }
      ]
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  }
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { RecognitionProvider } from "@mathnotes/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { PdfRecognitionBatchRunner, type PdfRecognitionPage } from "./pdfRecognitionBatch";
import { readRecognitionJobs } from "./recognitionJobLog";

describe("PdfRecognitionBatchRunner", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("recognizes 50 pages as independent jobs while preserving page order", async () => {
    const { root, store, pdfBlockId } = await createPdfSession();
    roots.push(root);
    let active = 0;
    let maxActive = 0;
    const imageCounts: number[] = [];
    const provider: RecognitionProvider = {
      name: "mock",
      async transcribe(input) {
        imageCounts.push(input.imagePaths.length);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        active -= 1;
        return { markdown: `page ${pageNumberFromPath(input.imagePaths[0])}` };
      }
    };
    const runner = new PdfRecognitionBatchRunner({
      store,
      provider,
      initialConcurrency: 2,
      maxConcurrency: 4,
      retryDelayMs: 1
    });
    const batch = await runner.prepare({
      notebookId: "n",
      sessionId: "s",
      pdfBlockId,
      pdfAssetPath: "assets/pdfs/long.pdf",
      pageCount: 50,
      pages: pages(50),
      now: "2026-07-14T12:00:00.000Z"
    });

    const result = await runner.run(batch);

    expect(result.status).toBe("completed");
    expect(result.jobs).toHaveLength(50);
    expect(result.jobs.every((job) => job.status === "succeeded")).toBe(true);
    expect(imageCounts).toEqual(Array(50).fill(1));
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result.peakConcurrency).toBeGreaterThanOrEqual(maxActive);

    const session = await store.readSession("n", "s");
    const transcripts = session.blocks.filter((block) => block.source === "ai_transcription");
    expect(transcripts.map((block) => block.id)).toEqual(batch.transcriptBlockIds);
    expect(transcripts.map((block) => block.sourcePageNumber)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1)
    );
    expect(transcripts.map((block) => block.sourcePageImagePath)).toEqual(
      Array.from(
        { length: 50 },
        (_, index) => `assets/pdf-pages/0001/page-${String(index + 1).padStart(4, "0")}.png`
      )
    );
    expect(transcripts.every((block) => block.fromAssets?.[0] === "assets/pdfs/long.pdf")).toBe(true);
    const markdown = await Promise.all(
      transcripts.map((block) => readFile(join(store.getSessionDir("n", "s"), block.path), "utf8"))
    );
    expect(markdown).toEqual(Array.from({ length: 50 }, (_, index) => `page ${index + 1}`));
  }, 45_000);

  it("backs off and retries a transient 429 without rebuilding successful pages", async () => {
    const { root, store, pdfBlockId } = await createPdfSession();
    roots.push(root);
    const calls = new Map<number, number>();
    const provider: RecognitionProvider = {
      name: "mock",
      async transcribe(input) {
        const pageNumber = pageNumberFromPath(input.imagePaths[0]);
        calls.set(pageNumber, (calls.get(pageNumber) ?? 0) + 1);
        if (pageNumber === 3 && calls.get(pageNumber) === 1) {
          throw new Error("HTTP 429 rate limit");
        }
        await delay(2);
        return { markdown: `page ${pageNumber}` };
      }
    };
    const runner = new PdfRecognitionBatchRunner({
      store,
      provider,
      initialConcurrency: 4,
      maxConcurrency: 4,
      retryDelayMs: 1
    });
    const batch = await runner.prepare({
      notebookId: "n",
      sessionId: "s",
      pdfBlockId,
      pdfAssetPath: "assets/pdfs/limited.pdf",
      pageCount: 8,
      pages: pages(8),
      now: "2026-07-14T12:10:00.000Z"
    });

    const result = await runner.run(batch);

    expect(result.jobs.every((job) => job.status === "succeeded")).toBe(true);
    expect(calls.get(3)).toBe(2);
    expect([...calls.entries()].filter(([page]) => page !== 3).every(([, count]) => count === 1)).toBe(true);
    expect(result.throttleEvents).toBe(1);
    expect(result.finalConcurrency).toBeLessThan(4);
  });

  it("restores persisted page jobs after a process restart", async () => {
    const { root, store, pdfBlockId } = await createPdfSession();
    roots.push(root);
    const provider: RecognitionProvider = {
      name: "mock",
      async transcribe(input) {
        return { markdown: `restored ${pageNumberFromPath(input.imagePaths[0])}` };
      }
    };
    const firstRunner = new PdfRecognitionBatchRunner({ store, provider, retryDelayMs: 1 });
    const prepared = await firstRunner.prepare({
      notebookId: "n",
      sessionId: "s",
      pdfBlockId,
      pdfAssetPath: "assets/pdfs/restart.pdf",
      pageCount: 4,
      pages: pages(4),
      now: "2026-07-14T12:20:00.000Z"
    });
    expect(await readRecognitionJobs({ rootDir: root, notebookId: "n", sessionId: "s" })).toHaveLength(4);

    const restartedRunner = new PdfRecognitionBatchRunner({ store, provider, retryDelayMs: 1 });
    const restored = await restartedRunner.restore({ notebookId: "n", sessionId: "s", batchId: prepared.batchId });
    const result = await restartedRunner.run(restored);

    expect(result.status).toBe("completed");
    expect(result.jobs.map((job) => job.pageNumber)).toEqual([1, 2, 3, 4]);
    expect(result.jobs.every((job) => job.status === "succeeded")).toBe(true);
  });
});

async function createPdfSession() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-pdf-batch-"));
  const store = new BlockStore(root);
  await store.createSession({ notebookId: "n", sessionId: "s", title: "PDF", now: "2026-07-14T11:59:00.000Z" });
  const block = await store.appendPdfBlock({
    notebookId: "n",
    sessionId: "s",
    assetPath: "assets/pdfs/source.pdf",
    sourceName: "source.pdf",
    pageCount: 50,
    now: "2026-07-14T11:59:01.000Z"
  });
  return { root, store, pdfBlockId: block.id };
}

function pages(count: number): PdfRecognitionPage[] {
  return Array.from({ length: count }, (_, index) => ({
    pageNumber: index + 1,
    assetPath: `assets/pdf-pages/0001/page-${String(index + 1).padStart(4, "0")}.png`,
    imagePath: `C:/pdf-pages/page-${String(index + 1).padStart(4, "0")}.png`
  }));
}

function pageNumberFromPath(path: string): number {
  return Number(basename(path).match(/(\d+)\.png$/)?.[1]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

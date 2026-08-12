import type { RecognitionProvider } from "@mathnotes/shared";
import path from "node:path";
import type { BlockStore } from "./blockStore";
import { BlockWriter } from "./blockWriter";
import { readRecognitionJobs, upsertRecognitionJob } from "./recognitionJobLog";
import { RecognitionQueue, type RecognitionJob, type RecognitionRuntimeEvent } from "./recognitionQueue";
import { buildRecognitionContextForJob } from "./sessionRecognitionContext";

export type PdfRecognitionPage = {
  pageNumber: number;
  assetPath: string;
  imagePath: string;
};

export type PdfRecognitionBatch = {
  batchId: string;
  notebookId: string;
  sessionId: string;
  pdfBlockId: string;
  pageCount: number;
  jobIds: string[];
  transcriptBlockIds: string[];
};

export type PdfRecognitionBatchRunResult = {
  status: "completed" | "paused" | "cancelled";
  jobs: RecognitionJob[];
  initialConcurrency: number;
  peakConcurrency: number;
  finalConcurrency: number;
  throttleEvents: number;
};

export class PdfRecognitionBatchRunner {
  private readonly queue: RecognitionQueue;
  private readonly writer: BlockWriter;
  private writeTail = Promise.resolve();
  private pauseRequested = false;
  private cancelRequested = false;
  private readonly activeJobIds = new Set<string>();

  constructor(
    private readonly deps: {
      store: BlockStore;
      provider: RecognitionProvider;
      maxAttempts?: number;
      initialConcurrency?: number;
      maxConcurrency?: number;
      retryDelayMs?: number;
      onJobChanged?: (job: RecognitionJob) => void | Promise<void>;
      onRuntimeEvent?: (event: RecognitionRuntimeEvent) => void | Promise<void>;
    }
  ) {
    this.writer = new BlockWriter(deps.store);
    this.queue = new RecognitionQueue({
      provider: deps.provider,
      maxAttempts: deps.maxAttempts ?? 2,
      writer: {
        writeAiTranscript: (args) => this.withSessionWrite(() => this.writer.writeAiTranscript(args)),
        updateAiTranscript: (args) => this.withSessionWrite(() => this.writer.updateAiTranscript(args))
      },
      buildContext: (job) => buildRecognitionContextForJob(deps.store, job),
      onJobChanged: async (job) => {
        await upsertRecognitionJob({ rootDir: deps.store.getRootDir(), job });
        await deps.onJobChanged?.(job);
      },
      onRuntimeEvent: deps.onRuntimeEvent
    });
  }

  async prepare(args: {
    notebookId: string;
    sessionId: string;
    pdfBlockId: string;
    pdfAssetPath: string;
    pageCount: number;
    pages: PdfRecognitionPage[];
    now: string;
  }): Promise<PdfRecognitionBatch> {
    const pages = normalizePages(args.pages, args.pageCount);
    const batchId = `pdf_${args.pdfBlockId}_${compactTimestamp(args.now)}`;
    const jobIds: string[] = [];
    const transcriptBlockIds: string[] = [];
    let insertAfterBlockId = args.pdfBlockId;
    const sessionDir = this.deps.store.getSessionDir(args.notebookId, args.sessionId);

    for (const page of pages) {
      const sourcePageImagePath =
        toSessionRelativePath(
          sessionDir,
          path.isAbsolute(page.assetPath) ? page.assetPath : path.join(sessionDir, page.assetPath)
        ) ?? toSessionRelativePath(sessionDir, page.imagePath);
      const transcript = await this.withSessionWrite(() =>
        this.writer.writeAiTranscript({
          notebookId: args.notebookId,
          sessionId: args.sessionId,
          markdown: `#### PDF 第 ${page.pageNumber} 页等待识别`,
          fromAssets: [args.pdfAssetPath],
          sourcePageNumber: page.pageNumber,
          sourcePageImagePath,
          insertAfterBlockId,
          now: args.now
        })
      );
      insertAfterBlockId = transcript.id;
      transcriptBlockIds.push(transcript.id);

      const jobId = `recognition_${batchId}_page_${String(page.pageNumber).padStart(4, "0")}`;
      const job = await this.queue.enqueuePersisted({
        notebookId: args.notebookId,
        sessionId: args.sessionId,
        imageBlockId: args.pdfBlockId,
        assetPath: args.pdfAssetPath,
        imagePath: page.imagePath,
        now: args.now,
        jobId,
        transcriptBlockId: transcript.id,
        batchId,
        pageNumber: page.pageNumber,
        pageCount: args.pageCount
      });
      jobIds.push(job.id);
    }

    return {
      batchId,
      notebookId: args.notebookId,
      sessionId: args.sessionId,
      pdfBlockId: args.pdfBlockId,
      pageCount: args.pageCount,
      jobIds,
      transcriptBlockIds
    };
  }

  async restore(args: { notebookId: string; sessionId: string; batchId: string }): Promise<PdfRecognitionBatch> {
    const jobs = (await readRecognitionJobs({
      rootDir: this.deps.store.getRootDir(),
      notebookId: args.notebookId,
      sessionId: args.sessionId
    }))
      .filter((job) => job.batchId === args.batchId)
      .sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0));
    if (jobs.length === 0) {
      throw new Error(`PDF recognition batch not found: ${args.batchId}`);
    }
    for (const job of jobs) {
      this.queue.restorePersisted(job);
    }
    return {
      batchId: args.batchId,
      notebookId: args.notebookId,
      sessionId: args.sessionId,
      pdfBlockId: jobs[0].imageBlockId,
      pageCount: jobs[0].pageCount ?? jobs.length,
      jobIds: jobs.map((job) => job.id),
      transcriptBlockIds: jobs.map((job) => job.transcriptBlockId).filter((id): id is string => Boolean(id))
    };
  }

  pause(): void {
    this.pauseRequested = true;
  }

  cancel(): void {
    this.cancelRequested = true;
    for (const jobId of this.activeJobIds) {
      this.queue.cancel(jobId);
    }
  }

  cancelBatch(batch: PdfRecognitionBatch): void {
    this.cancelRequested = true;
    for (const jobId of batch.jobIds) {
      this.queue.cancel(jobId);
      this.activeJobIds.delete(jobId);
    }
  }

  cancelJob(jobId: string): void {
    this.queue.cancel(jobId);
    this.activeJobIds.delete(jobId);
  }

  async run(batch: PdfRecognitionBatch): Promise<PdfRecognitionBatchRunResult> {
    this.pauseRequested = false;
    this.cancelRequested = false;
    const initialConcurrency = clampConcurrency(this.deps.initialConcurrency ?? 2, this.deps.maxConcurrency ?? 4);
    const maxConcurrency = Math.max(initialConcurrency, Math.min(4, Math.max(1, this.deps.maxConcurrency ?? 4)));
    const pending = batch.jobIds.filter((jobId) => {
      const job = this.queue.getJob(jobId);
      return job && job.status !== "succeeded" && job.status !== "cancelled" && job.attempts < job.maxAttempts;
    });
    let concurrency = initialConcurrency;
    let peakConcurrency = 0;
    let throttleEvents = 0;
    let consecutiveSuccesses = 0;
    let active = 0;
    let delayed = 0;

    return new Promise<PdfRecognitionBatchRunResult>((resolve) => {
      const finish = (status: PdfRecognitionBatchRunResult["status"]) => {
        resolve({
          status,
          jobs: batch.jobIds.map((id) => this.queue.getJob(id)).filter((job): job is RecognitionJob => Boolean(job)),
          initialConcurrency,
          peakConcurrency,
          finalConcurrency: concurrency,
          throttleEvents
        });
      };

      const pump = () => {
        if (this.cancelRequested) {
          if (active === 0) finish("cancelled");
          return;
        }
        if (this.pauseRequested) {
          if (active === 0) finish("paused");
          return;
        }

        while (active < concurrency && pending.length > 0) {
          const jobId = pending.shift()!;
          active += 1;
          peakConcurrency = Math.max(peakConcurrency, active);
          this.activeJobIds.add(jobId);
          void this.queue.processNext(jobId).then((job) => {
            active -= 1;
            this.activeJobIds.delete(jobId);
            if (job?.status === "succeeded") {
              consecutiveSuccesses += 1;
              if (consecutiveSuccesses >= 4 && concurrency < maxConcurrency && pending.length > 0) {
                concurrency += 1;
                consecutiveSuccesses = 0;
              }
            } else if (job?.status === "failed" && isTransientProviderFailure(job.error) && job.attempts < job.maxAttempts) {
              throttleEvents += 1;
              consecutiveSuccesses = 0;
              concurrency = Math.max(1, Math.floor(concurrency / 2));
              delayed += 1;
              setTimeout(() => {
                delayed -= 1;
                pending.push(jobId);
                pump();
              }, this.deps.retryDelayMs ?? 750);
            }
            if (pending.length === 0 && active === 0 && delayed === 0) {
              finish("completed");
              return;
            }
            pump();
          });
        }

        if (pending.length === 0 && active === 0 && delayed === 0) {
          finish("completed");
        }
      };

      pump();
    });
  }

  private async withSessionWrite<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function toSessionRelativePath(sessionDir: string, absolutePath: string): string | undefined {
  const relative = path.relative(sessionDir, path.resolve(absolutePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, "/");
}

function normalizePages(pages: PdfRecognitionPage[], pageCount: number): PdfRecognitionPage[] {
  const sorted = [...pages].sort((left, right) => left.pageNumber - right.pageNumber);
  const seen = new Set<number>();
  for (const page of sorted) {
    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > pageCount) {
      throw new Error(`Invalid PDF page number: ${page.pageNumber}`);
    }
    if (seen.has(page.pageNumber)) {
      throw new Error(`Duplicate PDF page number: ${page.pageNumber}`);
    }
    seen.add(page.pageNumber);
  }
  return sorted;
}

function compactTimestamp(value: string): string {
  return value.replace(/\D/g, "").slice(0, 17) || String(Date.now());
}

function clampConcurrency(value: number, max: number): number {
  return Math.min(Math.max(1, Math.floor(max)), Math.max(1, Math.floor(value)));
}

export function isTransientProviderFailure(error?: string): boolean {
  return Boolean(error && /(429|rate.?limit|timed?\s*out|timeout|503|overloaded|disconnect|temporar)/i.test(error));
}

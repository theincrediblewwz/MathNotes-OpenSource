import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RecognitionTaskSummary } from "./uploadTaskLog";
import type { RecognitionJob } from "./recognitionQueue";

export type RecognitionJobLogArgs = {
  rootDir: string;
  notebookId: string;
  sessionId: string;
};

export type UpsertRecognitionJobArgs = {
  rootDir: string;
  job: RecognitionJob;
};

const writeLocks = new Map<string, Promise<void>>();

export async function readRecognitionJobs(args: RecognitionJobLogArgs & { recoverRunning?: boolean }): Promise<RecognitionJob[]> {
  try {
    const jobs = JSON.parse(await readFile(recognitionJobLogPath(args), "utf8")) as RecognitionJob[];
    return jobs.map((job) => normalizeRecognitionJob(job, args.recoverRunning ?? true));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
}

export async function upsertRecognitionJob(args: UpsertRecognitionJobArgs): Promise<void> {
  const logArgs = {
    rootDir: args.rootDir,
    notebookId: args.job.notebookId,
    sessionId: args.job.sessionId
  };
  await withWriteLock(recognitionJobLogPath(logArgs), async () => {
    const jobs = await readRecognitionJobs({ ...logArgs, recoverRunning: false });
    const nextJobs = jobs.filter((job) => job.id !== args.job.id);
    nextJobs.push(normalizeRecognitionJob(args.job, false));
    nextJobs.sort((left, right) => left.now.localeCompare(right.now));
    await writeRecognitionJobs(logArgs, nextJobs);
  });
}

export function recognitionJobToTaskSummary(job: RecognitionJob): RecognitionTaskSummary {
  return {
    id: job.id,
    fileName: basename(job.assetPath),
    assetPath: job.assetPath,
    recognitionJobId: job.id,
    recognitionStatus: job.status,
    imageBlockId: job.imageBlockId,
    transcriptBlockId: job.transcriptBlockId ?? "-",
    receivedAt: job.now,
    providerName: job.providerName,
    providerLabel: job.providerLabel,
    error: job.error,
    warnings: job.warnings,
    failureKind: job.failureKind,
    batchId: job.batchId,
    pageNumber: job.pageNumber,
    pageCount: job.pageCount,
    timing: job.timing
  };
}

function normalizeRecognitionJob(job: RecognitionJob, recoverRunning: boolean): RecognitionJob {
  if (recoverRunning && job.status === "running") {
    return {
      ...job,
      status: "failed",
      error: job.error ?? "上次识别运行被中断，请在网络恢复后手动重试。"
    };
  }

  return {
    id: job.id,
    notebookId: job.notebookId,
    sessionId: job.sessionId,
    imageBlockId: job.imageBlockId,
    assetPath: job.assetPath,
    imagePath: job.imagePath,
    now: job.now,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    providerName: job.providerName,
    providerLabel: job.providerLabel,
    transcriptBlockId: job.transcriptBlockId,
    warnings: job.warnings,
    error: job.error,
    failureKind: job.failureKind,
    batchId: job.batchId,
    pageNumber: job.pageNumber,
    pageCount: job.pageCount,
    timing: job.timing
  };
}

async function writeRecognitionJobs(args: RecognitionJobLogArgs, jobs: RecognitionJob[]): Promise<void> {
  const target = recognitionJobLogPath(args);
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  await rm(target, { force: true });
  await rename(tmp, target);
}

function recognitionJobLogPath(args: RecognitionJobLogArgs): string {
  return join(args.rootDir, "notebooks", args.notebookId, "sessions", args.sessionId, "logs", "recognition_jobs.json");
}

async function withWriteLock(path: string, write: () => Promise<void>): Promise<void> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(path, previous.then(() => current, () => current));

  try {
    await previous.catch(() => undefined);
    await write();
  } finally {
    release();
    if (writeLocks.get(path) === current) {
      writeLocks.delete(path);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

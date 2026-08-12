import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecognitionFailureKind, RecognitionJobStatus, RecognitionTiming } from "./recognitionQueue";
import { readRecognitionJobs, recognitionJobToTaskSummary } from "./recognitionJobLog";

type StoredUploadTaskRecord = {
  uploadId: string;
  originalName: string;
  assetPath: string;
  imageBlockId: string;
  transcriptBlockId?: string;
  recognitionJobId?: string;
  recognitionStatus?: RecognitionJobStatus;
  failureKind?: RecognitionFailureKind;
  receivedAt: string;
};

export type RecognitionTaskSummary = {
  id: string;
  fileName: string;
  assetPath: string;
  recognitionJobId: string;
  recognitionStatus: RecognitionJobStatus;
  imageBlockId: string;
  transcriptBlockId: string;
  receivedAt: string;
  providerName?: string;
  providerLabel?: string;
  error?: string;
  warnings?: string[];
  failureKind?: RecognitionFailureKind;
  batchId?: string;
  pageNumber?: number;
  pageCount?: number;
  timing?: RecognitionTiming;
};

export type ReadRecognitionTaskSummariesArgs = {
  rootDir: string;
  notebookId: string;
  sessionId: string;
  limit?: number;
};

export async function readRecognitionTaskSummaries(args: ReadRecognitionTaskSummariesArgs): Promise<RecognitionTaskSummary[]> {
  // This is a live UI read. Crash recovery belongs to the explicit startup/retry path;
  // recovering here would turn a healthy in-process job into a false failure.
  const jobTasks = (await readRecognitionJobs({ ...args, recoverRunning: false })).map(recognitionJobToTaskSummary);
  const uploadTasks = await readUploadTaskSummaries(args);
  const seenJobIds = new Set(jobTasks.map((task) => task.recognitionJobId));
  return [...jobTasks, ...uploadTasks.filter((task) => !seenJobIds.has(task.recognitionJobId))]
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
    .slice(0, args.limit ?? 20);
}

async function readUploadTaskSummaries(args: ReadRecognitionTaskSummariesArgs): Promise<RecognitionTaskSummary[]> {
  try {
    const records = JSON.parse(await readFile(uploadLogPath(args), "utf8")) as StoredUploadTaskRecord[];
    return records
      .map(toRecognitionTaskSummary)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
}

function toRecognitionTaskSummary(record: StoredUploadTaskRecord): RecognitionTaskSummary {
  return {
    id: record.uploadId,
    fileName: record.originalName,
    assetPath: record.assetPath,
    recognitionJobId: record.recognitionJobId ?? `legacy_${record.uploadId}`,
    recognitionStatus: record.recognitionStatus ?? "succeeded",
    imageBlockId: record.imageBlockId,
    transcriptBlockId: record.transcriptBlockId ?? "-",
    receivedAt: record.receivedAt,
    failureKind: record.failureKind
  };
}

function uploadLogPath(args: ReadRecognitionTaskSummariesArgs): string {
  return join(args.rootDir, "notebooks", args.notebookId, "sessions", args.sessionId, "logs", "uploads.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertValidImageTransformSidecar,
  type RecognitionProvider,
  type SessionRecord
} from "@mathnotes/shared";
import {
  type IngestPhotoArgs,
  type IngestPhotoResult,
  type PhotoIngestPort,
  readNotesCatalog,
  UploadError
} from "@mathnotes/core-server";
import type { BlockStore } from "./blockStore";
import { BlockWriter } from "./blockWriter";
import { RecognitionQueue, type RecognitionJob, type RecognitionJobStatus, type RecognitionRuntimeEvent } from "./recognitionQueue";
import { readRecognitionJobs, upsertRecognitionJob } from "./recognitionJobLog";
import { buildRecognitionContextForJob } from "./sessionRecognitionContext";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type UploadRecord = {
  uploadId: string;
  captureId?: string;
  deviceId?: string;
  originalName: string;
  mimeType: string;
  sha256: string;
  assetPath: string;
  imageBlockId: string;
  transcriptBlockId?: string;
  recognitionJobId: string;
  recognitionStatus: RecognitionJobStatus;
  receivedAt: string;
};

type StoredUploadRecord = Omit<UploadRecord, "recognitionJobId" | "recognitionStatus"> &
  Partial<Pick<UploadRecord, "recognitionJobId" | "recognitionStatus">>;

export { UploadError } from "@mathnotes/core-server";
export type { IngestPhotoArgs, IngestPhotoResult } from "@mathnotes/core-server";

export class PhotoIngestPipeline implements PhotoIngestPort {
  constructor(
    private readonly deps: {
      store: BlockStore;
      provider: RecognitionProvider;
      queue?: RecognitionQueue;
      onIngested?: (result: IngestPhotoResult) => void | Promise<void>;
      onRecognitionJobChanged?: (job: RecognitionJob) => void | Promise<void>;
      onRecognitionRuntimeEvent?: (event: RecognitionRuntimeEvent) => void | Promise<void>;
    }
  ) {
    this.queue =
      deps.queue ??
      new RecognitionQueue({
        provider: deps.provider,
        writer: new BlockWriter(deps.store),
        buildContext: (job) => buildRecognitionContextForJob(deps.store, job),
        onJobChanged: (job) =>
          upsertRecognitionJob({
            rootDir: deps.store.getRootDir(),
            job
          }).then(() => deps.onRecognitionJobChanged?.(job)),
        onRuntimeEvent: deps.onRecognitionRuntimeEvent
      });
  }

  private readonly queue: RecognitionQueue;
  private readonly acceptedSessionKeys = new Map<string, string>();

  async ingestPhoto(args: IngestPhotoArgs): Promise<IngestPhotoResult> {
    const accepted = await this.acceptPhoto(args);
    if (accepted.duplicate) {
      return accepted;
    }

    const completed = await this.processAcceptedRecognition(accepted);
    if (!completed.transcriptBlockId || completed.recognitionStatus === "failed") {
      throw new UploadError(`Recognition failed for ${completed.assetPath}`, 500);
    }
    return completed;
  }

  async acceptPhoto(args: IngestPhotoArgs): Promise<IngestPhotoResult> {
    if (!ACCEPTED_IMAGE_TYPES.has(args.mimeType)) {
      throw new UploadError(`Unsupported image type: ${args.mimeType}`, 415);
    }

    const computedHash = sha256(args.bytes);
    if (args.sha256 && args.sha256 !== computedHash) {
      throw new UploadError("sha256 does not match uploaded bytes", 400);
    }

    return withAcceptLock(`${args.notebookId}/${args.sessionId}`, async () => {
      const uploadLog = await this.readUploadLog(args.notebookId, args.sessionId);
      const session = await this.deps.store.readSession(args.notebookId, args.sessionId);
      const identityMatch = findCaptureIdentity(uploadLog, args.deviceId, args.captureId);
      if (identityMatch && identityMatch.sha256 !== computedHash) {
        throw new UploadError("capture identity already exists with different bytes", 409);
      }
      if (identityMatch) {
        const result = await this.currentUploadResult(identityMatch, args, true);
        await this.deps.onIngested?.(result);
        return result;
      }
      const duplicate = uploadLog.find(
        (record) => record.sha256 === computedHash && uploadRecordBlocksStillExist(session, record)
      );
      if (duplicate) {
        const result = await this.currentUploadResult(duplicate, args, true);
        await this.deps.onIngested?.(result);
        return result;
      }

      const saved = await this.deps.store.savePhotoAsset({
        notebookId: args.notebookId,
        sessionId: args.sessionId,
        fileName: args.originalName,
        bytes: args.bytes
      });

      if (args.imageTransform) {
        assertValidImageTransformSidecar(args.imageTransform);
        await this.deps.store.savePhotoAnnotation(
          args.notebookId,
          args.sessionId,
          saved.relativePath,
          {
            ...args.imageTransform,
            outputAsset: saved.relativePath
          }
        );
      }

      const imageBlock = await this.deps.store.appendImageBlock({
        notebookId: args.notebookId,
        sessionId: args.sessionId,
        assetPath: saved.relativePath,
        insertAfterBlockId: args.insertAfterBlockId,
        now: args.receivedAt
      });

      const recognitionJob = await this.queue.enqueuePersisted({
        notebookId: args.notebookId,
        sessionId: args.sessionId,
        imageBlockId: imageBlock.id,
        assetPath: saved.relativePath,
        imagePath: saved.absolutePath,
        now: args.receivedAt
      });

      const record: UploadRecord = {
        uploadId: createUploadId(computedHash, uploadLog),
        captureId: args.captureId,
        deviceId: args.deviceId,
        originalName: args.originalName,
        mimeType: args.mimeType,
        sha256: computedHash,
        assetPath: saved.relativePath,
        imageBlockId: imageBlock.id,
        recognitionJobId: recognitionJob.id,
        recognitionStatus: recognitionJob.status,
        receivedAt: args.receivedAt
      };

      uploadLog.push(record);
      await this.writeUploadLog(args.notebookId, args.sessionId, uploadLog);
      this.acceptedSessionKeys.set(record.uploadId, `${args.notebookId}/${args.sessionId}`);

      const result = { ...record, notebookId: args.notebookId, sessionId: args.sessionId, duplicate: false };
      await this.deps.onIngested?.(result);
      return result;
    });
  }

  async getAcceptedUpload(uploadId: string, target?: { notebookId: string; sessionId: string }): Promise<IngestPhotoResult> {
    return readAcceptedPhotoUpload(this.deps.store, uploadId, target);
  }

  private async currentUploadResult(record: UploadRecord, target: { notebookId: string; sessionId: string }, duplicate: boolean): Promise<IngestPhotoResult> {
    return currentUploadResult(this.deps.store, record, target, duplicate);
  }

  async processAcceptedRecognition(accepted: IngestPhotoResult): Promise<IngestPhotoResult> {
    if (accepted.duplicate) {
      return accepted;
    }
    const sessionKey = accepted.notebookId && accepted.sessionId
      ? `${accepted.notebookId}/${accepted.sessionId}` : this.acceptedSessionKeys.get(accepted.uploadId);
    if (!sessionKey) {
      throw new UploadError(`Missing accepted upload context: ${accepted.uploadId}`, 500);
    }
    try {
      return await withRecognitionLock(sessionKey, async () => this.processAcceptedRecognitionUnlocked(accepted));
    } finally {
      this.acceptedSessionKeys.delete(accepted.uploadId);
    }
  }

  private async processAcceptedRecognitionUnlocked(accepted: IngestPhotoResult): Promise<IngestPhotoResult> {
    const target = accepted.notebookId && accepted.sessionId
      ? { notebookId: accepted.notebookId, sessionId: accepted.sessionId }
      : undefined;
    const processedJob = await this.queue.processNext(accepted.recognitionJobId, target);
    if (!processedJob) {
      throw new UploadError(`Recognition job was not processed: ${accepted.recognitionJobId}`, 500);
    }

    const updated: UploadRecord = {
      ...accepted,
      transcriptBlockId: processedJob.transcriptBlockId,
      recognitionStatus: processedJob.status
    };
    await withAcceptLock(`${processedJob.notebookId}/${processedJob.sessionId}`, async () => {
      const records = await this.readUploadLog(processedJob.notebookId, processedJob.sessionId);
      const index = records.findIndex((record) => record.uploadId === accepted.uploadId);
      if (index >= 0) {
        records[index] = updated;
        await this.writeUploadLog(processedJob.notebookId, processedJob.sessionId, records);
      }
    });
    const result = { ...updated, notebookId: processedJob.notebookId, sessionId: processedJob.sessionId, duplicate: false, warnings: processedJob.warnings };
    return result;
  }

  private async readUploadLog(notebookId: string, sessionId: string): Promise<UploadRecord[]> {
    return readUploadRecords(this.deps.store, { notebookId, sessionId });
  }

  private async writeUploadLog(notebookId: string, sessionId: string, records: UploadRecord[]): Promise<void> {
    const target = this.uploadLogPath(notebookId, sessionId);
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rm(target, { force: true });
    await rename(tmp, target);
  }

  private uploadLogPath(notebookId: string, sessionId: string): string {
    return join(this.deps.store.getSessionDir(notebookId, sessionId), "logs", "uploads.json");
  }
}

/** Reads persisted receipts without creating a recognition provider or queue. */
export async function readAcceptedPhotoUpload(store: BlockStore, uploadId: string, target?: { notebookId: string; sessionId: string }): Promise<IngestPhotoResult> {
  const targets = target ? [target] : (await readNotesCatalog({ rootDir: store.getRootDir() })).notebooks.flatMap(notebook => notebook.sessions);
  const matches: IngestPhotoResult[] = [];
  for (const candidate of targets) {
    if ([candidate.notebookId, candidate.sessionId].some(value => !value || value === "." || value === ".." || /[\\/\u0000:]/.test(value))) {
      throw new UploadError("Invalid upload target", 400);
    }
    try { await store.readSession(candidate.notebookId, candidate.sessionId); }
    catch (error) { if (isMissingFile(error)) continue; throw error; }
    const records = await readUploadRecords(store, candidate);
    for (const record of records.filter(item => item.uploadId === uploadId)) {
      matches.push(await currentUploadResult(store, record, candidate, false));
    }
    if (matches.length > 1) throw new UploadError("Upload ID is ambiguous; specify notebookId and sessionId", 409);
  }
  if (!matches.length) throw new UploadError(`Accepted upload not found: ${uploadId}`, 404);
  return matches[0];
}

async function currentUploadResult(store: BlockStore, record: UploadRecord, target: { notebookId: string; sessionId: string }, duplicate: boolean): Promise<IngestPhotoResult> {
  const jobs = await readRecognitionJobs({ rootDir: store.getRootDir(), ...target, recoverRunning: false });
  const job = jobs.find(item => item.id === record.recognitionJobId && item.notebookId === target.notebookId && item.sessionId === target.sessionId
    && item.imageBlockId === record.imageBlockId && item.assetPath === record.assetPath);
  return { ...record, notebookId: target.notebookId, sessionId: target.sessionId, duplicate,
    ...(job ? { recognitionStatus: job.status, transcriptBlockId: job.transcriptBlockId, warnings: job.warnings } : {}) };
}

async function readUploadRecords(store: BlockStore, target: { notebookId: string; sessionId: string }): Promise<UploadRecord[]> {
  try {
    const records = JSON.parse(await readFile(join(store.getSessionDir(target.notebookId, target.sessionId), "logs/uploads.json"), "utf8")) as StoredUploadRecord[];
    return records.map(normalizeUploadRecord);
  } catch (error) { if (isMissingFile(error)) return []; throw error; }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizeUploadRecord(record: StoredUploadRecord): UploadRecord {
  return {
    ...record,
    recognitionJobId: record.recognitionJobId ?? `legacy_${record.uploadId}`,
    recognitionStatus: record.recognitionStatus ?? "succeeded"
  };
}

function createUploadId(hash: string, existingRecords: UploadRecord[]): string {
  const baseId = `upload_${hash.slice(0, 16)}`;
  const existingIds = new Set(existingRecords.map((record) => record.uploadId));
  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let index = 2;
  while (existingIds.has(`${baseId}_${index}`)) {
    index += 1;
  }
  return `${baseId}_${index}`;
}

function uploadRecordBlocksStillExist(session: SessionRecord, record: UploadRecord): boolean {
  const blockIds = new Set(session.blocks.map((block) => block.id));
  return blockIds.has(record.imageBlockId) && (!record.transcriptBlockId || blockIds.has(record.transcriptBlockId));
}

function findCaptureIdentity(records: UploadRecord[], deviceId?: string, captureId?: string): UploadRecord | undefined {
  if (!deviceId || !captureId) return undefined;
  return records.find((record) => record.deviceId === deviceId && record.captureId === captureId);
}

const acceptLocks = new Map<string, Promise<void>>();
const recognitionLocks = new Map<string, Promise<void>>();

async function withAcceptLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = acceptLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  acceptLocks.set(key, tail);
  try {
    await previous.catch(() => undefined);
    return await action();
  } finally {
    release();
    if (acceptLocks.get(key) === tail) acceptLocks.delete(key);
  }
}

async function withRecognitionLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  return withLock(recognitionLocks, key, action);
}

async function withLock<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  locks.set(key, tail);
  try {
    await previous.catch(() => undefined);
    return await action();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

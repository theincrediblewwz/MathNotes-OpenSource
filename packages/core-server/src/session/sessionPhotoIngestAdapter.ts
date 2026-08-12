import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  UploadError,
  type IngestPhotoArgs,
  type IngestPhotoResult,
  type PhotoIngestPort
} from "../api/networkApiContracts";
import { readReadonlySessionBlock, readReadonlySessionManifest } from "./sessionReadService";
import {
  SessionImageImportError,
  SessionImageImportService
} from "./sessionImageImportService";
import {
  SessionRecognitionError,
  SessionRecognitionService,
  type SessionRecognitionTask
} from "./sessionRecognitionService";

type StoredUpload = Readonly<{
  version: 1;
  notebookId: string;
  sessionId: string;
  result: IngestPhotoResult;
}>;

type UploadState = Readonly<{
  version: 1;
  uploads: readonly StoredUpload[];
}>;

export type SessionPhotoIngestAdapterOptions = Readonly<{
  userDataDir: string;
  notesRootDir: string;
  imageImporter: SessionImageImportService;
  recognition: SessionRecognitionService;
  now?: () => string;
  pollIntervalMs?: number;
  recognitionTimeoutMs?: number;
}>;

/**
 * Bridges the portable network upload contract to the shared session services.
 * It intentionally contains no Electron or Windows-specific behavior.
 */
export class SessionPhotoIngestAdapter implements PhotoIngestPort {
  private readonly statePath: string;
  private readonly now: () => string;
  private readonly pollIntervalMs: number;
  private readonly recognitionTimeoutMs: number;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SessionPhotoIngestAdapterOptions) {
    this.statePath = join(options.userDataDir, "network-photo-uploads.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.recognitionTimeoutMs = options.recognitionTimeoutMs ?? 10 * 60_000;
  }

  acceptPhoto(input: IngestPhotoArgs): Promise<IngestPhotoResult> {
    return this.serial(() => this.acceptPhotoSerial(input));
  }

  async processAcceptedRecognition(accepted: IngestPhotoResult): Promise<IngestPhotoResult> {
    const stored = await this.findUpload(accepted.uploadId);
    if (!stored) throw new UploadError("Upload record is unavailable", 404);
    if (isTerminal(accepted.recognitionStatus)) return accepted;

    const deadline = Date.now() + this.recognitionTimeoutMs;
    while (Date.now() < deadline) {
      const task = await this.options.recognition.get({
        notebookId: stored.notebookId,
        sessionId: stored.sessionId,
        taskId: accepted.recognitionJobId
      });
      if (isTerminal(task.status)) {
        const completed = resultForTask(accepted, task);
        await this.updateUpload(completed);
        return completed;
      }
      await delay(this.pollIntervalMs);
    }

    const timedOut: IngestPhotoResult = {
      ...accepted,
      recognitionStatus: "failed",
      warnings: [...(accepted.warnings ?? []), "Recognition did not finish before the host timeout."]
    };
    await this.updateUpload(timedOut);
    return timedOut;
  }

  async getAcceptedUpload(uploadId: string): Promise<IngestPhotoResult> {
    const stored = await this.findUpload(uploadId);
    if (!stored) throw new UploadError("Upload record is unavailable", 404);
    return stored.result;
  }

  async retryAcceptedRecognition(uploadId: string): Promise<IngestPhotoResult> {
    const stored = await this.findUpload(uploadId);
    if (!stored) throw new UploadError("Upload record is unavailable", 404);
    if (stored.result.recognitionStatus !== "failed" && stored.result.recognitionStatus !== "cancelled") {
      throw new UploadError("Recognition task is not retryable", 409);
    }
    try {
      const task = await this.options.recognition.retry({
        notebookId: stored.notebookId,
        sessionId: stored.sessionId,
        taskId: stored.result.recognitionJobId
      });
      const retried = resultForTask(stored.result, task);
      await this.updateUpload(retried);
      return retried;
    } catch (error) {
      if (error instanceof SessionRecognitionError) {
        throw new UploadError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private async acceptPhotoSerial(input: IngestPhotoArgs): Promise<IngestPhotoResult> {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (input.sha256 && normalizeHash(input.sha256) !== sha256) {
      throw new UploadError("SHA-256 mismatch", 422);
    }

    const state = await readState(this.statePath);
    const duplicate = state.uploads.find((entry) =>
      entry.notebookId === input.notebookId &&
      entry.sessionId === input.sessionId &&
      (
        entry.result.sha256 === sha256 ||
        (
          input.captureId !== undefined &&
          input.deviceId !== undefined &&
          entry.result.captureId === input.captureId &&
          entry.result.deviceId === input.deviceId
        )
      )
    );
    if (duplicate) return { ...duplicate.result, duplicate: true };

    try {
      const manifest = await readReadonlySessionManifest({
        rootDir: this.options.notesRootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId
      });
      const imported = await this.options.imageImporter.importImage({
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        fileName: input.originalName,
        bytes: input.bytes,
        baseRevision: manifest.revision
      });
      const image = await readReadonlySessionBlock({
        rootDir: this.options.notesRootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: imported.blockId
      });
      if (image.content.kind !== "image") throw new UploadError("Imported block is not an image", 500);

      const task = await this.options.recognition.start({
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        imageBlockId: imported.blockId
      });
      const result: IngestPhotoResult = {
        uploadId: `upload_${randomUUID()}`,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        captureId: input.captureId,
        deviceId: input.deviceId,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sha256,
        assetPath: image.content.assetPath,
        imageBlockId: imported.blockId,
        transcriptBlockId: task.transcriptBlockId,
        recognitionJobId: task.id,
        recognitionStatus: task.status,
        receivedAt: input.receivedAt || this.now(),
        duplicate: false
      };
      await writeState(this.statePath, {
        version: 1,
        uploads: [...state.uploads, {
          version: 1 as const,
          notebookId: input.notebookId,
          sessionId: input.sessionId,
          result
        }].slice(-512)
      });
      return result;
    } catch (error) {
      if (error instanceof UploadError) throw error;
      if (error instanceof SessionImageImportError || error instanceof SessionRecognitionError) {
        throw new UploadError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private async findUpload(uploadId: string): Promise<StoredUpload | undefined> {
    const state = await readState(this.statePath);
    return state.uploads.find((entry) => entry.result.uploadId === uploadId);
  }

  private updateUpload(result: IngestPhotoResult): Promise<void> {
    return this.serial(async () => {
      const state = await readState(this.statePath);
      const uploads = state.uploads.map((entry) =>
        entry.result.uploadId === result.uploadId ? { ...entry, result } : entry
      );
      await writeState(this.statePath, { version: 1, uploads });
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function resultForTask(result: IngestPhotoResult, task: SessionRecognitionTask): IngestPhotoResult {
  return {
    ...result,
    transcriptBlockId: task.transcriptBlockId,
    recognitionStatus: task.status,
    warnings: task.warnings
  };
}

function isTerminal(status: IngestPhotoResult["recognitionStatus"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function normalizeHash(value: string): string {
  return value.trim().toLowerCase();
}

async function readState(path: string): Promise<UploadState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as UploadState;
    if (parsed.version !== 1 || !Array.isArray(parsed.uploads)) throw new Error("Invalid upload state");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, uploads: [] };
    throw error;
  }
}

async function writeState(path: string, state: UploadState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

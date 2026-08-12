import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  UploadError,
  type IngestPdfArgs,
  type IngestPdfResult,
  type PdfIngestPort
} from "../api/networkApiContracts";
import { readReadonlySessionManifest } from "./sessionReadService";
import {
  SessionPdfImportError,
  SessionPdfImportService
} from "./sessionPdfImportService";

type StoredPdfUpload = Readonly<{
  version: 1;
  sha256: string;
  captureId?: string;
  deviceId?: string;
  result: IngestPdfResult;
}>;

type PdfUploadState = Readonly<{
  version: 1;
  uploads: readonly StoredPdfUpload[];
}>;

export type SessionPdfIngestAdapterOptions = Readonly<{
  userDataDir: string;
  notesRootDir: string;
  importer: SessionPdfImportService;
  now?: () => string;
}>;

export class SessionPdfIngestAdapter implements PdfIngestPort {
  private readonly statePath: string;
  private readonly now: () => string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SessionPdfIngestAdapterOptions) {
    this.statePath = join(options.userDataDir, "network-pdf-uploads.json");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  acceptPdf(input: IngestPdfArgs): Promise<IngestPdfResult> {
    return this.serial(() => this.acceptPdfSerial(input));
  }

  private async acceptPdfSerial(input: IngestPdfArgs): Promise<IngestPdfResult> {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (input.sha256 && input.sha256.trim().toLowerCase() !== sha256) {
      throw new UploadError("SHA-256 mismatch", 422);
    }
    const state = await readState(this.statePath);
    const duplicate = state.uploads.find((entry) =>
      entry.result.notebookId === input.notebookId &&
      entry.result.sessionId === input.sessionId &&
      (
        entry.sha256 === sha256 ||
        (
          input.captureId !== undefined &&
          input.deviceId !== undefined &&
          entry.captureId === input.captureId &&
          entry.deviceId === input.deviceId
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
      const imported = await this.options.importer.importPdf({
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        fileName: input.originalName,
        bytes: input.bytes,
        baseRevision: manifest.revision
      });
      const result: IngestPdfResult = {
        materialType: "pdf",
        uploadId: `upload_${randomUUID()}`,
        duplicate: false,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        sourcePath: imported.assetPath,
        inboxPath: imported.assetPath,
        fileName: input.originalName || "document.pdf",
        byteLength: input.bytes.byteLength,
        pageCount: imported.pageCount,
        assetPath: imported.assetPath,
        pdfBlockId: imported.blockId,
        receivedAt: input.receivedAt || this.now()
      };
      await writeState(this.statePath, {
        version: 1,
        uploads: [...state.uploads, {
          version: 1 as const,
          sha256,
          captureId: input.captureId,
          deviceId: input.deviceId,
          result
        }].slice(-512)
      });
      return result;
    } catch (error) {
      if (error instanceof UploadError) throw error;
      if (error instanceof SessionPdfImportError) {
        throw new UploadError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readState(path: string): Promise<PdfUploadState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PdfUploadState;
    if (parsed.version !== 1 || !Array.isArray(parsed.uploads)) throw new Error("Invalid PDF upload state");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, uploads: [] };
    throw error;
  }
}

async function writeState(path: string, state: PdfUploadState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

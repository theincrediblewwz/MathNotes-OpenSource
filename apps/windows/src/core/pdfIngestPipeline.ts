import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type IngestPdfArgs,
  type IngestPdfResult,
  type PdfIngestPort,
  UploadError
} from "@mathnotes/core-server";
import type { BlockStore } from "./blockStore";
import { readPdfDocumentInfo } from "./pdfDocumentInfo";

export type { IngestPdfArgs, IngestPdfResult } from "@mathnotes/core-server";

type StoredPdfUpload = IngestPdfResult & {
  captureId?: string;
  deviceId?: string;
  sha256: string;
};

const locks = new Map<string, Promise<void>>();

export class PdfIngestPipeline implements PdfIngestPort {
  constructor(
    private readonly deps: {
      store: BlockStore;
      onIngested?: (result: IngestPdfResult) => void | Promise<void>;
    }
  ) {}

  async acceptPdf(args: IngestPdfArgs): Promise<IngestPdfResult> {
    if (args.mimeType !== "application/pdf") {
      throw new UploadError(`Unsupported PDF type: ${args.mimeType}`, 415);
    }
    const digest = sha256(args.bytes);
    if (args.sha256 && args.sha256 !== digest) {
      throw new UploadError("sha256 does not match uploaded bytes", 400);
    }
    const info = await readPdfDocumentInfo(args.bytes);
    const key = `${args.notebookId}/${args.sessionId}`;

    return withLock(key, async () => {
      const records = await this.readLog(args.notebookId, args.sessionId);
      const identity = records.find(
        (record) => record.captureId === args.captureId && record.deviceId === args.deviceId && Boolean(args.captureId && args.deviceId)
      );
      if (identity && identity.sha256 !== digest) {
        throw new UploadError("capture identity already exists with different bytes", 409);
      }
      const duplicate = identity ?? records.find((record) => record.sha256 === digest);
      if (duplicate) {
        const result = publicResult(duplicate, true);
        await this.deps.onIngested?.(result);
        return result;
      }

      const sessionDir = this.deps.store.getSessionDir(args.notebookId, args.sessionId);
      const safeName = sanitizePdfName(args.originalName);
      const inboxPath = `inbox/pdfs/${digest.slice(0, 12)}_${safeName}`;
      const sourcePath = join(sessionDir, ...inboxPath.split("/"));
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, args.bytes);

      const record: StoredPdfUpload = {
        materialType: "pdf",
        uploadId: `pdf_${digest.slice(0, 16)}`,
        duplicate: false,
        notebookId: args.notebookId,
        sessionId: args.sessionId,
        sourcePath,
        inboxPath,
        fileName: safeName,
        byteLength: args.bytes.byteLength,
        pageCount: info.pageCount,
        receivedAt: args.receivedAt,
        captureId: args.captureId,
        deviceId: args.deviceId,
        sha256: digest
      };
      records.push(record);
      await this.writeLog(args.notebookId, args.sessionId, records);
      const result = publicResult(record, false);
      await this.deps.onIngested?.(result);
      return result;
    });
  }

  private logPath(notebookId: string, sessionId: string): string {
    return join(this.deps.store.getSessionDir(notebookId, sessionId), "logs", "pdf_uploads.json");
  }

  private async readLog(notebookId: string, sessionId: string): Promise<StoredPdfUpload[]> {
    try {
      return JSON.parse(await readFile(this.logPath(notebookId, sessionId), "utf8")) as StoredPdfUpload[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeLog(notebookId: string, sessionId: string, records: StoredPdfUpload[]): Promise<void> {
    const target = this.logPath(notebookId, sessionId);
    const temporary = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }
}

function publicResult(record: StoredPdfUpload, duplicate: boolean): IngestPdfResult {
  const { captureId: _captureId, deviceId: _deviceId, sha256: _sha256, ...result } = record;
  return { ...result, duplicate };
}

function sanitizePdfName(value: string): string {
  const base = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "document.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

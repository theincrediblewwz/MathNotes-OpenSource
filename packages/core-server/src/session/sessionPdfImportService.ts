import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { createBlockRef, type SessionRecord } from "@mathnotes/shared";
import { readReadonlySessionManifest, type ReadonlySessionManifest } from "./sessionReadService";
import { sessionManifestRevision } from "./sessionRevision";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";

export const MAX_LOCAL_PDF_BYTES = 100 * 1024 * 1024;

export type ImportSessionPdfInput = Readonly<{
  notebookId: string;
  sessionId: string;
  fileName: string;
  bytes: Buffer;
  baseRevision: string;
}>;

export type ImportSessionPdfResult = Readonly<{
  version: 1;
  imported: true;
  blockId: string;
  assetPath: string;
  pageCount: number;
  manifest: ReadonlySessionManifest;
}>;

export class SessionPdfImportError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "invalid_session"
      | "path_outside_session"
      | "revision_conflict"
      | "empty_pdf"
      | "pdf_too_large"
      | "unsupported_pdf",
    readonly statusCode: number
  ) {
    super(code);
    this.name = "SessionPdfImportError";
  }
}

export class SessionPdfImportService {
  constructor(
    private readonly rootDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly coordinator = new SessionWriteCoordinator()
  ) {}

  importPdf(input: ImportSessionPdfInput): Promise<ImportSessionPdfResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.importPdfSerial(input));
  }

  private async importPdfSerial(input: ImportSessionPdfInput): Promise<ImportSessionPdfResult> {
    if (input.bytes.byteLength === 0) throw new SessionPdfImportError("empty_pdf", 400);
    if (input.bytes.byteLength > MAX_LOCAL_PDF_BYTES) throw new SessionPdfImportError("pdf_too_large", 413);
    if (!isPdf(input.bytes)) throw new SessionPdfImportError("unsupported_pdf", 415);

    const { session, sessionDir, sessionPath } = await readSession(
      this.rootDir,
      input.notebookId,
      input.sessionId
    );
    if (input.baseRevision !== sessionManifestRevision(session)) {
      throw new SessionPdfImportError("revision_conflict", 409);
    }

    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const safeStem = sanitizeStem(input.fileName);
    const relativePath = `assets/pdfs/${hash.slice(0, 12)}_${safeStem}.pdf`;
    const assetPath = resolve(sessionDir, relativePath);
    assertInside(resolve(sessionDir, "assets"), assetPath);
    const assetAlreadyExists = await exists(assetPath);
    if (!assetAlreadyExists) await writeAtomically(assetPath, input.bytes);

    const timestamp = this.now();
    const pageCount = countPdfPages(input.bytes);
    const block = createBlockRef({
      id: nextBlockId(session),
      type: "pdf",
      path: relativePath,
      source: "pdf_import",
      sourceName: basename(input.fileName) || "document.pdf",
      pageCount,
      renderInNote: true,
      createdAt: timestamp
    });
    const nextSession: SessionRecord = {
      ...session,
      updatedAt: timestamp,
      blocks: [...session.blocks, block]
    };
    try {
      await writeAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
    } catch (error) {
      if (!assetAlreadyExists) await rm(assetPath, { force: true });
      throw error;
    }
    return {
      version: 1,
      imported: true,
      blockId: block.id,
      assetPath: relativePath,
      pageCount,
      manifest: await readReadonlySessionManifest({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId
      })
    };
  }
}

function isPdf(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.toString("ascii", 0, 5) === "%PDF-";
}

export function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString("latin1");
  return [...text.matchAll(/\/Type\s*\/Page(?!s)\b/g)].length;
}

async function readSession(rootDir: string, notebookId: string, sessionId: string) {
  const notebooksDir = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
  assertInside(notebooksDir, sessionDir);
  const sessionPath = resolve(sessionDir, "session.json");
  try {
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks) || !Array.isArray(session.locks)) {
      throw new SessionPdfImportError("invalid_session", 422);
    }
    return { session, sessionDir, sessionPath };
  } catch (error) {
    if (error instanceof SessionPdfImportError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionPdfImportError("session_not_found", 404);
    }
    if (error instanceof SyntaxError) throw new SessionPdfImportError("invalid_session", 422);
    throw error;
  }
}

function nextBlockId(session: SessionRecord): string {
  const max = session.blocks.reduce((current, block) => {
    const value = Number.parseInt(block.id, 10);
    return Number.isFinite(value) ? Math.max(current, value) : current;
  }, 0);
  return String(max + 1).padStart(4, "0");
}

function sanitizeStem(fileName: string): string {
  const raw = basename(fileName).replace(extname(fileName), "").trim();
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "document";
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new SessionPdfImportError("path_outside_session", 400);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomically(target: string, content: string | Buffer): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

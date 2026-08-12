import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { createBlockRef, type SessionRecord } from "@mathnotes/shared";
import { readReadonlySessionManifest, type ReadonlySessionManifest } from "./sessionReadService";
import { sessionManifestRevision } from "./sessionRevision";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";

export const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

export type ImportSessionImageInput = Readonly<{
  notebookId: string;
  sessionId: string;
  fileName: string;
  bytes: Buffer;
  baseRevision: string;
}>;

export type ImportSessionImageResult = Readonly<{
  version: 1;
  imported: true;
  blockId: string;
  manifest: ReadonlySessionManifest;
}>;

export class SessionImageImportError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "invalid_session"
      | "path_outside_session"
      | "revision_conflict"
      | "empty_image"
      | "image_too_large"
      | "unsupported_image",
    readonly statusCode: number
  ) {
    super(code);
    this.name = "SessionImageImportError";
  }
}

export class SessionImageImportService {
  constructor(
    private readonly rootDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly coordinator = new SessionWriteCoordinator()
  ) {}

  importImage(input: ImportSessionImageInput): Promise<ImportSessionImageResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.importImageSerial(input));
  }

  private async importImageSerial(input: ImportSessionImageInput): Promise<ImportSessionImageResult> {
    if (input.bytes.byteLength === 0) throw new SessionImageImportError("empty_image", 400);
    if (input.bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) throw new SessionImageImportError("image_too_large", 413);
    const image = detectImage(input.bytes);
    if (!image) throw new SessionImageImportError("unsupported_image", 415);

    const { session, sessionDir, sessionPath } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    if (input.baseRevision !== sessionManifestRevision(session)) {
      throw new SessionImageImportError("revision_conflict", 409);
    }

    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const safeStem = sanitizeStem(input.fileName);
    const relativePath = `assets/photos/${hash.slice(0, 12)}_${safeStem}.${image.extension}`;
    const assetPath = resolve(sessionDir, relativePath);
    assertInside(resolve(sessionDir, "assets"), assetPath);
    const assetAlreadyExists = await exists(assetPath);
    if (!assetAlreadyExists) await writeBytesAtomically(assetPath, input.bytes);

    const timestamp = this.now();
    const block = createBlockRef({
      id: nextBlockId(session),
      type: "image",
      path: relativePath,
      source: "user",
      sourceName: basename(input.fileName) || `image.${image.extension}`,
      renderInNote: true,
      createdAt: timestamp
    });
    const nextSession: SessionRecord = {
      ...session,
      updatedAt: timestamp,
      blocks: [...session.blocks, block]
    };
    try {
      await writeTextAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
    } catch (error) {
      if (!assetAlreadyExists) await rm(assetPath, { force: true });
      throw error;
    }
    return {
      version: 1,
      imported: true,
      blockId: block.id,
      manifest: await readReadonlySessionManifest({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId
      })
    };
  }
}

function detectImage(bytes: Buffer): { mimeType: "image/png" | "image/jpeg" | "image/webp"; extension: "png" | "jpg" | "webp" } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

async function readSession(rootDir: string, notebookId: string, sessionId: string) {
  const notebooksDir = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
  assertInside(notebooksDir, sessionDir);
  const sessionPath = resolve(sessionDir, "session.json");
  try {
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks) || !Array.isArray(session.locks)) {
      throw new SessionImageImportError("invalid_session", 422);
    }
    return { session, sessionDir, sessionPath };
  } catch (error) {
    if (error instanceof SessionImageImportError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionImageImportError("session_not_found", 404);
    if (error instanceof SyntaxError) throw new SessionImageImportError("invalid_session", 422);
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
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "image";
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new SessionImageImportError("path_outside_session", 400);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeBytesAtomically(target: string, bytes: Buffer): Promise<void> {
  await writeAtomically(target, bytes);
}

async function writeTextAtomically(target: string, text: string): Promise<void> {
  await writeAtomically(target, text);
}

async function writeAtomically(target: string, content: string | Buffer): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temp, content);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import {
  assertValidImageTransformSidecar,
  createBlockRef,
  normalizeImageTransformOperations,
  type ImageAnnotationObject,
  type ImageTransformOperation,
  type ImageTransformSidecar,
  type SessionRecord
} from "@mathnotes/shared";
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

export type ImportSessionEditedImageInput = Readonly<{
  notebookId: string;
  sessionId: string;
  fileName: string;
  sourceBytes: Buffer;
  outputPngBytes: Buffer;
  baseRevision: string;
  operations: ImageTransformOperation[];
  annotations?: ImageAnnotationObject[];
}>;

export type ImportSessionEditedImageResult = Readonly<{
  version: 1;
  imported: true;
  edited: true;
  blockId: string;
  sourceAssetPath: string;
  assetPath: string;
  metadataPath: string;
  sourceSha256: string;
  outputSha256: string;
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
      | "unsupported_image"
      | "invalid_image_edit"
      | "asset_conflict",
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

  importEditedImage(input: ImportSessionEditedImageInput): Promise<ImportSessionEditedImageResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.importEditedImageSerial(input));
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

  private async importEditedImageSerial(
    input: ImportSessionEditedImageInput
  ): Promise<ImportSessionEditedImageResult> {
    validateImageSize(input.sourceBytes);
    validateImageSize(input.outputPngBytes);
    const sourceImage = detectImage(input.sourceBytes);
    if (!sourceImage) throw new SessionImageImportError("unsupported_image", 415);
    const outputImage = detectImage(input.outputPngBytes);
    if (outputImage?.mimeType !== "image/png") {
      throw new SessionImageImportError("invalid_image_edit", 400);
    }

    const { session, sessionDir, sessionPath } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    if (input.baseRevision !== sessionManifestRevision(session)) {
      throw new SessionImageImportError("revision_conflict", 409);
    }

    const sourceSha256 = sha256(input.sourceBytes);
    const outputSha256 = sha256(input.outputPngBytes);
    const safeStem = sanitizeStem(input.fileName);
    const sourceAssetPath = `assets/photos/${sourceSha256.slice(0, 12)}_${safeStem}.${sourceImage.extension}`;
    const normalizedEdit = normalizeImageEdit(input.operations, input.annotations);
    const editSha256 = sha256(Buffer.from(JSON.stringify(normalizedEdit), "utf8"));
    const derivedStem = `${sourceSha256.slice(0, 12)}_${outputSha256.slice(0, 12)}_${editSha256.slice(0, 12)}_${safeStem}`;
    const assetPath = `assets/embedded/${derivedStem}.png`;
    const metadataPath = `assets/embedded/${derivedStem}.annotation.json`;
    const sidecar: ImageTransformSidecar = {
      version: 1,
      sourceAsset: sourceAssetPath,
      sourceSha256,
      outputAsset: assetPath,
      outputMimeType: "image/png",
      operations: normalizedEdit.operations,
      ...(normalizedEdit.annotations.length ? { annotations: normalizedEdit.annotations } : {}),
      createdAt: this.now()
    };
    try {
      assertValidImageTransformSidecar(sidecar);
    } catch {
      throw new SessionImageImportError("invalid_image_edit", 400);
    }

    const absoluteSourcePath = resolve(sessionDir, sourceAssetPath);
    const absoluteAssetPath = resolve(sessionDir, assetPath);
    const absoluteMetadataPath = resolve(sessionDir, metadataPath);
    const assetsRoot = resolve(sessionDir, "assets");
    assertInside(assetsRoot, absoluteSourcePath);
    assertInside(assetsRoot, absoluteAssetPath);
    assertInside(assetsRoot, absoluteMetadataPath);

    const createdPaths: string[] = [];
    let manifestCommitted = false;
    try {
      if (await writeContentAddressedFile(absoluteSourcePath, input.sourceBytes)) createdPaths.push(absoluteSourcePath);
      if (await writeContentAddressedFile(absoluteAssetPath, input.outputPngBytes)) createdPaths.push(absoluteAssetPath);
      const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
      if (await writeCompatibleSidecar(absoluteMetadataPath, sidecarBytes, sidecar)) createdPaths.push(absoluteMetadataPath);

      const timestamp = this.now();
      const block = createBlockRef({
        id: nextBlockId(session),
        type: "image",
        path: assetPath,
        source: "user",
        sourceName: basename(input.fileName) || `image.${sourceImage.extension}`,
        fromAssets: [sourceAssetPath],
        renderInNote: true,
        createdAt: timestamp
      });
      const nextSession: SessionRecord = {
        ...session,
        updatedAt: timestamp,
        blocks: [...session.blocks, block]
      };
      await writeTextAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
      manifestCommitted = true;
      return {
        version: 1,
        imported: true,
        edited: true,
        blockId: block.id,
        sourceAssetPath,
        assetPath,
        metadataPath,
        sourceSha256,
        outputSha256,
        manifest: await readReadonlySessionManifest({
          rootDir: this.rootDir,
          notebookId: input.notebookId,
          sessionId: input.sessionId
        })
      };
    } catch (error) {
      if (!manifestCommitted) await Promise.all(createdPaths.map((path) => rm(path, { force: true })));
      throw error;
    }
  }
}

function validateImageSize(bytes: Buffer): void {
  if (bytes.byteLength === 0) throw new SessionImageImportError("empty_image", 400);
  if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) throw new SessionImageImportError("image_too_large", 413);
}

function normalizeImageEdit(
  operations: ImageTransformOperation[],
  annotations: ImageAnnotationObject[] | undefined
): { operations: ImageTransformOperation[]; annotations: ImageAnnotationObject[] } {
  try {
    if (!Array.isArray(operations) || operations.length > 128) throw new Error("invalid operations");
    if (annotations !== undefined && (!Array.isArray(annotations) || annotations.length > 1_024)) {
      throw new Error("invalid annotations");
    }
    operations.forEach(validateImageEditOperationRuntime);
    (annotations ?? []).forEach(validateImageAnnotationRuntime);
    const annotationPoints = (annotations ?? []).reduce((count, annotation) => {
      if (!annotation || typeof annotation !== "object") return Number.POSITIVE_INFINITY;
      return count + (annotation.type === "pen" && Array.isArray(annotation.points) ? annotation.points.length : 2);
    }, 0);
    const operationPoints = operations.reduce((count, operation) => {
      if (!operation || typeof operation !== "object") return Number.POSITIVE_INFINITY;
      return count + (operation.type === "lasso" && Array.isArray(operation.points) ? operation.points.length : 0);
    }, 0);
    if (annotationPoints > 20_000 || operationPoints > 20_000) throw new Error("too many points");
    return {
      operations: normalizeImageTransformOperations(operations),
      annotations: annotations ?? []
    };
  } catch {
    throw new SessionImageImportError("invalid_image_edit", 400);
  }
}

function validateImageEditOperationRuntime(operation: ImageTransformOperation): void {
  if (!operation || typeof operation !== "object") throw new Error("invalid operation");
  if (operation.type === "rotate") {
    if (operation.quarterTurns !== 1 && operation.quarterTurns !== 2 && operation.quarterTurns !== 3) {
      throw new Error("invalid rotation");
    }
    return;
  }
  if (operation.type === "perspective") {
    if (!Array.isArray(operation.corners) || operation.corners.length !== 4) throw new Error("invalid perspective");
    operation.corners.forEach(validateNormalizedPointRuntime);
    return;
  }
  if (operation.type === "crop") {
    validateNormalizedRectRuntime(operation.rect);
    if (operation.rect.width <= 0 || operation.rect.height <= 0) throw new Error("invalid crop");
    return;
  }
  if (operation.type === "lasso") {
    if (!Array.isArray(operation.points) || operation.points.length < 3 || operation.points.length > 20_000) {
      throw new Error("invalid lasso");
    }
    operation.points.forEach(validateNormalizedPointRuntime);
    validateNormalizedRectRuntime(operation.boundingBox);
    if (operation.outsideFill !== "#ffffff") throw new Error("invalid lasso fill");
    return;
  }
  throw new Error("invalid operation type");
}

function validateImageAnnotationRuntime(annotation: ImageAnnotationObject): void {
  if (!annotation || typeof annotation !== "object" || (annotation.type !== "pen" && annotation.type !== "arrow")) {
    throw new Error("invalid annotation");
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(annotation.id) || !/^#[0-9a-f]{6}$/i.test(annotation.color) ||
      !Number.isFinite(annotation.width) || annotation.width < 0.001 || annotation.width > 0.1) {
    throw new Error("invalid annotation metadata");
  }
  if (annotation.type === "pen") {
    if (!Array.isArray(annotation.points) || annotation.points.length < 2) throw new Error("invalid pen");
    annotation.points.forEach(validateNormalizedPointRuntime);
  } else {
    validateNormalizedPointRuntime(annotation.start);
    validateNormalizedPointRuntime(annotation.end);
    if (Math.hypot(annotation.end.x - annotation.start.x, annotation.end.y - annotation.start.y) < 0.002) {
      throw new Error("invalid arrow");
    }
  }
}

function validateNormalizedPointRuntime(point: { x: number; y: number }): void {
  if (!point || typeof point !== "object" || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error("invalid normalized point");
  }
}

function validateNormalizedRectRuntime(rect: { x: number; y: number; width: number; height: number }): void {
  validateNormalizedPointRuntime(rect);
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 0 || rect.height < 0 ||
      rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    throw new Error("invalid normalized rectangle");
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

async function writeContentAddressedFile(target: string, bytes: Buffer): Promise<boolean> {
  if (await exists(target)) {
    if (!(await readFile(target)).equals(bytes)) throw new SessionImageImportError("asset_conflict", 409);
    return false;
  }
  await writeBytesAtomically(target, bytes);
  return true;
}

async function writeCompatibleSidecar(
  target: string,
  bytes: Buffer,
  expected: ImageTransformSidecar
): Promise<boolean> {
  if (!(await exists(target))) {
    await writeBytesAtomically(target, bytes);
    return true;
  }
  try {
    const current = JSON.parse(await readFile(target, "utf8")) as ImageTransformSidecar;
    assertValidImageTransformSidecar(current);
    const stable = (sidecar: ImageTransformSidecar) => ({
      ...sidecar,
      createdAt: undefined
    });
    if (JSON.stringify(stable(current)) !== JSON.stringify(stable(expected))) {
      throw new Error("metadata mismatch");
    }
    return false;
  } catch {
    throw new SessionImageImportError("asset_conflict", 409);
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

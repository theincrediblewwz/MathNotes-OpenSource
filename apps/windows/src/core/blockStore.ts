import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type ImageTransformSidecar,
  type BlockRef,
  type BlockSource,
  type LockMeta,
  type SessionRecord,
  createBlockRef,
  createSessionRecord
} from "@mathnotes/shared";
import { parseProtectedSpans, sha256Text } from "../common/lockSpan";
import { validateAiMarkdownUpdate } from "../common/lockValidation";

export type CreateSessionArgs = {
  notebookId: string;
  sessionId: string;
  title: string;
  now: string;
};

export type AppendImageBlockArgs = {
  notebookId: string;
  sessionId: string;
  assetPath: string;
  insertAfterBlockId?: string;
  now: string;
};

export type AppendPdfBlockArgs = {
  notebookId: string;
  sessionId: string;
  assetPath: string;
  sourceName: string;
  pageCount: number;
  renderInNote?: boolean;
  insertAfterBlockId?: string;
  now: string;
};

export type AppendMarkdownBlockArgs = {
  notebookId: string;
  sessionId: string;
  source: Extract<BlockSource, "ai_transcription" | "ai_explanation" | "user" | "user_revision" | "mixed">;
  markdown: string;
  sourceName?: string;
  fromAssets?: string[];
  sourcePageNumber?: number;
  sourcePageImagePath?: string;
  insertAfterBlockId?: string;
  now: string;
};

export type SavePhotoAssetArgs = {
  notebookId: string;
  sessionId: string;
  fileName: string;
  bytes: Buffer;
};

export type SaveEmbeddedAssetArgs = SavePhotoAssetArgs;

export type SavePdfAssetArgs = SavePhotoAssetArgs;

export type SavePdfPageAssetArgs = SavePhotoAssetArgs & {
  pdfBlockId: string;
  pageNumber: number;
};

export type AnnotatedImageMetadata = Omit<ImageTransformSidecar, "outputAsset">;

export type SaveAnnotatedImageAssetArgs = {
  notebookId: string;
  sessionId: string;
  fileName: string;
  pngBytes: Buffer;
  metadata: AnnotatedImageMetadata;
};

export type UpdateMarkdownBlockArgs = {
  notebookId: string;
  sessionId: string;
  blockId: string;
  markdown: string;
  now: string;
};

export type UpdateMarkdownBlockFromAiArgs = UpdateMarkdownBlockArgs;

export type UpdateMarkdownBlocksArgs = {
  notebookId: string;
  sessionId: string;
  updates: Array<{
    blockId: string;
    markdown: string;
  }>;
  now: string;
};

export type SetMarkdownBlockLockArgs = {
  notebookId: string;
  sessionId: string;
  blockId: string;
  locked: boolean;
  now: string;
};

export type DeleteMarkdownBlockArgs = {
  notebookId: string;
  sessionId: string;
  blockId: string;
  now: string;
};

export type DeletedMarkdownBlockSnapshot = BlockRef & {
  block: BlockRef;
  index: number;
  markdown: string;
  locks: LockMeta[];
};

export type RestoreDeletedMarkdownBlockArgs = {
  notebookId: string;
  sessionId: string;
  snapshot: DeletedMarkdownBlockSnapshot;
  now: string;
};

export class BlockStore {
  constructor(private readonly rootDir: string) {}

  async createSession(args: CreateSessionArgs): Promise<SessionRecord> {
    const sessionDir = this.sessionDir(args.notebookId, args.sessionId);
    await Promise.all([
      mkdir(join(sessionDir, "blocks"), { recursive: true }),
      mkdir(join(sessionDir, "assets", "photos"), { recursive: true }),
      mkdir(join(sessionDir, "assets", "embedded"), { recursive: true }),
      mkdir(join(sessionDir, "assets", "pdfs"), { recursive: true }),
      mkdir(join(sessionDir, "assets", "pdf-pages"), { recursive: true }),
      mkdir(join(sessionDir, "exports"), { recursive: true }),
      mkdir(join(sessionDir, "logs"), { recursive: true })
    ]);

    const session = createSessionRecord({
      id: args.sessionId,
      title: args.title,
      createdAt: args.now
    });
    await this.writeSession(args.notebookId, args.sessionId, session);
    return session;
  }

  async readSession(notebookId: string, sessionId: string): Promise<SessionRecord> {
    const content = await readFile(this.sessionPath(notebookId, sessionId), "utf8");
    return JSON.parse(content) as SessionRecord;
  }

  async appendImageBlock(args: AppendImageBlockArgs): Promise<BlockRef> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const block = createBlockRef({
      id: nextBlockId(session),
      type: "image",
      path: args.assetPath,
      source: "android_camera",
      createdAt: args.now
    });

    insertBlock(session, block, args.insertAfterBlockId);
    session.updatedAt = args.now;
    await this.writeSession(args.notebookId, args.sessionId, session);
    return block;
  }

  async appendPdfBlock(args: AppendPdfBlockArgs): Promise<BlockRef> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const block = createBlockRef({
      id: nextBlockId(session),
      type: "pdf",
      path: args.assetPath,
      source: "pdf_import",
      sourceName: args.sourceName,
      pageCount: args.pageCount,
      renderInNote: args.renderInNote,
      createdAt: args.now
    });

    insertBlock(session, block, args.insertAfterBlockId);
    session.updatedAt = args.now;
    await this.writeSession(args.notebookId, args.sessionId, session);
    return block;
  }

  async appendMarkdownBlock(args: AppendMarkdownBlockArgs): Promise<BlockRef> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const id = nextBlockId(session);
    const path = `blocks/${id}_${markdownFileStem(args.source)}.md`;
    const absolutePath = join(this.sessionDir(args.notebookId, args.sessionId), path);

    await writeFileAtomically(absolutePath, args.markdown, "utf8");

    const block = createBlockRef({
      id,
      type: "markdown",
      path,
      source: args.source,
      sourceName: args.sourceName,
      fromAssets: args.fromAssets,
      sourcePageNumber: args.sourcePageNumber,
      sourcePageImagePath: args.sourcePageImagePath,
      createdAt: args.now
    });

    insertBlock(session, block, args.insertAfterBlockId);
    session.updatedAt = args.now;
    await this.writeSession(args.notebookId, args.sessionId, session);
    return block;
  }

  async updateMarkdownBlock(args: UpdateMarkdownBlockArgs): Promise<BlockRef> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const { block } = requireMarkdownBlock(session, args.blockId);

    const target = join(this.sessionDir(args.notebookId, args.sessionId), block.path);
    await writeFileAtomically(target, args.markdown, "utf8");

    block.updatedAt = args.now;
    session.updatedAt = args.now;
    session.locks = syncProtectedSpanLocks({
      blockId: block.id,
      existingLocks: session.locks,
      markdown: args.markdown,
      now: args.now
    });
    await this.writeSession(args.notebookId, args.sessionId, session);
    return block;
  }

  async updateMarkdownBlockFromAi(args: UpdateMarkdownBlockFromAiArgs): Promise<BlockRef> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const { block } = requireMarkdownBlock(session, args.blockId);

    const beforeMarkdown = await readFile(join(this.sessionDir(args.notebookId, args.sessionId), block.path), "utf8");
    const validation = await validateAiMarkdownUpdate({
      blockId: block.id,
      beforeMarkdown,
      afterMarkdown: args.markdown,
      locks: session.locks
    });

    if (!validation.ok) {
      throw new Error(`AI update rejected: ${validation.reason} ${validation.lockId}`);
    }

    return this.updateMarkdownBlock(args);
  }

  async updateMarkdownBlocks(args: UpdateMarkdownBlocksArgs): Promise<BlockRef[]> {
    const updated: BlockRef[] = [];
    const session = await this.readSession(args.notebookId, args.sessionId);
    const markdownBlockIds = new Set(session.blocks.filter((block) => block.type === "markdown").map((block) => block.id));

    for (const update of args.updates) {
      if (!markdownBlockIds.has(update.blockId)) {
        continue;
      }
      updated.push(
        await this.updateMarkdownBlock({
          notebookId: args.notebookId,
          sessionId: args.sessionId,
          blockId: update.blockId,
          markdown: update.markdown,
          now: args.now
        })
      );
    }

    return updated;
  }

  async setMarkdownBlockLock(args: SetMarkdownBlockLockArgs): Promise<BlockRef> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const { block } = requireMarkdownBlock(session, args.blockId);

    const lockId = blockLockId(block.id);
    const locksWithoutCurrentBlockLock = session.locks.filter(
      (lock) => !(lock.blockId === block.id && lock.kind === "block")
    );

    if (args.locked) {
      const markdown = await readFile(join(this.sessionDir(args.notebookId, args.sessionId), block.path), "utf8");
      session.locks = [
        ...locksWithoutCurrentBlockLock,
        {
          id: lockId,
          blockId: block.id,
          kind: "block",
          contentHash: await sha256Text(markdown),
          createdAt: args.now,
          createdBy: "user",
          aiEditable: false
        }
      ];
      block.status = "locked";
      block.editableByAi = false;
    } else {
      session.locks = locksWithoutCurrentBlockLock;
      block.status = "draft";
      block.editableByAi = block.source === "ai_transcription";
    }

    block.updatedAt = args.now;
    session.updatedAt = args.now;
    await this.writeSession(args.notebookId, args.sessionId, session);
    return block;
  }

  async deleteMarkdownBlock(args: DeleteMarkdownBlockArgs): Promise<DeletedMarkdownBlockSnapshot> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const { block, index } = requireMarkdownBlock(session, args.blockId);
    const markdown = await readFile(join(this.sessionDir(args.notebookId, args.sessionId), block.path), "utf8");
    const locks = session.locks.filter((lock) => lock.blockId === block.id);

    session.blocks.splice(index, 1);
    session.locks = session.locks.filter((lock) => lock.blockId !== block.id);
    session.updatedAt = args.now;
    await this.writeSession(args.notebookId, args.sessionId, session);
    await rm(join(this.sessionDir(args.notebookId, args.sessionId), block.path), { force: true });
    return { ...block, block, index, markdown, locks };
  }

  async restoreDeletedMarkdownBlock(args: RestoreDeletedMarkdownBlockArgs): Promise<BlockRef> {
    const session = await this.readSession(args.notebookId, args.sessionId);
    const block = { ...args.snapshot.block, updatedAt: args.now };

    if (session.blocks.some((candidate) => candidate.id === block.id)) {
      throw new Error(`Block ${block.id} already exists`);
    }

    const target = join(this.sessionDir(args.notebookId, args.sessionId), block.path);
    await writeFileAtomically(target, args.snapshot.markdown, "utf8");

    const index = Math.max(0, Math.min(args.snapshot.index, session.blocks.length));
    session.blocks.splice(index, 0, block);
    session.locks = [
      ...session.locks.filter((lock) => lock.blockId !== block.id),
      ...args.snapshot.locks
    ];
    session.updatedAt = args.now;
    await this.writeSession(args.notebookId, args.sessionId, session);
    return block;
  }

  async savePhotoAsset(args: SavePhotoAssetArgs): Promise<{ relativePath: string; absolutePath: string }> {
    const safeName = sanitizeAssetFileName(args.fileName);
    const relativePath = `assets/photos/${safeName}`;
    const absolutePath = join(this.getSessionDir(args.notebookId, args.sessionId), relativePath);

    await writeFileAtomically(absolutePath, args.bytes);

    return { relativePath, absolutePath };
  }

  async saveEmbeddedAsset(args: SaveEmbeddedAssetArgs): Promise<{ relativePath: string; absolutePath: string }> {
    const safeName = sanitizeAssetFileName(args.fileName);
    const relativePath = `assets/embedded/${safeName}`;
    const absolutePath = join(this.getSessionDir(args.notebookId, args.sessionId), relativePath);

    await writeFileAtomically(absolutePath, args.bytes);

    return { relativePath, absolutePath };
  }

  async readMarkdownBlock(notebookId: string, sessionId: string, blockId: string): Promise<string> {
    const session = await this.readSession(notebookId, sessionId);
    const { block } = requireMarkdownBlock(session, blockId);
    return readFile(join(this.sessionDir(notebookId, sessionId), block.path), "utf8");
  }

  async savePdfAsset(args: SavePdfAssetArgs): Promise<{ relativePath: string; absolutePath: string }> {
    const safeName = sanitizeAssetFileName(args.fileName).replace(/\.pdf$/i, "") + ".pdf";
    const relativePath = `assets/pdfs/${safeName}`;
    const absolutePath = join(this.getSessionDir(args.notebookId, args.sessionId), relativePath);

    await writeFileAtomically(absolutePath, args.bytes);

    return { relativePath, absolutePath };
  }

  async savePhotoAnnotation(
    notebookId: string,
    sessionId: string,
    photoRelativePath: string,
    metadata: ImageTransformSidecar
  ): Promise<{ relativePath: string; absolutePath: string }> {
    const relativePath = photoRelativePath.replace(/\.[^.]+$/, ".annotation.json");
    const absolutePath = join(this.getSessionDir(notebookId, sessionId), relativePath);
    await writeFileAtomically(absolutePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return { relativePath, absolutePath };
  }

  async savePdfPageAsset(args: SavePdfPageAssetArgs): Promise<{ relativePath: string; absolutePath: string }> {
    const blockDir = sanitizeAssetFileName(args.pdfBlockId).replace(/\.[^.]+$/, "");
    const pageName = `page-${String(args.pageNumber).padStart(4, "0")}.png`;
    const relativePath = `assets/pdf-pages/${blockDir}/${pageName}`;
    const absolutePath = join(this.getSessionDir(args.notebookId, args.sessionId), relativePath);

    await writeFileAtomically(absolutePath, args.bytes);
    return { relativePath, absolutePath };
  }

  async saveAnnotatedImageAsset(args: SaveAnnotatedImageAssetArgs): Promise<{
    relativePath: string;
    absolutePath: string;
    metadataRelativePath: string;
    metadataAbsolutePath: string;
  }> {
    const safeName = toPngAssetFileName(sanitizeAssetFileName(args.fileName));
    const relativePath = `assets/embedded/${safeName}`;
    const absolutePath = join(this.getSessionDir(args.notebookId, args.sessionId), relativePath);
    const metadataRelativePath = `assets/embedded/${safeName.replace(/\.png$/i, ".annotation.json")}`;
    const metadataAbsolutePath = join(this.getSessionDir(args.notebookId, args.sessionId), metadataRelativePath);

    await writeFileAtomically(absolutePath, args.pngBytes);
    await writeFileAtomically(
      metadataAbsolutePath,
      JSON.stringify(
        {
          ...args.metadata,
          outputAsset: relativePath
        },
        null,
        2
      ),
      "utf8"
    );

    return { relativePath, absolutePath, metadataRelativePath, metadataAbsolutePath };
  }

  getSessionDir(notebookId: string, sessionId: string): string {
    return this.sessionDir(notebookId, sessionId);
  }

  getRootDir(): string {
    return this.rootDir;
  }

  private async writeSession(notebookId: string, sessionId: string, session: SessionRecord): Promise<void> {
    const target = this.sessionPath(notebookId, sessionId);
    await writeFileAtomically(target, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  private sessionDir(notebookId: string, sessionId: string): string {
    return join(this.rootDir, "notebooks", notebookId, "sessions", sessionId);
  }

  private sessionPath(notebookId: string, sessionId: string): string {
    return join(this.sessionDir(notebookId, sessionId), "session.json");
  }
}

function nextBlockId(session: SessionRecord): string {
  const maxNumericId = session.blocks.reduce((max, block) => {
    const numeric = Number.parseInt(block.id, 10);
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
  }, 0);
  return String(maxNumericId + 1).padStart(4, "0");
}

function insertBlock(session: SessionRecord, block: BlockRef, insertAfterBlockId: string | undefined): void {
  if (!insertAfterBlockId) {
    session.blocks.push(block);
    return;
  }

  const index = session.blocks.findIndex((candidate) => candidate.id === insertAfterBlockId);
  if (index === -1) {
    session.blocks.push(block);
    return;
  }

  session.blocks.splice(index + 1, 0, block);
}

function requireMarkdownBlock(session: SessionRecord, blockId: string): { block: BlockRef; index: number } {
  const candidates = session.blocks
    .map((block, index) => ({ block, index }))
    .filter((candidate) => candidate.block.id === blockId);
  const markdown = candidates.find((candidate) => candidate.block.type === "markdown");

  if (markdown) {
    return markdown;
  }
  if (candidates.length > 0) {
    throw new Error(`Block ${blockId} is not a markdown block`);
  }
  throw new Error(`Block ${blockId} not found`);
}

function markdownFileStem(source: AppendMarkdownBlockArgs["source"]): string {
  switch (source) {
    case "ai_transcription":
      return "ai_transcript";
    case "ai_explanation":
      return "ai_explanation";
    case "user_revision":
      return "user_revision";
    case "mixed":
      return "mixed";
    case "user":
      return "user_note";
  }
}

function sanitizeAssetFileName(fileName: string): string {
  const name = basename(fileName).trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return name || "upload.bin";
}

function toPngAssetFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  return `${withoutExtension || "annotated_image"}.png`;
}

function blockLockId(blockId: string): string {
  return `lock_block_${blockId}`;
}

async function writeFileAtomically(target: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(tmp, data, encoding ? { encoding } : undefined);
    await renameWithRetry(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt === attempts - 1) {
        throw error;
      }
      await delay(35 * (attempt + 1));
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return ["EPERM", "EACCES", "EBUSY"].includes(String((error as { code?: unknown }).code));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syncProtectedSpanLocks(args: {
  blockId: string;
  existingLocks: LockMeta[];
  markdown: string;
  now: string;
}): LockMeta[] {
  const locksForOtherBlocks = args.existingLocks.filter((lock) => lock.blockId !== args.blockId || lock.kind !== "span");
  const spanLocks = parseProtectedSpans(args.markdown).map(
    (span): LockMeta => ({
      id: span.id,
      blockId: args.blockId,
      kind: "span",
      contentHash: span.hash,
      createdAt: args.now,
      createdBy: "user",
      aiEditable: false
    })
  );

  return [...locksForOtherBlocks, ...spanLocks];
}

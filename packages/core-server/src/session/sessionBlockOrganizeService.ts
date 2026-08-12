import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, posix, resolve, sep } from "node:path";
import type { BlockRef, LockMeta, SessionRecord } from "@mathnotes/shared";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";

export type ReorderSessionBlocksInput = Readonly<{
  notebookId: string;
  sessionId: string;
  blockIds: readonly string[];
  direction: "up" | "down";
}>;

export type TransferSessionBlocksInput = Readonly<{
  sourceNotebookId: string;
  sourceSessionId: string;
  targetNotebookId: string;
  targetSessionId: string;
  blockIds: readonly string[];
  mode: "copy" | "move";
}>;

export type DeleteSessionBlocksInput = Readonly<{
  notebookId: string;
  sessionId: string;
  blockIds: readonly string[];
}>;

export type TransferSessionBlocksResult = Readonly<{
  version: 1;
  mode: "copy" | "move";
  copiedBlockIds: readonly string[];
  sourceCleanupPending: boolean;
}>;

export class SessionBlockOrganizeError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "session_not_found"
      | "invalid_session"
      | "block_not_found"
      | "block_locked"
      | "same_session"
      | "path_outside_session",
    readonly statusCode: number
  ) {
    super(code);
    this.name = "SessionBlockOrganizeError";
  }
}

export class SessionBlockOrganizeService {
  constructor(
    private readonly rootDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly coordinator = new SessionWriteCoordinator()
  ) {}

  reorder(input: ReorderSessionBlocksInput): Promise<SessionRecord> {
    return this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const stored = await readSession(this.rootDir, input.notebookId, input.sessionId);
      const selected = requireSelectedBlocks(stored.session, input.blockIds);
      if (selected.size === 0) throw new SessionBlockOrganizeError("invalid_input", 400);
      assertNoLockedBlocks(stored.session, selected);
      const blocks = [...stored.session.blocks];
      if (input.direction === "up") {
        for (let index = 1; index < blocks.length; index += 1) {
          if (selected.has(blocks[index].id) && !selected.has(blocks[index - 1].id)) {
            [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]];
          }
        }
      } else {
        for (let index = blocks.length - 2; index >= 0; index -= 1) {
          if (selected.has(blocks[index].id) && !selected.has(blocks[index + 1].id)) {
            [blocks[index], blocks[index + 1]] = [blocks[index + 1], blocks[index]];
          }
        }
      }
      const next = { ...stored.session, blocks, updatedAt: this.now() };
      await writeJsonAtomically(stored.sessionPath, next);
      return next;
    });
  }

  delete(input: DeleteSessionBlocksInput): Promise<SessionRecord> {
    return this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const stored = await readSession(this.rootDir, input.notebookId, input.sessionId);
      const selected = requireSelectedBlocks(stored.session, input.blockIds);
      if (selected.size === 0) throw new SessionBlockOrganizeError("invalid_input", 400);
      assertNoLockedBlocks(stored.session, selected);
      const selectedBlocks = stored.session.blocks.filter((block) => selected.has(block.id));
      const trashRoot = resolve(stored.sessionDir, ".mathnotes", "trash", randomUUID());
      const movedFiles: Array<{ source: string; trash: string }> = [];
      try {
        for (const block of selectedBlocks) {
          if (block.type !== "markdown") continue;
          const source = assertInside(stored.sessionDir, resolve(stored.sessionDir, block.path));
          const trash = assertInside(trashRoot, resolve(trashRoot, block.path));
          await mkdir(dirname(trash), { recursive: true });
          await rename(source, trash);
          movedFiles.push({ source, trash });
        }
        const next: SessionRecord = {
          ...stored.session,
          blocks: stored.session.blocks.filter((block) => !selected.has(block.id)),
          locks: stored.session.locks.filter((lock) => !selected.has(lock.blockId)),
          updatedAt: this.now()
        };
        await writeJsonAtomically(stored.sessionPath, next);
        return next;
      } catch (error) {
        for (const file of [...movedFiles].reverse()) {
          await mkdir(dirname(file.source), { recursive: true });
          await rename(file.trash, file.source).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  transfer(input: TransferSessionBlocksInput): Promise<TransferSessionBlocksResult> {
    if (
      input.sourceNotebookId === input.targetNotebookId &&
      input.sourceSessionId === input.targetSessionId
    ) {
      return Promise.reject(new SessionBlockOrganizeError("same_session", 409));
    }
    return this.coordinator.runMany([
      { notebookId: input.sourceNotebookId, sessionId: input.sourceSessionId },
      { notebookId: input.targetNotebookId, sessionId: input.targetSessionId }
    ], () => this.transferSerial(input));
  }

  private async transferSerial(input: TransferSessionBlocksInput): Promise<TransferSessionBlocksResult> {
    const source = await readSession(this.rootDir, input.sourceNotebookId, input.sourceSessionId);
    const target = await readSession(this.rootDir, input.targetNotebookId, input.targetSessionId);
    const selectedIds = requireSelectedBlocks(source.session, input.blockIds);
    if (selectedIds.size === 0) throw new SessionBlockOrganizeError("invalid_input", 400);
    if (input.mode === "move") assertNoLockedBlocks(source.session, selectedIds);
    const selectedBlocks = source.session.blocks.filter((block) => selectedIds.has(block.id));
    const timestamp = this.now();
    const transferId = randomUUID();
    const stagingDir = resolve(target.sessionDir, ".mathnotes", "transfers", transferId);
    const copiedPaths: string[] = [];
    const assetPathMap = new Map<string, string>();
    const copiedBlocks: BlockRef[] = [];
    let nextNumericId = maxNumericBlockId(target.session);

    try {
      for (const block of selectedBlocks) {
        const id = String(++nextNumericId).padStart(4, "0");
        const nextPath = await copyBlockFile({
          sourceSessionDir: source.sessionDir,
          targetSessionDir: target.sessionDir,
          stagingDir,
          block,
          id,
          copiedPaths
        });
        const fromAssets = await copyMetadataAssets(
          block.fromAssets,
          source.sessionDir,
          target.sessionDir,
          stagingDir,
          id,
          copiedPaths,
          assetPathMap
        );
        const sourcePageImagePath = block.sourcePageImagePath
          ? (await copyMetadataAssets(
              [block.sourcePageImagePath],
              source.sessionDir,
              target.sessionDir,
              stagingDir,
              id,
              copiedPaths,
              assetPathMap
            ))?.[0]
          : undefined;
        copiedBlocks.push({
          ...block,
          id,
          path: nextPath,
          fromAssets,
          sourcePageImagePath,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }

      await materializeStagedFiles(stagingDir, target.sessionDir, copiedPaths);
      const nextTarget: SessionRecord = {
        ...target.session,
        blocks: [...target.session.blocks, ...copiedBlocks],
        locks: [
          ...target.session.locks,
          ...copyLocks(source.session.locks, selectedIds, copiedBlocks, selectedBlocks, timestamp)
        ],
        updatedAt: timestamp
      };
      try {
        await writeJsonAtomically(target.sessionPath, nextTarget);
      } catch (error) {
        await Promise.all(copiedPaths.map((relativePath) => rm(resolve(target.sessionDir, relativePath), { force: true })));
        throw error;
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }

    let sourceCleanupPending = false;
    if (input.mode === "move") {
      const nextSource: SessionRecord = {
        ...source.session,
        blocks: source.session.blocks.filter((block) => !selectedIds.has(block.id)),
        locks: source.session.locks.filter((lock) => !selectedIds.has(lock.blockId)),
        updatedAt: timestamp
      };
      try {
        await writeJsonAtomically(source.sessionPath, nextSource);
        await Promise.all(selectedBlocks
          .filter((block) => block.type === "markdown")
          .map((block) => rm(assertInside(source.sessionDir, resolve(source.sessionDir, block.path)), { force: true })));
      } catch {
        sourceCleanupPending = true;
      }
    }

    return {
      version: 1,
      mode: input.mode,
      copiedBlockIds: copiedBlocks.map((block) => block.id),
      sourceCleanupPending
    };
  }
}

async function readSession(rootDir: string, notebookId: string, sessionId: string) {
  assertSafeId(notebookId);
  assertSafeId(sessionId);
  const sessionDir = resolve(rootDir, "notebooks", notebookId, "sessions", sessionId);
  assertInside(resolve(rootDir), sessionDir);
  const sessionPath = resolve(sessionDir, "session.json");
  let raw: string;
  try {
    raw = await readFile(sessionPath, "utf8");
  } catch {
    throw new SessionBlockOrganizeError("session_not_found", 404);
  }
  try {
    const session = JSON.parse(raw) as SessionRecord;
    if (!Array.isArray(session.blocks) || !Array.isArray(session.locks)) throw new Error("invalid");
    return { session, sessionDir, sessionPath };
  } catch {
    throw new SessionBlockOrganizeError("invalid_session", 422);
  }
}

function requireSelectedBlocks(session: SessionRecord, ids: readonly string[]): Set<string> {
  const selected = new Set(ids.map((id) => id.trim()).filter(Boolean));
  const existing = new Set(session.blocks.map((block) => block.id));
  for (const id of selected) {
    if (!existing.has(id)) throw new SessionBlockOrganizeError("block_not_found", 404);
  }
  return selected;
}

function assertNoLockedBlocks(session: SessionRecord, selectedIds: ReadonlySet<string>): void {
  if (session.locks.some((lock) => lock.kind === "block" && selectedIds.has(lock.blockId))) {
    throw new SessionBlockOrganizeError("block_locked", 423);
  }
}

function maxNumericBlockId(session: SessionRecord): number {
  return session.blocks.reduce((max, block) => {
    const value = Number.parseInt(block.id, 10);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
}

async function copyBlockFile(args: {
  sourceSessionDir: string;
  targetSessionDir: string;
  stagingDir: string;
  block: BlockRef;
  id: string;
  copiedPaths: string[];
}): Promise<string> {
  const sourcePath = assertInside(args.sourceSessionDir, resolve(args.sourceSessionDir, args.block.path));
  const extension = posix.extname(args.block.path) || (args.block.type === "markdown" ? ".md" : "");
  const folder = args.block.type === "markdown" ? "blocks" : posix.dirname(args.block.path.replaceAll("\\", "/"));
  const fileName = args.block.type === "markdown"
    ? `${args.id}_copied${extension}`
    : `${args.id}-${basename(args.block.path)}`;
  const relativePath = posix.join(folder === "." ? "assets" : folder, fileName);
  const stagedPath = resolve(args.stagingDir, relativePath);
  await mkdir(dirname(stagedPath), { recursive: true });
  await copyFile(sourcePath, stagedPath);
  args.copiedPaths.push(relativePath);
  return relativePath;
}

async function copyMetadataAssets(
  paths: readonly string[] | undefined,
  sourceSessionDir: string,
  targetSessionDir: string,
  stagingDir: string,
  blockId: string,
  copiedPaths: string[],
  assetPathMap: Map<string, string>
): Promise<string[] | undefined> {
  if (!paths?.length) return undefined;
  const result: string[] = [];
  for (const rawPath of paths) {
    const normalized = rawPath.replaceAll("\\", "/").replace(/^\.?\//, "");
    const existing = assetPathMap.get(normalized);
    if (existing) {
      result.push(existing);
      continue;
    }
    const sourcePath = assertInside(sourceSessionDir, resolve(sourceSessionDir, normalized));
    const folder = posix.dirname(normalized);
    const relativePath = posix.join(folder === "." ? "assets" : folder, `${blockId}-${basename(normalized)}`);
    assertInside(targetSessionDir, resolve(targetSessionDir, relativePath));
    const stagedPath = resolve(stagingDir, relativePath);
    await mkdir(dirname(stagedPath), { recursive: true });
    await copyFile(sourcePath, stagedPath);
    copiedPaths.push(relativePath);
    assetPathMap.set(normalized, relativePath);
    result.push(relativePath);
  }
  return result;
}

async function materializeStagedFiles(stagingDir: string, targetSessionDir: string, paths: readonly string[]) {
  for (const relativePath of paths) {
    const source = assertInside(stagingDir, resolve(stagingDir, relativePath));
    const target = assertInside(targetSessionDir, resolve(targetSessionDir, relativePath));
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }
}

function copyLocks(
  locks: readonly LockMeta[],
  selectedIds: ReadonlySet<string>,
  copiedBlocks: readonly BlockRef[],
  sourceBlocks: readonly BlockRef[],
  timestamp: string
): LockMeta[] {
  const idMap = new Map(sourceBlocks.map((block, index) => [block.id, copiedBlocks[index].id]));
  return locks
    .filter((lock) => selectedIds.has(lock.blockId))
    .map((lock) => {
      const blockId = idMap.get(lock.blockId)!;
      return {
        ...lock,
        id: lock.kind === "block" ? `lock_block_${blockId}` : lock.id,
        blockId,
        createdAt: timestamp
      };
    });
}

function assertSafeId(value: string) {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new SessionBlockOrganizeError("invalid_input", 400);
  }
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new SessionBlockOrganizeError("path_outside_session", 422);
  }
  return resolvedCandidate;
}

async function writeJsonAtomically(path: string, value: SessionRecord) {
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

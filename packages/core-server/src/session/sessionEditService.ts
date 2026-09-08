import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  applySelectionEdit as replaceSelection,
  createBlockRef,
  type BlockRef,
  type LockMeta,
  type SessionRecord,
  type TextSelection
} from "@mathnotes/shared";
import { readReadonlySessionBlock, type ReadonlySessionBlock } from "./sessionReadService";
import { markdownBlockRevision, sha256Text } from "./sessionRevision";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";

export type SaveMarkdownBlockInput = Readonly<{
  notebookId: string;
  sessionId: string;
  blockId: string;
  markdown: string;
  baseRevision: string;
  writerId?: string;
  operationId?: string;
}>;

export type SessionMarkdownConflictStatus =
  | "unresolved"
  | "resolved_current"
  | "resolved_incoming"
  | "resolved_merged";

export type SessionMarkdownConflictSummary = Readonly<{
  version: 1;
  id: string;
  blockId: string;
  baseRevision: string;
  currentRevision: string;
  incomingWriterId: string;
  reason: "diverged_edit";
  status: SessionMarkdownConflictStatus;
  createdAt: string;
  resolvedAt?: string;
}>;

export type SessionMarkdownConflict = SessionMarkdownConflictSummary & Readonly<{
  currentMarkdown: string;
  incomingMarkdown: string;
}>;

export type ResolveMarkdownConflictInput = Readonly<{
  notebookId: string;
  sessionId: string;
  conflictId: string;
  resolution: "current" | "incoming" | "merged";
  baseRevision: string;
  markdown?: string;
}>;

export type ResolveMarkdownConflictResult = Readonly<{
  version: 1;
  resolved: true;
  conflict: SessionMarkdownConflictSummary;
  block: ReadonlySessionBlock;
}>;

export type SaveMarkdownBlockResult = Readonly<{
  version: 1;
  saved: true;
  block: ReadonlySessionBlock;
}>;

export type AppendMarkdownBlockInput = Readonly<{
  notebookId: string;
  sessionId: string;
  markdown: string;
  sourceName?: string;
  insertAfterBlockId?: string;
}>;

export type ApplySelectionEditInput = Readonly<{
  notebookId: string;
  sessionId: string;
  blockId: string;
  baseRevision: string;
  selection: TextSelection;
  replacement: string;
}>;

export type UpdateMarkdownProtectedSpanInput = Readonly<{
  notebookId: string;
  sessionId: string;
  blockId: string;
  baseRevision: string;
  selection: TextSelection;
}>;

export type UpdateMarkdownProtectedSpanResult = Readonly<{
  version: 1;
  protected: boolean;
  spanId: string;
  block: ReadonlySessionBlock;
}>;

export type SplitLockedSelectionResult = Readonly<{
  version: 1;
  lockedBlockId: string;
  blocks: readonly ReadonlySessionBlock[];
}>;

export type SetMarkdownBlockLockInput = Readonly<{
  notebookId: string;
  sessionId: string;
  blockId: string;
  locked: boolean;
}>;

export type SetMarkdownBlockLockResult = Readonly<{
  version: 1;
  locked: boolean;
  block: ReadonlySessionBlock;
}>;

export class SessionEditError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "invalid_session"
      | "block_not_found"
      | "not_markdown_block"
      | "block_not_editable"
      | "revision_conflict"
      | "block_locked"
      | "protected_span_missing"
      | "protected_span_changed"
      | "invalid_protected_span"
      | "conflict_not_found"
      | "conflict_already_resolved"
      | "invalid_conflict_resolution"
      | "invalid_selection"
      | "selection_stale"
      | "protected_selection"
      | "stale_anchor"
      | "path_outside_session",
    readonly statusCode: number,
    readonly details?: Readonly<{ conflictId?: string }>
  ) {
    super(code);
    this.name = "SessionEditError";
  }
}

export class SessionEditService {
  constructor(
    private readonly rootDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly coordinator = new SessionWriteCoordinator()
  ) {}

  saveMarkdownBlock(input: SaveMarkdownBlockInput): Promise<SaveMarkdownBlockResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.saveMarkdownBlockSerial(input));
  }

  appendMarkdownBlock(input: AppendMarkdownBlockInput): Promise<ReadonlySessionBlock> {
    return this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const { session, sessionDir, sessionPath } = await readSession(this.rootDir, input.notebookId, input.sessionId);
      const timestamp = this.now();
      const id = nextBlockId(session);
      const path = `blocks/${id}_user_note.md`;
      const blockPath = resolve(sessionDir, path);
      assertInside(sessionDir, blockPath);
      const sourceName = input.sourceName?.trim();
      const anchorIndex = input.insertAfterBlockId === undefined
        ? session.blocks.length - 1
        : session.blocks.findIndex((candidate) => candidate.id === input.insertAfterBlockId);
      if (input.insertAfterBlockId !== undefined && anchorIndex < 0) {
        throw new SessionEditError("stale_anchor", 409);
      }
      const block = createBlockRef({
        id,
        type: "markdown",
        path,
        source: "user",
        ...(sourceName ? { sourceName: sourceName.slice(0, 240) } : {}),
        createdAt: timestamp
      });
      const nextSession: SessionRecord = {
        ...session,
        blocks: [
          ...session.blocks.slice(0, anchorIndex + 1),
          block,
          ...session.blocks.slice(anchorIndex + 1)
        ],
        updatedAt: timestamp
      };
      await writeFileAtomically(blockPath, input.markdown);
      try {
        await writeFileAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
      } catch (error) {
        await rm(blockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return readReadonlySessionBlock({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: id
      });
    });
  }

  applySelectionEdit(input: ApplySelectionEditInput): Promise<SaveMarkdownBlockResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.applySelectionEditSerial(input));
  }

  protectMarkdownSelection(input: UpdateMarkdownProtectedSpanInput): Promise<UpdateMarkdownProtectedSpanResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.protectMarkdownSelectionSerial(input));
  }

  splitLockedSelection(input: UpdateMarkdownProtectedSpanInput): Promise<SplitLockedSelectionResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, async () => {
      const { session, sessionDir, sessionPath } = await readSession(this.rootDir, input.notebookId, input.sessionId);
      const index = session.blocks.findIndex((candidate) => candidate.id === input.blockId);
      const block = session.blocks[index];
      if (!block) throw new SessionEditError("block_not_found", 404);
      if (block.type !== "markdown") throw new SessionEditError("not_markdown_block", 422);
      if (block.status === "locked") throw new SessionEditError("block_locked", 423);
      if (!isUserEditable(block)) throw new SessionEditError("block_not_editable", 423);
      const target = resolve(sessionDir, block.path);
      assertInside(sessionDir, target);
      const markdown = await readFile(target, "utf8");
      const locks = session.locks.filter((lock) => lock.blockId === block.id);
      if (markdownBlockRevision({ block, markdown, locks }) !== input.baseRevision) throw new SessionEditError("revision_conflict", 409);
      const { from, to, selectedText } = input.selection;
      const validation = replaceSelection({ markdown, selection: input.selection, replacement: selectedText });
      if (!validation.ok) {
        if (validation.reason === "invalid_range") throw new SessionEditError("invalid_selection", 422);
        if (validation.reason === "selection_stale") throw new SessionEditError("selection_stale", 409);
        throw new SessionEditError("protected_selection", 423);
      }
      // Swift selections use UTF-16 offsets. Never split a surrogate pair on disk.
      const splitsSurrogate = (offset: number) => offset > 0 && offset < markdown.length &&
        /[\uD800-\uDBFF]/.test(markdown[offset - 1]) && /[\uDC00-\uDFFF]/.test(markdown[offset]);
      if (splitsSurrogate(from) || splitsSurrogate(to)) throw new SessionEditError("invalid_selection", 422);
      const timestamp = this.now();
      const operation = randomUUID();
      const group = block.continuationGroup ?? `continuation_${operation}`;
      const pieces = [
        { markdown: markdown.slice(0, from), locked: false },
        { markdown: selectedText, locked: true },
        { markdown: markdown.slice(to), locked: false }
      ].filter((piece) => piece.markdown.length > 0);
      const nextBlocks: BlockRef[] = pieces.map((piece, position) => ({
        ...block,
        id: position === 0 ? block.id : `split_${randomUUID()}`,
        path: `blocks/split_${operation}_${position}.md`,
        status: piece.locked ? "locked" : block.status,
        continuationGroup: group,
        updatedAt: timestamp
      }));
      const nextLocks = session.locks.filter((lock) => lock.blockId !== block.id);
      for (let position = 0; position < pieces.length; position++) {
        const piece = pieces[position]; const child = nextBlocks[position];
        for (const span of parseProtectedSpans(piece.markdown)) {
          const original = locks.find((lock) => lock.id === span.id && lock.kind === "span");
          if (original) nextLocks.push({ ...original, blockId: child.id });
        }
        if (piece.locked) nextLocks.push({ id: `lock_block_${child.id}`, blockId: child.id, kind: "block",
          contentHash: sha256Text(piece.markdown), createdAt: timestamp, createdBy: "user", aiEditable: false });
      }
      const nextSession: SessionRecord = { ...session, updatedAt: timestamp, locks: nextLocks,
        blocks: [...session.blocks.slice(0, index), ...nextBlocks, ...session.blocks.slice(index + 1)] };
      // New immutable files first; the atomic metadata rename is the only commit point.
      // Keep the original file as a recoverable version, including on interrupted writes.
      for (let position = 0; position < pieces.length; position++) {
        await writeFileAtomically(resolve(sessionDir, nextBlocks[position].path), pieces[position].markdown);
      }
      await writeFileAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
      return { version: 1, lockedBlockId: nextBlocks[pieces.findIndex((piece) => piece.locked)].id,
        blocks: await Promise.all(nextBlocks.map((child) => readReadonlySessionBlock({
          rootDir: this.rootDir, notebookId: input.notebookId, sessionId: input.sessionId, blockId: child.id
        }))) };
    });
  }

  unlockMarkdownProtectedSelection(input: UpdateMarkdownProtectedSpanInput): Promise<UpdateMarkdownProtectedSpanResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.unlockMarkdownProtectedSelectionSerial(input));
  }

  setMarkdownBlockLock(input: SetMarkdownBlockLockInput): Promise<SetMarkdownBlockLockResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.setMarkdownBlockLockSerial(input));
  }

  async listMarkdownConflicts(input: {
    notebookId: string;
    sessionId: string;
    blockId?: string;
  }): Promise<SessionMarkdownConflictSummary[]> {
    const { sessionDir } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    const records = await readConflictRecords(sessionDir);
    return records
      .filter((record) => !input.blockId || record.blockId === input.blockId)
      .map(publicConflictSummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  async readMarkdownConflict(input: {
    notebookId: string;
    sessionId: string;
    conflictId: string;
  }): Promise<SessionMarkdownConflict> {
    const { sessionDir } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    return readConflictDetail(sessionDir, input.conflictId);
  }

  resolveMarkdownConflict(input: ResolveMarkdownConflictInput): Promise<ResolveMarkdownConflictResult> {
    return this.coordinator.run(input.notebookId, input.sessionId, () => this.resolveMarkdownConflictSerial(input));
  }

  private async saveMarkdownBlockSerial(input: SaveMarkdownBlockInput): Promise<SaveMarkdownBlockResult> {
    const { session, sessionDir, sessionPath } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    const block = session.blocks.find((candidate) => candidate.id === input.blockId);
    if (!block) throw new SessionEditError("block_not_found", 404);
    if (block.type !== "markdown") throw new SessionEditError("not_markdown_block", 422);
    if (block.status === "locked") throw new SessionEditError("block_locked", 423);
    if (!isUserEditable(block)) throw new SessionEditError("block_not_editable", 423);

    const blockPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, blockPath);
    const beforeMarkdown = await readFile(blockPath, "utf8");
    const locks = session.locks.filter((lock) => lock.blockId === block.id);
    const currentRevision = markdownBlockRevision({ block, markdown: beforeMarkdown, locks });
    if (input.baseRevision !== currentRevision) {
      const conflict = await preserveMarkdownConflict({
        sessionDir,
        blockId: block.id,
        baseRevision: input.baseRevision,
        currentRevision,
        currentMarkdown: beforeMarkdown,
        incomingMarkdown: input.markdown,
        incomingWriterId: input.writerId?.trim() || "local-shell",
        operationId: input.operationId?.trim() || sha256Text(input.markdown),
        createdAt: this.now()
      });
      throw new SessionEditError("revision_conflict", 409, { conflictId: conflict.id });
    }

    await validateLockedContent({ beforeMarkdown, afterMarkdown: input.markdown, locks });
    const timestamp = this.now();
    const nextBlock = { ...block, updatedAt: timestamp };
    const nextSession: SessionRecord = {
      ...session,
      updatedAt: timestamp,
      blocks: session.blocks.map((candidate) => candidate.id === block.id ? nextBlock : candidate),
      locks: syncSpanLocks(session.locks, block.id, input.markdown, timestamp)
    };

    await writeFileAtomically(blockPath, input.markdown);
    try {
      await writeFileAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
    } catch (error) {
      await writeFileAtomically(blockPath, beforeMarkdown);
      throw error;
    }
    return {
      version: 1,
      saved: true,
      block: await readReadonlySessionBlock({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: input.blockId
      })
    };
  }

  private async applySelectionEditSerial(input: ApplySelectionEditInput): Promise<SaveMarkdownBlockResult> {
    const { session, sessionDir, sessionPath } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    const block = session.blocks.find((candidate) => candidate.id === input.blockId);
    if (!block) throw new SessionEditError("block_not_found", 404);
    if (block.type !== "markdown") throw new SessionEditError("not_markdown_block", 422);
    if (block.status === "locked") throw new SessionEditError("block_locked", 423);
    if (!isUserEditable(block)) throw new SessionEditError("block_not_editable", 423);

    const blockPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, blockPath);
    const beforeMarkdown = await readFile(blockPath, "utf8");
    const locks = session.locks.filter((lock) => lock.blockId === block.id);
    const currentRevision = markdownBlockRevision({ block, markdown: beforeMarkdown, locks });
    if (input.baseRevision !== currentRevision) throw new SessionEditError("revision_conflict", 409);

    const replacement = replaceSelection({
      markdown: beforeMarkdown,
      selection: input.selection,
      replacement: input.replacement
    });
    if (!replacement.ok) {
      if (replacement.reason === "invalid_range") throw new SessionEditError("invalid_selection", 422);
      if (replacement.reason === "selection_stale") throw new SessionEditError("selection_stale", 409);
      throw new SessionEditError("protected_selection", 423);
    }

    await validateLockedContent({ beforeMarkdown, afterMarkdown: replacement.markdown, locks });
    const timestamp = this.now();
    const nextBlock = { ...block, updatedAt: timestamp };
    const nextSession: SessionRecord = {
      ...session,
      updatedAt: timestamp,
      blocks: session.blocks.map((candidate) => candidate.id === block.id ? nextBlock : candidate),
      locks: syncSpanLocks(session.locks, block.id, replacement.markdown, timestamp)
    };
    await writeFileAtomically(blockPath, replacement.markdown);
    try {
      await writeFileAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
    } catch (error) {
      await writeFileAtomically(blockPath, beforeMarkdown);
      throw error;
    }
    return {
      version: 1,
      saved: true,
      block: await readReadonlySessionBlock({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: input.blockId
      })
    };
  }

  private async protectMarkdownSelectionSerial(
    input: UpdateMarkdownProtectedSpanInput
  ): Promise<UpdateMarkdownProtectedSpanResult> {
    const { session, sessionDir, sessionPath } = await readSession(
      this.rootDir,
      input.notebookId,
      input.sessionId
    );
    const block = session.blocks.find((candidate) => candidate.id === input.blockId);
    if (!block) throw new SessionEditError("block_not_found", 404);
    if (block.type !== "markdown") throw new SessionEditError("not_markdown_block", 422);
    if (block.status === "locked") throw new SessionEditError("block_locked", 423);
    if (!isUserEditable(block)) throw new SessionEditError("block_not_editable", 423);

    const blockPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, blockPath);
    const beforeMarkdown = await readFile(blockPath, "utf8");
    const locks = session.locks.filter((lock) => lock.blockId === block.id);
    const currentRevision = markdownBlockRevision({ block, markdown: beforeMarkdown, locks });
    if (input.baseRevision !== currentRevision) throw new SessionEditError("revision_conflict", 409);
    if (/^[\r\n]|[\r\n]$/.test(input.selection.selectedText)) {
      throw new SessionEditError("invalid_selection", 422);
    }

    const spanId = `lock_${randomUUID()}`;
    const contentHash = sha256Text(input.selection.selectedText);
    const marker = [
      `<!-- lock:start id="${spanId}" hash="${contentHash}" -->`,
      input.selection.selectedText,
      `<!-- lock:end id="${spanId}" -->`
    ].join("\n");
    const replacement = replaceSelection({
      markdown: beforeMarkdown,
      selection: input.selection,
      replacement: marker
    });
    if (!replacement.ok) {
      if (replacement.reason === "invalid_range") throw new SessionEditError("invalid_selection", 422);
      if (replacement.reason === "selection_stale") throw new SessionEditError("selection_stale", 409);
      throw new SessionEditError("protected_selection", 423);
    }

    await validateLockedContent({ beforeMarkdown, afterMarkdown: replacement.markdown, locks });
    const timestamp = this.now();
    const nextBlock = { ...block, updatedAt: timestamp };
    const nextSession: SessionRecord = {
      ...session,
      updatedAt: timestamp,
      blocks: session.blocks.map((candidate) => candidate.id === block.id ? nextBlock : candidate),
      locks: syncSpanLocks(session.locks, block.id, replacement.markdown, timestamp)
    };
    await writeFileAtomically(blockPath, replacement.markdown);
    try {
      await writeFileAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
    } catch (error) {
      await writeFileAtomically(blockPath, beforeMarkdown);
      throw error;
    }
    return {
      version: 1,
      protected: true,
      spanId,
      block: await readReadonlySessionBlock({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: input.blockId
      })
    };
  }

  private async unlockMarkdownProtectedSelectionSerial(
    input: UpdateMarkdownProtectedSpanInput
  ): Promise<UpdateMarkdownProtectedSpanResult> {
    const { session, sessionDir, sessionPath } = await readSession(
      this.rootDir,
      input.notebookId,
      input.sessionId
    );
    const block = session.blocks.find((candidate) => candidate.id === input.blockId);
    if (!block) throw new SessionEditError("block_not_found", 404);
    if (block.type !== "markdown") throw new SessionEditError("not_markdown_block", 422);
    if (block.status === "locked") throw new SessionEditError("block_locked", 423);
    if (!isUserEditable(block)) throw new SessionEditError("block_not_editable", 423);

    const blockPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, blockPath);
    const beforeMarkdown = await readFile(blockPath, "utf8");
    const locks = session.locks.filter((lock) => lock.blockId === block.id);
    const currentRevision = markdownBlockRevision({ block, markdown: beforeMarkdown, locks });
    if (input.baseRevision !== currentRevision) throw new SessionEditError("revision_conflict", 409);

    const { from, to, selectedText } = input.selection;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > beforeMarkdown.length) {
      throw new SessionEditError("invalid_selection", 422);
    }
    if (beforeMarkdown.slice(from, to) !== selectedText) throw new SessionEditError("selection_stale", 409);
    const span = parseProtectedSpans(beforeMarkdown).find(
      (candidate) => from >= candidate.contentFrom && to <= candidate.contentTo
    );
    if (!span) throw new SessionEditError("protected_span_missing", 423);
    const registeredLock = locks.find((lock) => lock.kind === "span" && lock.id === span.id);
    if (!registeredLock) throw new SessionEditError("protected_span_missing", 423);
    if (span.contentHash !== registeredLock.contentHash) {
      throw new SessionEditError("protected_span_changed", 423);
    }
    if (span.declaredHash !== span.contentHash) throw new SessionEditError("invalid_protected_span", 422);

    const afterMarkdown = `${beforeMarkdown.slice(0, span.from)}${span.content}${beforeMarkdown.slice(span.to)}`;
    const remainingLocks = locks.filter((lock) => !(lock.kind === "span" && lock.id === span.id));
    await validateLockedContent({ beforeMarkdown, afterMarkdown, locks: remainingLocks });
    const timestamp = this.now();
    const nextBlock = { ...block, updatedAt: timestamp };
    const nextSession: SessionRecord = {
      ...session,
      updatedAt: timestamp,
      blocks: session.blocks.map((candidate) => candidate.id === block.id ? nextBlock : candidate),
      locks: syncSpanLocks(session.locks, block.id, afterMarkdown, timestamp)
    };
    await writeFileAtomically(blockPath, afterMarkdown);
    try {
      await writeFileAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
    } catch (error) {
      await writeFileAtomically(blockPath, beforeMarkdown);
      throw error;
    }
    return {
      version: 1,
      protected: false,
      spanId: span.id,
      block: await readReadonlySessionBlock({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: input.blockId
      })
    };
  }

  private async setMarkdownBlockLockSerial(input: SetMarkdownBlockLockInput): Promise<SetMarkdownBlockLockResult> {
    const { session, sessionDir, sessionPath } = await readSession(
      this.rootDir,
      input.notebookId,
      input.sessionId
    );
    const block = session.blocks.find((candidate) => candidate.id === input.blockId);
    if (!block) throw new SessionEditError("block_not_found", 404);
    if (block.type !== "markdown") throw new SessionEditError("not_markdown_block", 422);
    if (!isUserEditable(block)) throw new SessionEditError("block_not_editable", 423);

    const blockPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, blockPath);
    const markdown = await readFile(blockPath, "utf8");
    const timestamp = this.now();
    const nextBlock: BlockRef = {
      ...block,
      status: input.locked ? "locked" : block.status === "locked" ? "draft" : block.status,
      updatedAt: timestamp
    };
    const retainedLocks = session.locks.filter(
      (lock) => !(lock.blockId === block.id && lock.kind === "block")
    );
    const nextLocks: LockMeta[] = input.locked
      ? [
          ...retainedLocks,
          {
            id: `lock_block_${block.id}`,
            blockId: block.id,
            kind: "block",
            contentHash: sha256Text(markdown),
            createdAt: timestamp,
            createdBy: "user",
            aiEditable: false
          }
        ]
      : retainedLocks;
    const nextSession: SessionRecord = {
      ...session,
      updatedAt: timestamp,
      blocks: session.blocks.map((candidate) => candidate.id === block.id ? nextBlock : candidate),
      locks: nextLocks
    };
    await writeFileAtomically(sessionPath, `${JSON.stringify(nextSession, null, 2)}\n`);
    return {
      version: 1,
      locked: input.locked,
      block: await readReadonlySessionBlock({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: input.blockId
      })
    };
  }

  private async resolveMarkdownConflictSerial(
    input: ResolveMarkdownConflictInput
  ): Promise<ResolveMarkdownConflictResult> {
    if (!/^[a-f0-9]{64}$/.test(input.conflictId)) {
      throw new SessionEditError("conflict_not_found", 404);
    }
    if (input.resolution === "merged" && typeof input.markdown !== "string") {
      throw new SessionEditError("invalid_conflict_resolution", 400);
    }
    const { sessionDir } = await readSession(this.rootDir, input.notebookId, input.sessionId);
    const detail = await readConflictDetail(sessionDir, input.conflictId);
    if (detail.status !== "unresolved") throw new SessionEditError("conflict_already_resolved", 409);

    let block: ReadonlySessionBlock;
    let status: SessionMarkdownConflictStatus;
    if (input.resolution === "current") {
      block = await readReadonlySessionBlock({
        rootDir: this.rootDir,
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: detail.blockId
      });
      if (block.content.kind !== "markdown" || block.content.baseRevision !== input.baseRevision) {
        throw new SessionEditError("revision_conflict", 409);
      }
      status = "resolved_current";
    } else {
      const markdown = input.resolution === "incoming" ? detail.incomingMarkdown : input.markdown!;
      const saved = await this.saveMarkdownBlockSerial({
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        blockId: detail.blockId,
        markdown,
        baseRevision: input.baseRevision,
        writerId: "conflict-resolver",
        operationId: input.conflictId
      });
      block = saved.block;
      status = input.resolution === "incoming" ? "resolved_incoming" : "resolved_merged";
    }

    const record = await markConflictResolved(sessionDir, input.conflictId, status, this.now());
    return { version: 1, resolved: true, conflict: publicConflictSummary(record), block };
  }
}

type StoredMarkdownConflict = SessionMarkdownConflictSummary & Readonly<{
  operationId: string;
  currentContentPath: string;
  incomingContentPath: string;
}>;

async function preserveMarkdownConflict(args: {
  sessionDir: string;
  blockId: string;
  baseRevision: string;
  currentRevision: string;
  currentMarkdown: string;
  incomingMarkdown: string;
  incomingWriterId: string;
  operationId: string;
  createdAt: string;
}): Promise<StoredMarkdownConflict> {
  const id = sha256Text([
    args.blockId,
    args.baseRevision,
    args.currentRevision,
    sha256Text(args.incomingMarkdown)
  ].join("\0"));
  const relativeRoot = `.mathnotes/conflicts/${id}`;
  const record: StoredMarkdownConflict = {
    version: 1,
    id,
    blockId: args.blockId,
    baseRevision: args.baseRevision,
    currentRevision: args.currentRevision,
    incomingWriterId: args.incomingWriterId,
    operationId: args.operationId,
    reason: "diverged_edit",
    status: "unresolved",
    createdAt: args.createdAt,
    currentContentPath: `${relativeRoot}/current.md`,
    incomingContentPath: `${relativeRoot}/incoming.md`
  };
  const recordPath = resolve(args.sessionDir, relativeRoot, "record.json");
  assertInside(args.sessionDir, recordPath);
  try {
    const existing = JSON.parse(await readFile(recordPath, "utf8")) as StoredMarkdownConflict;
    if (!isStoredConflict(existing, id)) throw new SessionEditError("conflict_not_found", 404);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFileAtomically(resolve(args.sessionDir, record.currentContentPath), args.currentMarkdown);
  await writeFileAtomically(resolve(args.sessionDir, record.incomingContentPath), args.incomingMarkdown);
  await writeFileAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function readConflictRecords(sessionDir: string): Promise<StoredMarkdownConflict[]> {
  const root = resolve(sessionDir, ".mathnotes", "conflicts");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      if (!/^[a-f0-9]{64}$/.test(entry.name)) return undefined;
      try {
        const record = JSON.parse(await readFile(join(root, entry.name, "record.json"), "utf8")) as StoredMarkdownConflict;
        return isStoredConflict(record, entry.name) ? record : undefined;
      } catch {
        return undefined;
      }
    }));
    return records.filter((record): record is StoredMarkdownConflict => record !== undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readConflictDetail(sessionDir: string, conflictId: string): Promise<SessionMarkdownConflict> {
  if (!/^[a-f0-9]{64}$/.test(conflictId)) throw new SessionEditError("conflict_not_found", 404);
  const root = resolve(sessionDir, ".mathnotes", "conflicts", conflictId);
  assertInside(sessionDir, root);
  try {
    const record = JSON.parse(await readFile(resolve(root, "record.json"), "utf8")) as StoredMarkdownConflict;
    if (!isStoredConflict(record, conflictId)) throw new SessionEditError("conflict_not_found", 404);
    const currentPath = resolve(sessionDir, record.currentContentPath);
    const incomingPath = resolve(sessionDir, record.incomingContentPath);
    assertInside(sessionDir, currentPath);
    assertInside(sessionDir, incomingPath);
    const [currentMarkdown, incomingMarkdown] = await Promise.all([
      readFile(currentPath, "utf8"),
      readFile(incomingPath, "utf8")
    ]);
    return { ...publicConflictSummary(record), currentMarkdown, incomingMarkdown };
  } catch (error) {
    if (error instanceof SessionEditError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionEditError("conflict_not_found", 404);
    throw error;
  }
}

async function markConflictResolved(
  sessionDir: string,
  conflictId: string,
  status: Exclude<SessionMarkdownConflictStatus, "unresolved">,
  resolvedAt: string
): Promise<StoredMarkdownConflict> {
  const recordPath = resolve(sessionDir, ".mathnotes", "conflicts", conflictId, "record.json");
  assertInside(sessionDir, recordPath);
  let record: StoredMarkdownConflict;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as StoredMarkdownConflict;
    if (!isStoredConflict(record, conflictId)) throw new SessionEditError("conflict_not_found", 404);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionEditError("conflict_not_found", 404);
    throw error;
  }
  const resolved = { ...record, status, resolvedAt };
  await writeFileAtomically(recordPath, `${JSON.stringify(resolved, null, 2)}\n`);
  return resolved;
}

function publicConflictSummary(record: StoredMarkdownConflict): SessionMarkdownConflictSummary {
  return {
    version: 1,
    id: record.id,
    blockId: record.blockId,
    baseRevision: record.baseRevision,
    currentRevision: record.currentRevision,
    incomingWriterId: record.incomingWriterId,
    reason: record.reason,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {})
  };
}

function isStoredConflict(value: StoredMarkdownConflict, expectedId: string): boolean {
  return value?.version === 1 && value.id === expectedId && /^[a-f0-9]{64}$/.test(value.id) &&
    typeof value.blockId === "string" && value.blockId.length > 0 &&
    /^[a-f0-9]{64}$/.test(value.baseRevision) && /^[a-f0-9]{64}$/.test(value.currentRevision) &&
    value.reason === "diverged_edit" &&
    ["unresolved", "resolved_current", "resolved_incoming", "resolved_merged"].includes(value.status) &&
    typeof value.currentContentPath === "string" && typeof value.incomingContentPath === "string";
}

function isUserEditable(block: BlockRef): boolean {
  return block.readonly !== true && ["user", "user_revision", "mixed", "ai_transcription"].includes(block.source);
}

function nextBlockId(session: SessionRecord): string {
  const max = session.blocks.reduce((current, block) => {
    const parsed = Number.parseInt(block.id, 10);
    return Number.isFinite(parsed) ? Math.max(current, parsed) : current;
  }, 0);
  return String(max + 1).padStart(4, "0");
}

export async function validateLockedContent(args: {
  beforeMarkdown: string;
  afterMarkdown: string;
  locks: readonly LockMeta[];
}): Promise<void> {
  if (args.locks.some((lock) => lock.kind === "block")) {
    throw new SessionEditError("block_locked", 423);
  }
  const beforeSpans = new Map(parseProtectedSpans(args.beforeMarkdown).map((span) => [span.id, span]));
  const afterSpans = new Map(parseProtectedSpans(args.afterMarkdown).map((span) => [span.id, span]));
  for (const lock of args.locks.filter((candidate) => candidate.kind === "span")) {
    const before = beforeSpans.get(lock.id);
    const after = afterSpans.get(lock.id);
    if (!before || !after) throw new SessionEditError("protected_span_missing", 423);
    if (before.contentHash !== lock.contentHash || after.contentHash !== lock.contentHash) {
      throw new SessionEditError("protected_span_changed", 423);
    }
  }
  for (const span of afterSpans.values()) {
    if (span.declaredHash !== span.contentHash) throw new SessionEditError("invalid_protected_span", 422);
  }
}

type ProtectedSpan = Readonly<{
  id: string;
  declaredHash: string;
  contentHash: string;
  content: string;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}>;

function parseProtectedSpans(markdown: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  const pattern = /<!-- lock:start id="(?<id>[^"]+)" hash="(?<hash>[a-f0-9]{64})" -->\r?\n?(?<content>[\s\S]*?)\r?\n?<!-- lock:end id="\k<id>" -->/g;
  for (const match of markdown.matchAll(pattern)) {
    if (!match.groups || match.index === undefined) continue;
    const rawContent = match.groups.content;
    const content = trimOuterNewlines(rawContent);
    const rawContentOffset = match[0].indexOf(rawContent);
    const contentFrom = match.index + rawContentOffset + leadingNewlineLength(rawContent);
    spans.push({
      id: match.groups.id,
      declaredHash: match.groups.hash,
      contentHash: sha256Text(content),
      content,
      from: match.index,
      to: match.index + match[0].length,
      contentFrom,
      contentTo: contentFrom + content.length
    });
  }
  return spans;
}

function trimOuterNewlines(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function leadingNewlineLength(value: string): number {
  if (value.startsWith("\r\n")) return 2;
  return value.startsWith("\n") ? 1 : 0;
}

function syncSpanLocks(locks: readonly LockMeta[], blockId: string, markdown: string, now: string): LockMeta[] {
  const retained = locks.filter((lock) => lock.blockId !== blockId || lock.kind !== "span");
  const spans: LockMeta[] = parseProtectedSpans(markdown).map((span) => ({
    id: span.id,
    blockId,
    kind: "span",
    contentHash: span.contentHash,
    createdAt: now,
    createdBy: "user",
    aiEditable: false
  }));
  return [...retained, ...spans];
}

async function readSession(rootDir: string, notebookId: string, sessionId: string) {
  const notebooksDir = resolve(rootDir, "notebooks");
  const sessionDir = resolve(notebooksDir, notebookId, "sessions", sessionId);
  assertInside(notebooksDir, sessionDir);
  const sessionPath = resolve(sessionDir, "session.json");
  try {
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    if (session.id !== sessionId || !Array.isArray(session.blocks) || !Array.isArray(session.locks)) {
      throw new SessionEditError("invalid_session", 422);
    }
    return { session, sessionDir, sessionPath };
  } catch (error) {
    if (error instanceof SessionEditError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SessionEditError("session_not_found", 404);
    if (error instanceof SyntaxError) throw new SessionEditError("invalid_session", 422);
    throw error;
  }
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new SessionEditError("path_outside_session", 400);
  }
}

async function writeFileAtomically(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

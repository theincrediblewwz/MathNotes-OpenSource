import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapProtectedSpan } from "../common/lockSpan";
import { BlockStore } from "./blockStore";

describe("BlockStore", () => {
  let root: string;
  let store: BlockStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-"));
    store = new BlockStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a session with expected directories and session metadata", async () => {
    const session = await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "2026-06-26_lecture_03",
      title: "泛函分析 第 3 讲",
      now: "2026-06-26T10:00:00.000Z"
    });

    expect(session.blocks).toEqual([]);

    const saved = JSON.parse(
      await readFile(
        join(root, "notebooks/functional_analysis/sessions/2026-06-26_lecture_03/session.json"),
        "utf8"
      )
    );
    expect(saved.title).toBe("泛函分析 第 3 讲");
    expect(saved.currentDraftPolicy).toBe("append_only");
  });

  it("appends image and markdown blocks in order", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });

    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_001.jpg",
      now: "2026-06-26T10:01:00.000Z"
    });

    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "## OCR 草稿",
      sourceName: "lecture.md",
      fromAssets: ["assets/photos/photo_001.jpg"],
      now: "2026-06-26T10:02:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");

    expect(session.blocks.map((block) => block.type)).toEqual(["image", "markdown"]);
    expect(session.blocks[0]).toMatchObject({
      id: "0001",
      path: "assets/photos/photo_001.jpg",
      source: "android_camera",
      editableByAi: false
    });
    expect(session.blocks[1]).toMatchObject({
      id: "0002",
      path: "blocks/0002_ai_transcript.md",
      source: "ai_transcription",
      sourceName: "lecture.md",
      editableByAi: true
    });
    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0002_ai_transcript.md"), "utf8")).toBe("## OCR 草稿");
  });

  it("does not reuse existing block ids after deleting a middle markdown block", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });

    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_001.jpg",
      now: "2026-06-26T10:01:00.000Z"
    });
    const deleted = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "old",
      now: "2026-06-26T10:02:00.000Z"
    });
    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_002.jpg",
      now: "2026-06-26T10:03:00.000Z"
    });
    await store.deleteMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: deleted.id,
      now: "2026-06-26T10:04:00.000Z"
    });

    const appended = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "new",
      now: "2026-06-26T10:05:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(appended.id).toBe("0004");
    expect(session.blocks.map((block) => `${block.id}:${block.type}`)).toEqual(["0001:image", "0003:image", "0004:markdown"]);
  });

  it("writes uploaded photo assets with sanitized filenames", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });

    const saved = await store.savePhotoAsset({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      fileName: "../photo 001.jpg",
      bytes: Buffer.from("fake image")
    });

    expect(saved.relativePath).toBe("assets/photos/photo_001.jpg");
    expect(await readFile(saved.absolutePath, "utf8")).toBe("fake image");
  });

  it("stores a read-only PDF block with source metadata", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-07-14T10:00:00.000Z"
    });
    const saved = await store.savePdfAsset({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      fileName: "../lecture notes.PDF",
      bytes: Buffer.from("pdf bytes")
    });
    const block = await store.appendPdfBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: saved.relativePath,
      sourceName: "lecture notes.PDF",
      pageCount: 12,
      now: "2026-07-14T10:01:00.000Z"
    });

    expect(saved.relativePath).toBe("assets/pdfs/lecture_notes.pdf");
    expect(await readFile(saved.absolutePath, "utf8")).toBe("pdf bytes");
    expect(block).toMatchObject({
      type: "pdf",
      source: "pdf_import",
      sourceName: "lecture notes.PDF",
      pageCount: 12,
      readonly: true,
      editableByAi: false
    });
  });

  it("writes embedded image assets separately from OCR source photos", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });

    const saved = await store.saveEmbeddedAsset({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      fileName: "../diagram 001.png",
      bytes: Buffer.from("fake diagram")
    });

    expect(saved.relativePath).toBe("assets/embedded/diagram_001.png");
    expect(await readFile(saved.absolutePath, "utf8")).toBe("fake diagram");
  });

  it("writes annotated image derivatives with sidecar metadata", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });

    const saved = await store.saveAnnotatedImageAsset({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      fileName: "../diagram 001.jpg",
      pngBytes: Buffer.from("edited png"),
      metadata: {
        version: 1,
        sourceAsset: "assets/photos/photo_001.jpg",
        sourceSha256: "a".repeat(64),
        outputMimeType: "image/png",
        operations: [
          { type: "crop", rect: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 } }
        ],
        annotations: [
          {
            id: "pen_001",
            type: "pen",
            points: [
              { x: 0.1, y: 0.2 },
              { x: 0.3, y: 0.4 }
            ],
            color: "#187857",
            width: 0.006
          },
          {
            id: "arrow_001",
            type: "arrow",
            start: { x: 0.4, y: 0.5 },
            end: { x: 0.7, y: 0.8 },
            color: "#187857",
            width: 0.006
          }
        ],
        createdAt: "2026-07-01T12:00:00.000Z"
      }
    });

    expect(saved.relativePath).toBe("assets/embedded/diagram_001.png");
    expect(saved.metadataRelativePath).toBe("assets/embedded/diagram_001.annotation.json");
    expect(await readFile(saved.absolutePath, "utf8")).toBe("edited png");
    expect(JSON.parse(await readFile(saved.metadataAbsolutePath, "utf8"))).toEqual({
      version: 1,
      sourceAsset: "assets/photos/photo_001.jpg",
      sourceSha256: "a".repeat(64),
      outputMimeType: "image/png",
      outputAsset: "assets/embedded/diagram_001.png",
      operations: [
        { type: "crop", rect: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 } }
      ],
      annotations: [
        {
          id: "pen_001",
          type: "pen",
          points: [
            { x: 0.1, y: 0.2 },
            { x: 0.3, y: 0.4 }
          ],
          color: "#187857",
          width: 0.006
        },
        {
          id: "arrow_001",
          type: "arrow",
          start: { x: 0.4, y: 0.5 },
          end: { x: 0.7, y: 0.8 },
          color: "#187857",
          width: 0.006
        }
      ],
      createdAt: "2026-07-01T12:00:00.000Z"
    });
  });

  it("updates an existing markdown block file and metadata", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "## Old OCR 草稿",
      now: "2026-06-26T10:01:00.000Z"
    });

    const updated = await store.updateMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: "## Revised OCR 草稿\n\n保存后的内容。",
      now: "2026-06-26T10:05:00.000Z"
    });

    expect(updated).toMatchObject({
      id: block.id,
      path: "blocks/0001_ai_transcript.md",
      updatedAt: "2026-06-26T10:05:00.000Z"
    });
    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0001_ai_transcript.md"), "utf8")).toBe(
      "## Revised OCR 草稿\n\n保存后的内容。"
    );

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.updatedAt).toBe("2026-06-26T10:05:00.000Z");
    expect(session.blocks).toHaveLength(1);
    expect(session.blocks[0].updatedAt).toBe("2026-06-26T10:05:00.000Z");
  });

  it("uses unique atomic temp files without leaving fixed .tmp artifacts", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "old",
      now: "2026-06-26T10:01:00.000Z"
    });

    await store.updateMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: "new",
      now: "2026-06-26T10:02:00.000Z"
    });

    const sessionDir = join(root, "notebooks/functional_analysis/sessions/lecture");
    expect(await listRelativeFiles(sessionDir)).not.toContain("blocks/0001_ai_transcript.md.tmp");
    expect(await readFile(join(sessionDir, "blocks/0001_ai_transcript.md"), "utf8")).toBe("new");
  });

  it("rejects markdown updates for non-markdown blocks", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_001.jpg",
      now: "2026-06-26T10:01:00.000Z"
    });

    await expect(
      store.updateMarkdownBlock({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        blockId: block.id,
        markdown: "should not write",
        now: "2026-06-26T10:05:00.000Z"
      })
    ).rejects.toThrow("Block 0001 is not a markdown block");
  });

  it("updates multiple markdown blocks in one save operation", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const first = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "first old",
      now: "2026-06-26T10:01:00.000Z"
    });
    const second = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "second old",
      now: "2026-06-26T10:02:00.000Z"
    });

    await store.updateMarkdownBlocks({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      updates: [
        { blockId: first.id, markdown: "first new" },
        { blockId: second.id, markdown: "second new" }
      ],
      now: "2026-06-26T10:06:00.000Z"
    });

    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0001_ai_transcript.md"), "utf8")).toBe(
      "first new"
    );
    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0002_user_note.md"), "utf8")).toBe(
      "second new"
    );

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.updatedAt).toBe("2026-06-26T10:06:00.000Z");
    expect(session.blocks.map((block) => block.updatedAt)).toEqual([
      "2026-06-26T10:06:00.000Z",
      "2026-06-26T10:06:00.000Z"
    ]);
  });

  it("skips stale combined-source updates that point to non-markdown blocks", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const image = await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_001.jpg",
      now: "2026-06-26T10:01:00.000Z"
    });
    const markdown = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "old",
      now: "2026-06-26T10:02:00.000Z"
    });

    await store.updateMarkdownBlocks({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      updates: [
        { blockId: image.id, markdown: "stale image update" },
        { blockId: markdown.id, markdown: "new" }
      ],
      now: "2026-06-26T10:03:00.000Z"
    });

    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0002_ai_transcript.md"), "utf8")).toBe("new");
  });

  it("updates a markdown block when legacy data contains a duplicate image block id", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_001.jpg",
      now: "2026-06-26T10:01:00.000Z"
    });
    const markdown = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "old",
      now: "2026-06-26T10:02:00.000Z"
    });
    const sessionPath = join(root, "notebooks/functional_analysis/sessions/lecture/session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    session.blocks[0].id = markdown.id;
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

    await store.updateMarkdownBlocks({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      updates: [{ blockId: markdown.id, markdown: "new" }],
      now: "2026-06-26T10:03:00.000Z"
    });

    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0002_ai_transcript.md"), "utf8")).toBe("new");
  });

  it("deletes a markdown block when legacy data contains a duplicate image block id", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_001.jpg",
      now: "2026-06-26T10:01:00.000Z"
    });
    const markdown = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "temporary",
      now: "2026-06-26T10:02:00.000Z"
    });
    const sessionPath = join(root, "notebooks/functional_analysis/sessions/lecture/session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    session.blocks[0].id = markdown.id;
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

    const deleted = await store.deleteMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: markdown.id,
      now: "2026-06-26T10:03:00.000Z"
    });

    const saved = await store.readSession("functional_analysis", "lecture");
    expect(deleted).toMatchObject({ id: markdown.id, type: "markdown" });
    expect(saved.blocks).toEqual([
      expect.objectContaining({ id: markdown.id, type: "image", path: "assets/photos/photo_001.jpg" })
    ]);
    await expect(
      readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0002_ai_transcript.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs protected span metadata when markdown blocks are updated", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "旧内容",
      now: "2026-06-26T10:01:00.000Z"
    });
    const lockedMarkdown = await wrapProtectedSpan({
      markdown: "定义 1.1 已人工确认",
      id: "lock_20260626_001"
    });

    await store.updateMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: lockedMarkdown,
      now: "2026-06-26T10:05:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.locks).toEqual([
      {
        id: "lock_20260626_001",
        blockId: block.id,
        kind: "span",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        createdAt: "2026-06-26T10:05:00.000Z",
        createdBy: "user",
        aiEditable: false
      }
    ]);
  });

  it("locks a markdown block with block metadata and disables AI edits", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "## 已校订内容\n\n这里不允许 AI 覆盖。",
      now: "2026-06-26T10:01:00.000Z"
    });

    await store.setMarkdownBlockLock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      locked: true,
      now: "2026-06-26T10:06:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks[0]).toMatchObject({
      id: block.id,
      status: "locked",
      editableByAi: false,
      updatedAt: "2026-06-26T10:06:00.000Z"
    });
    expect(session.locks).toEqual([
      {
        id: `lock_block_${block.id}`,
        blockId: block.id,
        kind: "block",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        createdAt: "2026-06-26T10:06:00.000Z",
        createdBy: "user",
        aiEditable: false
      }
    ]);
  });

  it("unlocks a markdown block and removes only its block lock", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "可重新开放给 AI 的 OCR 草稿",
      now: "2026-06-26T10:01:00.000Z"
    });
    const lockedMarkdown = await wrapProtectedSpan({
      markdown: "仍然保留的 span lock",
      id: "lock_span_keep"
    });
    await store.updateMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: lockedMarkdown,
      now: "2026-06-26T10:04:00.000Z"
    });
    await store.setMarkdownBlockLock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      locked: true,
      now: "2026-06-26T10:05:00.000Z"
    });

    await store.setMarkdownBlockLock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      locked: false,
      now: "2026-06-26T10:06:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks[0]).toMatchObject({
      status: "draft",
      editableByAi: true,
      updatedAt: "2026-06-26T10:06:00.000Z"
    });
    expect(session.locks).toHaveLength(1);
    expect(session.locks[0]).toMatchObject({
      id: "lock_span_keep",
      kind: "span",
      blockId: block.id
    });
  });

  it("deletes a markdown block file and its locks", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "temporary OCR draft",
      now: "2026-06-26T10:01:00.000Z"
    });
    await store.setMarkdownBlockLock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      locked: true,
      now: "2026-06-26T10:02:00.000Z"
    });

    const deleted = await store.deleteMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      now: "2026-06-26T10:03:00.000Z"
    });

    expect(deleted.id).toBe(block.id);
    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks).toEqual([]);
    expect(session.locks).toEqual([]);
    await expect(
      readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0001_ai_transcript.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a deleted markdown block snapshot at its original position", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const first = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "first",
      now: "2026-06-26T10:01:00.000Z"
    });
    const second = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "second",
      now: "2026-06-26T10:02:00.000Z"
    });
    const third = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user_revision",
      markdown: "third",
      now: "2026-06-26T10:03:00.000Z"
    });

    const snapshot = await store.deleteMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: second.id,
      now: "2026-06-26T10:04:00.000Z"
    });

    await store.restoreDeletedMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      snapshot,
      now: "2026-06-26T10:05:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => block.id)).toEqual([first.id, second.id, third.id]);
    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0002_ai_transcript.md"), "utf8")).toBe("second");
  });

  it("rejects AI updates that would change a block-level locked markdown block", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "人工确认后的整块内容",
      now: "2026-06-26T10:01:00.000Z"
    });
    await store.setMarkdownBlockLock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      locked: true,
      now: "2026-06-26T10:02:00.000Z"
    });

    await expect(
      store.updateMarkdownBlockFromAi({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        blockId: block.id,
        markdown: "AI 改写后的整块内容",
        now: "2026-06-26T10:03:00.000Z"
      })
    ).rejects.toThrow("AI update rejected: locked_block_changed lock_block_0001");

    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0001_ai_transcript.md"), "utf8")).toBe(
      "人工确认后的整块内容"
    );
  });

  it("allows AI updates around unchanged protected spans", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const lockedSpan = await wrapProtectedSpan({
      markdown: "人工确认定义",
      id: "lock_span_keep"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: `旧前文\n\n${lockedSpan}\n\n旧后文`,
      now: "2026-06-26T10:01:00.000Z"
    });
    await store.updateMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: `旧前文\n\n${lockedSpan}\n\n旧后文`,
      now: "2026-06-26T10:02:00.000Z"
    });

    await store.updateMarkdownBlockFromAi({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: `AI 新前文\n\n${lockedSpan}\n\nAI 新后文`,
      now: "2026-06-26T10:03:00.000Z"
    });

    expect(await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/blocks/0001_ai_transcript.md"), "utf8")).toBe(
      `AI 新前文\n\n${lockedSpan}\n\nAI 新后文`
    );
  });

  it("rejects AI updates that remove protected spans", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const lockedSpan = await wrapProtectedSpan({
      markdown: "人工确认定义",
      id: "lock_span_keep"
    });
    const block = await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: lockedSpan,
      now: "2026-06-26T10:01:00.000Z"
    });
    await store.updateMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: lockedSpan,
      now: "2026-06-26T10:02:00.000Z"
    });

    await expect(
      store.updateMarkdownBlockFromAi({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        blockId: block.id,
        markdown: "人工确认定义",
        now: "2026-06-26T10:03:00.000Z"
      })
    ).rejects.toThrow("AI update rejected: locked_span_missing lock_span_keep");
  });
});

async function listRelativeFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(rootDir, prefix), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(rootDir, relativePath)));
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { compactSessionDocumentForRenderer, loadSessionDocumentFromStore } from "./sessionDocumentStore";

describe("loadSessionDocumentFromStore", () => {
  let root: string;
  let store: BlockStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-doc-"));
    store = new BlockStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads a real session and converts markdown blocks for the renderer", async () => {
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
      markdown: ["source: photo_001.jpg", "", "#### 推导片段", "", "设 T_n 强收敛。"].join("\n"),
      fromAssets: ["assets/photos/photo_001.jpg"],
      now: "2026-06-26T10:02:00.000Z"
    });

    const document = await loadSessionDocumentFromStore({
      store,
      notebookId: "functional_analysis",
      sessionId: "lecture"
    });

    expect(document.sourceLines.some((line) => line.linkTarget === "photo_001.jpg")).toBe(true);
    expect(document.renderBlocks[0].title).toBe("推导片段");
    expect(document.renderBlocks[0].paragraphs).toEqual(["设 T_n 强收敛。"]);
  });

  it("reads markdown with bounded concurrency while preserving block order", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    for (let index = 1; index <= 18; index += 1) {
      await store.appendMarkdownBlock({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        source: "user",
        markdown: `original ${index}`,
        now: `2026-06-26T10:${String(index).padStart(2, "0")}:00.000Z`
      });
    }

    let activeReads = 0;
    let maxActiveReads = 0;
    const document = await loadSessionDocumentFromStore({
      store,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      readMarkdownFile: async (path) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeReads -= 1;
        return `loaded ${path.match(/(\d{4})_user_note/)?.[1] ?? "unknown"}`;
      }
    });

    expect(maxActiveReads).toBe(8);
    expect(document.sourceDocument.markdownBlocks.map((block) => block.blockId)).toEqual(
      Array.from({ length: 18 }, (_, index) => String(index + 1).padStart(4, "0"))
    );
    expect(document.renderBlocks.map((block) => block.paragraphs?.[0])).toEqual(
      Array.from({ length: 18 }, (_, index) => `loaded ${String(index + 1).padStart(4, "0")}`)
    );
  });

  it("compacts renderer refresh payloads without dropping source text or PDF blocks", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-07-18T10:00:00.000Z"
    });
    await store.appendPdfBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/pdfs/lecture.pdf",
      sourceName: "lecture.pdf",
      pageCount: 8,
      renderInNote: true,
      now: "2026-07-18T10:01:00.000Z"
    });
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "### Compact renderer payload\n\n$T_nx \\to Tx$",
      now: "2026-07-18T10:02:00.000Z"
    });

    const document = await loadSessionDocumentFromStore({
      store,
      notebookId: "functional_analysis",
      sessionId: "lecture"
    });
    const compact = compactSessionDocumentForRenderer(document);

    expect(compact.sourceDocument).toEqual(document.sourceDocument);
    expect(compact.sourceLines).toEqual([]);
    expect(compact.editableBlocks).toEqual([]);
    expect(compact.renderBlocks).toHaveLength(1);
    expect(compact.renderBlocks[0].pdf).toEqual({ assetPath: "assets/pdfs/lecture.pdf", pageCount: 8 });
    expect(document.renderBlocks.some((block) => block.markdown?.includes("Compact renderer payload"))).toBe(true);
  });
});

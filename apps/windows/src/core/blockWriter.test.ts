import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { BlockWriter } from "./blockWriter";

describe("BlockWriter", () => {
  let root: string;
  let store: BlockStore;
  let writer: BlockWriter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-"));
    store = new BlockStore(root);
    writer = new BlockWriter(store);
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes provider markdown as an ai transcript block linked to the source asset", async () => {
    const block = await writer.writeAiTranscript({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      markdown: "## OCR 草稿\n\n忠实转写内容。",
      fromAssets: ["assets/photos/photo_001.jpg"],
      now: "2026-06-26T10:01:00.000Z"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(block).toMatchObject({
      id: "0001",
      type: "markdown",
      source: "ai_transcription",
      fromAssets: ["assets/photos/photo_001.jpg"],
      editableByAi: true
    });
    expect(session.blocks[0]).toMatchObject({
      id: "0001",
      path: "blocks/0001_ai_transcript.md"
    });
  });

  it("binds the actual processed photo during both initial and streamed transcript writes", async () => {
    const block = await writer.writeAiTranscript({
      notebookId: "functional_analysis", sessionId: "lecture", now: "2026-09-07T00:00:00Z",
      markdown: "[图片：三角形]\n\n[[mathnotes:source-image]]",
      fromAssets: ["assets/photos/processed-mask.png"]
    });
    expect(await store.readMarkdownBlock("functional_analysis", "lecture", block.id)).toBe(
      "[图片：三角形]\n\n![识别照片（已处理）](../assets/photos/processed-mask.png)"
    );
    await writer.updateAiTranscript({ notebookId: "functional_analysis", sessionId: "lecture", blockId: block.id,
      markdown: "[图片：三角形 ABC]\n\n[[mathnotes:source-image]]", now: "2026-09-07T00:01:00Z" });
    expect(await store.readMarkdownBlock("functional_analysis", "lecture", block.id)).toContain(
      "![识别照片（已处理）](../assets/photos/processed-mask.png)"
    );
    expect((await store.readSession("functional_analysis", "lecture")).blocks).toHaveLength(1);
  });

  it("binds the recognized PDF page image, never the whole PDF or an unrelated source", async () => {
    const block = await writer.writeAiTranscript({
      notebookId: "functional_analysis", sessionId: "lecture", now: "2026-09-07T00:00:00Z",
      markdown: "图示\n\n[[mathnotes:source-image]]", fromAssets: ["assets/documents/lecture.pdf"],
      sourcePageNumber: 3, sourcePageImagePath: "assets/pdf-pages/lecture/page-3.png"
    });
    expect(await store.readMarkdownBlock("functional_analysis", "lecture", block.id)).toContain(
      "![识别照片（已处理）](../assets/pdf-pages/lecture/page-3.png)"
    );
  });
});

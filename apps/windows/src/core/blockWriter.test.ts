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
});

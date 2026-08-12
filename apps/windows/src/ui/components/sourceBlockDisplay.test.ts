import { describe, expect, it } from "vitest";
import type { SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";
import { createSourceBlockDisplays } from "./sourceBlockDisplay";

describe("createSourceBlockDisplays", () => {
  it("uses continuous display numbers even when internal block ids skip image blocks", () => {
    const blocks: SessionSourceMarkdownBlock[] = [
      {
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_user_note.md",
        source: "user",
        header: "user",
        locked: false
      },
      {
        blockId: "0003",
        sourceId: "src-0003",
        path: "blocks/0003_ai_transcript.md",
        source: "ai_transcription",
        header: "photo.png",
        locked: false
      }
    ];

    expect(createSourceBlockDisplays(blocks).map((display) => display.displayBlockId)).toEqual(["0001", "0002"]);
    expect(createSourceBlockDisplays(blocks)[1].internalBlockId).toBe("0003");
  });
});

import { describe, expect, it } from "vitest";
import type { SessionSourceDocument } from "./sessionSourceDocument";
import { searchSessionSource } from "./sessionSearch";

const document: SessionSourceDocument = {
  text: "",
  markdownBlocks: [
    {
      blockId: "0001",
      sourceId: "src-0001",
      path: "blocks/0001_user_note.md",
      source: "user",
      header: "user_note",
      locked: false
    },
    {
      blockId: "0002",
      sourceId: "src-0002",
      path: "blocks/0002_ai_transcript.md",
      source: "ai_transcription",
      header: "photo_001.png",
      locked: false
    }
  ]
};

describe("searchSessionSource", () => {
  it("matches source headers and markdown bodies with source ids", () => {
    const results = searchSessionSource({
      document,
      blockMarkdowns: new Map([
        ["0001", "## 泛函分析\n\n用户笔记"],
        ["0002", "设 T 为有界线性算子。"]
      ]),
      query: "photo"
    });

    expect(results).toEqual([
      expect.objectContaining({
        sourceId: "src-0002",
        blockId: "0002",
        title: "photo_001.png"
      })
    ]);
  });

  it("returns body snippets for mathematical terms", () => {
    const results = searchSessionSource({
      document,
      blockMarkdowns: new Map([
        ["0001", "## 泛函分析\n\n用户笔记"],
        ["0002", "设 T 为有界线性算子。"]
      ]),
      query: "有界线性"
    });

    expect(results).toEqual([
      expect.objectContaining({
        sourceId: "src-0002",
        snippet: "设 T 为有界线性算子。"
      })
    ]);
  });

  it("returns no results for blank queries", () => {
    expect(
      searchSessionSource({
        document,
        blockMarkdowns: new Map([["0001", "## 泛函分析"]]),
        query: "  "
      })
    ).toEqual([]);
  });
});

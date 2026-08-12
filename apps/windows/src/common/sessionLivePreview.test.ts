import { describe, expect, it } from "vitest";
import { renderBlocksFromSessionSourceText } from "./sessionLivePreview";
import type { SessionSourceMarkdownBlock } from "./sessionSourceDocument";

describe("sessionLivePreview", () => {
  it("renders updated preview blocks from edited direct source text", () => {
    const markdownBlocks: SessionSourceMarkdownBlock[] = [
      {
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_ai_transcript.md",
        source: "ai_transcription",
        header: "photo_001.jpg",
        locked: false
      },
      {
        blockId: "0002",
        sourceId: "src-0002",
        path: "blocks/0002_user_note.md",
        source: "user",
        header: "user_note",
        locked: false
      }
    ];
    const sourceText = [
      "--- source: photo_001.jpg | block: 0001 | path: blocks/0001_ai_transcript.md | kind: ai_transcription ---",
      "## 修改后的 OCR 标题",
      "这里是刚刚在左侧直接编辑的新内容。",
      "$$ ||Tx|| <= C ||x|| $$",
      "",
      "--- source: user_note | block: 0002 | path: blocks/0002_user_note.md | kind: user ---",
      "用户补充也应该进入实时预览。"
    ].join("\n");

    const rendered = renderBlocksFromSessionSourceText({ markdownBlocks, sourceText });

    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({
      id: "preview-0001",
      sourceId: "src-0001",
      sourceLine: 1,
      title: "修改后的 OCR 标题",
      className: "compact"
    });
    expect(rendered[0].paragraphs).toContain("这里是刚刚在左侧直接编辑的新内容。");
    expect(rendered[0].formulas).toContain("||Tx|| <= C ||x||");
    expect(rendered[0].items).toEqual([
      { kind: "paragraph", text: "这里是刚刚在左侧直接编辑的新内容。" },
      { kind: "formula", text: "||Tx|| <= C ||x||" }
    ]);
    expect(rendered[1]).toMatchObject({
      id: "preview-0002",
      sourceId: "src-0002",
      sourceLine: 6
    });
    expect(rendered[1].paragraphs).toContain("用户补充也应该进入实时预览。");
  });

  it("keeps paragraphs typed after formulas in their original markdown order", () => {
    const markdownBlocks: SessionSourceMarkdownBlock[] = [
      {
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_ai_transcript.md",
        source: "ai_transcription",
        header: "photo_001.jpg",
        locked: false
      }
    ];
    const sourceText = [
      "--- source: photo_001.jpg | block: 0001 | path: blocks/0001_ai_transcript.md | kind: ai_transcription ---",
      "#### 推导片段（来自 OCR 草稿）",
      "设 T_n 为有界线性算子，T_n -> T 强收敛。",
      "若 T 有界，则 sup_n ||T_n|| < infinity ?",
      "",
      "[看不清：最后一步估计式]",
      "说的说的的故事的发生"
    ].join("\n");

    const [rendered] = renderBlocksFromSessionSourceText({ markdownBlocks, sourceText });

    expect(rendered.items).toEqual([
      { kind: "paragraph", text: "设 T_n 为有界线性算子，T_n -> T 强收敛。" },
      { kind: "formula", text: "若 T 有界，则 sup_n ||T_n|| < infinity ?" },
      { kind: "unclear", text: "[看不清：最后一步估计式]" },
      { kind: "paragraph", text: "说的说的的故事的发生" }
    ]);
  });

  it("keeps source line numbers for compact per-block editor headers", () => {
    const markdownBlocks: SessionSourceMarkdownBlock[] = [
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
        header: "photo_003.jpg",
        locked: false
      }
    ];
    const sourceText = [
      "--- source: user | block: 0001 ---",
      "## 第一块",
      "",
      "正文。",
      "",
      "--- source: photo_003.jpg | block: 0003 ---",
      "## 第三块",
      "来自照片的内容。"
    ].join("\n");

    const rendered = renderBlocksFromSessionSourceText({ markdownBlocks, sourceText });

    expect(rendered.map((block) => ({ sourceId: block.sourceId, sourceLine: block.sourceLine }))).toEqual([
      { sourceId: "src-0001", sourceLine: 1 },
      { sourceId: "src-0003", sourceLine: 6 }
    ]);
  });

  it("exposes block-first location metadata for preview clicks", () => {
    const markdownBlocks: SessionSourceMarkdownBlock[] = [
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
        header: "photo_003.jpg",
        locked: false
      }
    ];
    const sourceText = [
      "--- source: user | block: 0001 ---",
      "## 第一块",
      "",
      "正文。",
      "",
      "--- source: photo_003.jpg | block: 0003 ---",
      "## 第三块",
      "来自照片的内容。",
      "第二行。"
    ].join("\n");

    const rendered = renderBlocksFromSessionSourceText({ markdownBlocks, sourceText });

    expect(
      rendered.map((block) => ({
        sourceId: block.sourceId,
        sourceBlockId: block.sourceBlockId,
        sourceBlockLine: block.sourceBlockLine,
        sourceBlockLineCount: block.sourceBlockLineCount
      }))
    ).toEqual([
      {
        sourceId: "src-0001",
        sourceBlockId: "0001",
        sourceBlockLine: 1,
        sourceBlockLineCount: 3
      },
      {
        sourceId: "src-0003",
        sourceBlockId: "0003",
        sourceBlockLine: 1,
        sourceBlockLineCount: 3
      }
    ]);
  });

  it("keeps image-only markdown blocks renderable in live preview", () => {
    const markdownBlocks: SessionSourceMarkdownBlock[] = [
      {
        blockId: "0005",
        sourceId: "src-0005",
        path: "blocks/0005_user_note.md",
        source: "user",
        header: "user",
        locked: false
      }
    ];
    const sourceText = [
      "--- source: user | block: 0005 ---",
      "![图](../assets/embedded/diagram.png)."
    ].join("\n");

    const rendered = renderBlocksFromSessionSourceText({ markdownBlocks, sourceText });

    expect(rendered).toHaveLength(1);
    expect(rendered[0].markdown).toContain("![图](../assets/embedded/diagram.png).");
  });
});

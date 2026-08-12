import { describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { createSessionDocument } from "./sessionDocument";

describe("createSessionDocument", () => {
  it("maps PDF blocks to read-only continuous preview metadata", () => {
    const session = createSessionRecord({
      id: "lecture",
      title: "PDF lecture",
      createdAt: "2026-07-14T10:00:00.000Z"
    });
    session.blocks.push(
      createBlockRef({
        id: "0001",
        type: "pdf",
        path: "assets/pdfs/lecture.pdf",
        source: "pdf_import",
        sourceName: "lecture original.pdf",
        pageCount: 18,
        createdAt: "2026-07-14T10:01:00.000Z"
      })
    );

    const document = createSessionDocument({ notebookId: "functional_analysis", session, markdownByPath: {} });

    expect(document.sourceLines.find((line) => line.id === "src-0001")).toMatchObject({
      linkTarget: "lecture original.pdf"
    });
    expect(document.renderBlocks).toContainEqual(
      expect.objectContaining({
        sourceBlockId: "0001",
        sourceLabel: "lecture original.pdf",
        pdf: { assetPath: "assets/pdfs/lecture.pdf", pageCount: 18 }
      })
    );
    expect(document.editableBlocks).toEqual([]);
  });

  it("keeps recognition-only PDFs clickable in source without embedding the original document", () => {
    const session = createSessionRecord({
      id: "lecture",
      title: "PDF recognition",
      createdAt: "2026-07-15T10:00:00.000Z"
    });
    session.blocks.push(
      createBlockRef({
        id: "0001",
        type: "pdf",
        path: "assets/pdfs/handwritten.pdf",
        source: "pdf_import",
        sourceName: "handwritten.pdf",
        pageCount: 50,
        renderInNote: false,
        createdAt: "2026-07-15T10:01:00.000Z"
      })
    );

    const document = createSessionDocument({ notebookId: "functional_analysis", session, markdownByPath: {} });

    expect(document.sourceLines.find((line) => line.id === "src-0001")).toMatchObject({
      linkTarget: "handwritten.pdf"
    });
    expect(document.renderBlocks).toEqual([]);
  });

  it("maps image blocks to source only and markdown blocks to preview", () => {
    const session = createSessionRecord({
      id: "lecture",
      title: "泛函分析 第 3 讲",
      createdAt: "2026-06-26T10:00:00.000Z"
    });
    session.blocks.push(
      createBlockRef({
        id: "0001",
        type: "image",
        path: "assets/photos/photo_001.jpg",
        source: "android_camera",
        createdAt: "2026-06-26T10:01:00.000Z"
      }),
      createBlockRef({
        id: "0002",
        type: "markdown",
        path: "blocks/0002_ai_transcript.md",
        source: "ai_transcription",
        fromAssets: ["assets/photos/photo_001.jpg"],
        createdAt: "2026-06-26T10:02:00.000Z"
      })
    );

    const document = createSessionDocument({
      notebookId: "functional_analysis",
      session,
      markdownByPath: {
        "blocks/0002_ai_transcript.md": [
          "source: photo_001.jpg",
          "",
          "#### 推导片段（来自 OCR 草稿）",
          "",
          "设 T_n 为有界线性算子。",
          '<!-- lock:start id="lock_20260626_001" hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" -->',
          "定义内容已确认。",
          '<!-- lock:end id="lock_20260626_001" -->',
          "$$ ||T_n|| <= C $$"
        ].join("\n")
      }
    });

    expect(document.sourceLines.map((line) => line.text).join("\n")).toContain("source:");
    expect(document.sourceLines.some((line) => line.linkTarget === "photo_001.jpg")).toBe(true);
    expect(document.renderBlocks).toHaveLength(1);
    expect(document.renderBlocks[0]).toMatchObject({
      sourceId: "src-0002",
      markdown: ["#### 推导片段（来自 OCR 草稿）", "", "设 T_n 为有界线性算子。", "定义内容已确认。", "$$ ||T_n|| <= C $$"].join("\n"),
      title: "推导片段（来自 OCR 草稿）",
      paragraphs: ["设 T_n 为有界线性算子。", "定义内容已确认。"],
      formulas: ["||T_n|| <= C"]
    });
    expect(document.renderBlocks[0].paragraphs?.some((paragraph) => paragraph.startsWith("source:"))).toBe(false);
    expect(document.renderBlocks[0].paragraphs?.some((paragraph) => paragraph.startsWith("<!-- lock:"))).toBe(false);
    expect(document.editableBlocks).toEqual([
      {
        id: "0002",
        sourceId: "src-0002",
        sourceLine: 4,
        path: "blocks/0002_ai_transcript.md",
        source: "ai_transcription",
        markdown: [
          "source: photo_001.jpg",
          "",
          "#### 推导片段（来自 OCR 草稿）",
          "",
          "设 T_n 为有界线性算子。",
          '<!-- lock:start id="lock_20260626_001" hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" -->',
          "定义内容已确认。",
          '<!-- lock:end id="lock_20260626_001" -->',
          "$$ ||T_n|| <= C $$"
        ].join("\n")
      }
    ]);
    expect(document.sourceLines.find((line) => line.id === "src-0002")?.editableBlockId).toBe("0002");
    expect(document.sourceDocument.text).toContain("--- source: photo_001.jpg | block: 0002 ---");
    expect(document.sourceDocument.text).not.toContain("| path: blocks/0002_ai_transcript.md");
    expect(document.sourceDocument.text).not.toContain("| kind: ai_transcription");
    expect(document.sourceDocument.markdownBlocks[0]).toMatchObject({
      blockId: "0002",
      path: "blocks/0002_ai_transcript.md"
    });
  });

  it("renders fenced markdown as a preview code block instead of loose paragraphs", () => {
    const session = createSessionRecord({
      id: "lecture",
      title: "测试",
      createdAt: "2026-06-30T10:00:00.000Z"
    });
    session.blocks.push(
      createBlockRef({
        id: "0001",
        type: "markdown",
        path: "blocks/0001_user_note.md",
        source: "user",
        createdAt: "2026-06-30T10:01:00.000Z"
      })
    );

    const document = createSessionDocument({
      notebookId: "functional_analysis",
      session,
      markdownByPath: {
        "blocks/0001_user_note.md": [
          "## 新 Session",
          "",
          "```markdown",
          "‹ 返回                                      ×",
          "",
          "Webhook 地址",
          "```"
        ].join("\n")
      }
    });

    expect(document.renderBlocks[0].items).toContainEqual({
      kind: "code",
      text: "‹ 返回                                      ×\n\nWebhook 地址",
      language: "markdown"
    });
    expect(document.renderBlocks[0].paragraphs).toBeUndefined();
  });
});

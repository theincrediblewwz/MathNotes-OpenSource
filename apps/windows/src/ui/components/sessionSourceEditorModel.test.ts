import { describe, expect, it } from "vitest";
import type { SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";
import {
  buildEditorBodyFromSourceText,
  buildSourceTextFromBlockMarkdowns,
  buildSourceTextFromEditorBody,
  findActiveMarkdownBlockAtPosition,
  findBodyBlockAtPosition,
  isLockableMarkdownSelection,
  isLockableBodySelection,
  readSourceReferenceFromHeaderLine
} from "./sessionSourceEditorModel";

const blocks: SessionSourceMarkdownBlock[] = [
  {
    blockId: "sample-ocr-1",
    sourceId: "src-ocr-1",
    path: "blocks/sample_ocr_1.md",
    source: "ai_transcription",
    header: "photo_001.png",
    locked: false
  },
  {
    blockId: "sample-note",
    sourceId: "src-note",
    path: "blocks/sample_note.md",
    source: "user",
    header: "user_note",
    locked: false
  }
];

const sourceText = [
  "--- asset: photo_001.png | block: sample-photo | type: image ---",
  "",
  "--- source: photo_001.png | block: sample-ocr-1 ---",
  "## OCR 草稿",
  "",
  "正文第一段。",
  "",
  "--- source: user_note | block: sample-note ---",
  "用户补充。"
].join("\n");

describe("sessionSourceEditorModel", () => {
  it("does not report an active markdown block while the cursor is on a source header", () => {
    const headerPosition = sourceText.indexOf("--- source: photo_001.png");

    expect(findActiveMarkdownBlockAtPosition(headerPosition, sourceText, blocks)).toBeNull();
  });

  it("reports the markdown block only after the cursor enters its body", () => {
    const bodyPosition = sourceText.indexOf("正文第一段。") + 1;

    expect(findActiveMarkdownBlockAtPosition(bodyPosition, sourceText, blocks)).toMatchObject({
      blockId: "sample-ocr-1",
      path: "blocks/sample_ocr_1.md"
    });
  });

  it("parses source and asset header lines as clickable references", () => {
    expect(
      readSourceReferenceFromHeaderLine(
        "--- source: photo_001.png | block: sample-ocr-1 ---"
      )
    ).toEqual({
      kind: "source",
      target: "photo_001.png",
      blockId: "sample-ocr-1"
    });
    expect(
      readSourceReferenceFromHeaderLine(
        "--- source: photo_001.png | block: sample-ocr-1 | path: blocks/sample_ocr_1.md | kind: ai_transcription ---"
      )
    ).toEqual({
      kind: "source",
      target: "photo_001.png",
      blockId: "sample-ocr-1"
    });

    expect(readSourceReferenceFromHeaderLine("--- asset: photo_002.png | block: sample-photo-2 | type: image ---")).toEqual({
      kind: "asset",
      target: "photo_002.png",
      blockId: "sample-photo-2"
    });
  });

  it("keeps active block ranges stable when a source header has tolerated spacing", () => {
    const tolerantText = [
      "---- source: photo_001.png |block: sample-ocr-1 |path:blocks/sample_ocr_1.md | kind: ai_transcription ---",
      "## OCR 草稿",
      "",
      "--- source: user_note | block: sample-note ---",
      "用户补充。"
    ].join("\n");

    expect(
      readSourceReferenceFromHeaderLine(
        "---- source: photo_001.png |block: sample-ocr-1 |path:blocks/sample_ocr_1.md | kind: ai_transcription ---"
      )
    ).toEqual({
      kind: "source",
      target: "photo_001.png",
      blockId: "sample-ocr-1"
    });
    expect(findActiveMarkdownBlockAtPosition(tolerantText.indexOf("## OCR 草稿"), tolerantText, blocks)).toMatchObject({
      blockId: "sample-ocr-1"
    });
    expect(findActiveMarkdownBlockAtPosition(tolerantText.indexOf("用户补充。"), tolerantText, blocks)).toMatchObject({
      blockId: "sample-note"
    });
  });

  it("allows locking only when the selection stays inside one markdown body", () => {
    const bodyFrom = sourceText.indexOf("正文第一段。");
    const bodyTo = bodyFrom + "正文第一段。".length;
    const headerFrom = sourceText.indexOf("--- source: photo_001.png");
    const nextBody = sourceText.indexOf("用户补充。");

    expect(isLockableMarkdownSelection({ from: bodyFrom, to: bodyTo, text: sourceText, blocks })).toBe(true);
    expect(isLockableMarkdownSelection({ from: bodyFrom, to: bodyFrom, text: sourceText, blocks })).toBe(false);
    expect(isLockableMarkdownSelection({ from: headerFrom, to: bodyTo, text: sourceText, blocks })).toBe(false);
    expect(isLockableMarkdownSelection({ from: bodyFrom, to: nextBody + 1, text: sourceText, blocks })).toBe(false);
  });

  it("maps source text headers to widget-backed editor body ranges", () => {
    const body = buildEditorBodyFromSourceText(sourceText, blocks);

    expect(body.text).not.toContain("--- source:");
    expect(body.text).toContain("## OCR 草稿");
    expect(body.text).toContain("用户补充。");
    expect(body.ranges.map((range) => ({ blockId: range.blockId, from: range.from, to: range.to }))).toEqual([
      { blockId: "sample-ocr-1", from: 0, to: body.text.indexOf("用户补充。") },
      { blockId: "sample-note", from: body.text.indexOf("用户补充。"), to: body.text.length }
    ]);
    expect(findBodyBlockAtPosition(body.text.indexOf("正文第一段。"), body.ranges)).toMatchObject({
      blockId: "sample-ocr-1"
    });
    expect(isLockableBodySelection({ from: 0, to: "## OCR 草稿".length, ranges: body.ranges })).toBe(true);
    expect(isLockableBodySelection({ from: 0, to: body.text.length, ranges: body.ranges })).toBe(false);
  });

  it("serializes widget-backed editor body text back to source text", () => {
    const body = buildEditorBodyFromSourceText(sourceText, blocks);
    const updatedBodyText = body.text.replace("正文第一段。", "正文第二段。");

    expect(buildSourceTextFromEditorBody(updatedBodyText, body.ranges)).toContain(
      "--- source: photo_001.png | block: sample-ocr-1 ---\n## OCR 草稿"
    );
    expect(buildSourceTextFromEditorBody(updatedBodyText, body.ranges)).toContain("正文第二段。");
    expect(buildSourceTextFromEditorBody(updatedBodyText, body.ranges)).toContain(
      "--- source: user_note | block: sample-note ---\n用户补充。"
    );
  });

  it("serializes per-block editor markdown values without exposing headers as editor content", () => {
    const updated = buildSourceTextFromBlockMarkdowns(blocks, {
      "sample-ocr-1": "## OCR 草稿\n\n正文第二段。",
      "sample-note": "用户补充。\n\n继续补充。"
    });

    expect(updated).toBe(
      [
        "--- source: photo_001.png | block: sample-ocr-1 ---",
        "## OCR 草稿",
        "",
        "正文第二段。",
        "",
        "--- source: user_note | block: sample-note ---",
        "用户补充。",
        "",
        "继续补充。"
      ].join("\n")
    );
  });
});

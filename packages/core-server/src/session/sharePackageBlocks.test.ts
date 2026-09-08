import { describe, expect, it } from "vitest";
import { restoreShareBlocks } from "./sharePackageBlocks";

describe("share block restoration", () => {
  it("restores Windows marker IDs, sources and ordered Markdown without displaying metadata", () => {
    const restored = restoreShareBlocks("<!-- block:id=0002 source=ai_transcription -->\n\n# 第一块\n\n<!-- block:id=0009 source=user_revision -->\n\n第二块 $x^2$\n");
    expect(restored.blocks).toEqual([
      { id: "0002", source: "ai_transcription", markdown: "\n# 第一块\n\n" },
      { id: "0009", source: "user_revision", markdown: "\n第二块 $x^2$\n" }
    ]);
    expect(restored.mergedContinuationGroups).toBe(0);
  });
  it("preserves CRLF, Unicode, preamble and an empty block", () => {
    const markdown = "前言😀\r\n\r\n<!-- block:id=a source=user -->\r\n\r\n\r\n<!-- block:id=b source=mixed -->\r\n\r\n结尾\r\n";
    const { blocks } = restoreShareBlocks(markdown);
    expect(blocks.map(b => b.id)).toEqual(["import_preamble", "a", "b"]);
    expect(blocks.map(b => b.markdown)).toEqual(["前言😀\r\n\r\n", "\r\n\r\n", "\r\n结尾\r\n"]);
  });
  it("does not mistake code, display math or blockquote examples for metadata", () => {
    const text = "```md\n<!-- block:id=code source=user -->\n```\n\n$$\n<!-- block:id=math source=user -->\n$$\n\n> <!-- block:id=quote source=user -->\n";
    expect(restoreShareBlocks(text).blocks).toEqual([{ id: "0001", source: "user", markdown: text }]);
  });
  it("keeps merged continuations intact when Windows omitted their internal offsets", () => {
    const { blocks, mergedContinuationGroups } = restoreShareBlocks("<!-- block:id=a source=user -->\n<!-- block:id=b source=user -->\n\n$$a+b$$\n\n<!-- block:id=c source=user -->\n\nnext");
    expect(blocks.map(b => b.id)).toEqual(["a", "c"]);
    expect(blocks[0].markdown).toContain("$$a+b$$");
    expect(mergedContinuationGroups).toBe(1);
  });
  it("remaps unsafe and repeated IDs without losing content", () => {
    const { blocks } = restoreShareBlocks("<!-- block:id=../../evil source=unknown -->\n\nfirst\n\n<!-- block:id=a source=user -->\n\nsecond\n\n<!-- block:id=a source=user -->\n\nthird");
    expect(new Set(blocks.map(b => b.id)).size).toBe(3);
    expect(blocks.every(b => /^[a-zA-Z0-9_-]+$/.test(b.id))).toBe(true);
    expect(blocks.map(b => b.markdown.trim())).toEqual(["first", "second", "third"]);
  });
  it("leaves unmarked Markdown and ordinary HTML untouched", () => {
    for (const text of ["# heading\n\n---\n\nother", "<div>\n<!-- block:id=literal source=user -->\n</div>"]) {
      expect(restoreShareBlocks(text).blocks[0].markdown).toBe(text);
      expect(restoreShareBlocks(text).blocks).toHaveLength(1);
    }
  });
});

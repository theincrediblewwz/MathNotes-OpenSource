import { describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { createSessionDocument } from "./sessionDocument";
import { parseSessionSourceText } from "./sessionSourceDocument";
import { createSessionLivePreviewProjector, renderBlocksFromSessionSourceText } from "./sessionLivePreview";
import { buildEditorBodyFromSourceText, buildSourceTextFromEditorBody, buildMarkdownProjection, buildSourceTextFromBlockMarkdowns } from "../ui/components/sessionSourceEditorModel";
import { findPreviewFocusTarget, renderMarkdownPreview } from "../ui/components/PreviewPane";
const originals = ["前文🙂\n\n$$\\frac{中文+x}{y}=z$$\n后文  \n", "| 标题 | 值 |\n| --- | --- |\n| 中文🙂 | 完整内容 |\n", "\r\n  中文🙂前文\r\n\r\n最后两空格  \r\n"];
function fixture(original: string, cut: number) {
  const session = createSessionRecord({ id: "s", title: "拆分", createdAt: "now" });
  const pieces = [original.slice(0, cut), original.slice(cut, cut + 2), original.slice(cut + 2)];
  session.blocks = pieces.map((_, index) => ({ ...createBlockRef({ id: String(index), type: "markdown", path: `blocks/${index}.md`, continuationGroup: "group", source: "user", createdAt: "now", fromAssets: ["assets/photo.png"] }), ...(index === 1 ? { status: "locked" as const } : {}) }));
  const markdownByPath = Object.fromEntries(session.blocks.map((block, index) => [block.path, pieces[index]]));
  return { session, pieces, markdownByPath };
}
describe("continuation production rendering and source mapping", () => {
  for (const original of originals) for (const cut of [0, Math.floor(original.length / 2), original.length - 2]) {
    it(`round-trips all bytes at split ${cut}: ${JSON.stringify(original)}`, () => {
      const { session, markdownByPath, pieces } = fixture(original, cut);
      const document = createSessionDocument({ notebookId: "n", session, markdownByPath });
      expect(document.renderBlocks).toHaveLength(1);
      expect(document.renderBlocks[0].markdown).toBe(original);
      expect(document.renderBlocks[0].sourceBlocks?.map(block => [block.blockId, block.locked])).toEqual([["0", false], ["1", true], ["2", false]]);
      const metadata = document.sourceDocument.markdownBlocks;
      expect(parseSessionSourceText(document.sourceDocument.text, metadata).map(update => update.markdown)).toEqual(pieces);
      const body = buildEditorBodyFromSourceText(document.sourceDocument.text, metadata);
      expect(parseSessionSourceText(buildSourceTextFromEditorBody(body.text, body.ranges), metadata).map(update => update.markdown)).toEqual(pieces);
      const projection = buildMarkdownProjection(document.sourceDocument.text, metadata);
      const serialized = buildSourceTextFromBlockMarkdowns(metadata, projection);
      expect(parseSessionSourceText(serialized, metadata).map(update => update.markdown)).toEqual(pieces);
      const live = createSessionLivePreviewProjector().project({ sourceText: serialized, markdownBlocks: metadata, markdownByBlockId: projection });
      expect(live.blocks[0].markdown).toBe(original);
      expect(renderBlocksFromSessionSourceText({ sourceText: serialized, markdownBlocks: metadata })[0].markdown).toBe(original);
      const expectedHtml = renderMarkdownPreview(original);
      expect(renderMarkdownPreview(live.blocks[0].markdown!)).toBe(expectedHtml);
      if (original.includes("$$")) expect(expectedHtml).toContain('class="katex');
      if (original.includes("| ---")) expect(expectedHtml).toContain("<table>");
      expect(findPreviewFocusTarget(live.blocks, { blockId: "1", sourceId: "src-1", displayBlockId: "1" })?.index).toBe(0);
    });
  }
  it("keeps asset and hidden-block barriers in live metadata", () => {
    const { session, markdownByPath } = fixture("abcdefghijkl", 4);
    session.blocks.splice(1, 0, createBlockRef({ id: "asset", type: "image", path: "assets/x.png", source: "user", createdAt: "now" }));
    let document = createSessionDocument({ notebookId: "n", session, markdownByPath });
    expect(document.renderBlocks.map(block => block.markdown)).toEqual(["abcd", "efghijkl"]);
    session.blocks[2].renderInNote = false;
    document = createSessionDocument({ notebookId: "n", session, markdownByPath });
    const result = renderBlocksFromSessionSourceText({ sourceText: document.sourceDocument.text, markdownBlocks: document.sourceDocument.markdownBlocks });
    expect(result.map(block => block.markdown)).toEqual(["abcd", "ghijkl"]);
  });
  it("preserves unchanged locked legacy whitespace for save", () => {
    const { session, markdownByPath } = fixture("legacy\r\n  \r\n", 0);
    session.blocks = [session.blocks[1]];
    session.blocks[0].continuationGroup = undefined;
    markdownByPath[session.blocks[0].path] = "legacy\r\n  \r\n";
    const document = createSessionDocument({ notebookId: "n", session, markdownByPath });
    expect(parseSessionSourceText(document.sourceDocument.text, document.sourceDocument.markdownBlocks)[0].markdown).toBe("legacy\r\n  \r\n");
  });
});

import { describe, expect, it } from "vitest";
import { isExternalFileDrop, markdownDropRenderBlocks, markdownDropTitle, readMarkdownDropFiles } from "./markdownDrop";

describe("Markdown desktop drop", () => {
  it("keeps internal block and selection drags out of the external file importer", () => {
    expect(isExternalFileDrop({ types: ["application/x-mathnotes-assistant-context", "text/plain"] })).toBe(false);
    expect(isExternalFileDrop({ types: ["application/x-mathnotes-assistant-context", "Files"] })).toBe(false);
    expect(isExternalFileDrop({ types: ["text/plain"] })).toBe(false);
    expect(isExternalFileDrop({ types: ["Files"] })).toBe(true);
  });
  it("reads md and markdown files in drop order", async () => {
    const documents = await readMarkdownDropFiles([
      new File(["# One"], "One.MD"),
      new File(["## Two"], "two.markdown")
    ]);
    expect(documents.map((item) => item.name)).toEqual(["One.MD", "two.markdown"]);
    expect(markdownDropTitle(documents)).toBe("One");
    expect(markdownDropRenderBlocks(documents).map((block) => block.sourceLabel))
      .toEqual(["One.MD", "two.markdown"]);
  });

  it("rejects the complete batch when a file is unsupported or empty", async () => {
    await expect(readMarkdownDropFiles([new File(["plain"], "note.txt")]))
      .rejects.toThrow(".md 或 .markdown");
    await expect(readMarkdownDropFiles([new File(["  \n"], "empty.md")]))
      .rejects.toThrow("空文档");
  });
});

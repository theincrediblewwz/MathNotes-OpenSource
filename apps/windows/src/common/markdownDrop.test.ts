import { describe, expect, it } from "vitest";
import { markdownDropRenderBlocks, markdownDropTitle, readMarkdownDropFiles } from "./markdownDrop";

describe("Markdown desktop drop", () => {
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

import { describe, expect, it } from "vitest";
import { analyzeFaithfulMarkdown } from "./faithfulMarkdownAnalysis";

describe("analyzeFaithfulMarkdown", () => {
  it("does not treat mathematical angle brackets as raw HTML", () => {
    const result = analyzeFaithfulMarkdown("$<Lx,x> < 0$");

    expect(result.rawHtmlTokens).toEqual([]);
    expect(result.formulas[0]).toMatchObject({
      content: "<Lx,x> < 0",
      display: false,
      validKatex: true
    });
  });

  it("reports actual raw HTML without rendering it", () => {
    const result = analyzeFaithfulMarkdown("before\n\n<div>unsafe</div>");

    expect(result.rawHtmlTokens).toEqual(["html_block"]);
  });

  it("reports inline raw HTML from inline token children", () => {
    const result = analyzeFaithfulMarkdown("before <span>unsafe</span> after");

    expect(result.rawHtmlTokens).toEqual(["html_inline", "html_inline"]);
  });

  it("does not swallow inline HTML after a same-line display formula", () => {
    const result = analyzeFaithfulMarkdown("$$x$$<span>unsafe</span>");

    expect(result.formulas).toEqual([
      expect.objectContaining({ content: "x", display: true, validKatex: true })
    ]);
    expect(result.rawHtmlTokens).toEqual(["html_inline", "html_inline"]);
  });

  it("does not swallow inline HTML after a multiline display formula", () => {
    const result = analyzeFaithfulMarkdown("$$\nx\n$$<span>unsafe</span>");

    expect(result.formulas).toEqual([
      expect.objectContaining({ content: "x", display: true, validKatex: true })
    ]);
    expect(result.rawHtmlTokens).toEqual(["html_inline", "html_inline"]);
  });

  it("separates malformed formula syntax from delimiter warnings", () => {
    const result = analyzeFaithfulMarkdown("$$\\frac{x}{$$");

    expect(result.formulas[0].validKatex).toBe(false);
    expect(result.formulas[0].parseError).toBeTruthy();
    expect(result.delimiterWarnings).toEqual([]);
  });

  it("ignores math-like delimiters inside code spans and fenced code", () => {
    const result = analyzeFaithfulMarkdown([
      "`$$` and `\\[`",
      "",
      "```text",
      "$$",
      "\\[",
      "```"
    ].join("\n"));

    expect(result.delimiterWarnings).toEqual([]);
  });

  it("ignores math-like delimiters inside a multiline CommonMark code span", () => {
    const result = analyzeFaithfulMarkdown("`code\n$$\ncode`");

    expect(result.delimiterWarnings).toEqual([]);
  });

  it("reports an unclosed single-dollar inline formula", () => {
    const result = analyzeFaithfulMarkdown("before $x");

    expect(result.delimiterWarnings).toContain("检测到未闭合的 $...$ inline math 分隔符。");
  });

  it("collects structure and faithful uncertainty markers", () => {
    const result = analyzeFaithfulMarkdown([
      "## 定理",
      "",
      "[看不清] [不确定：x]",
      "",
      "[图片：坐标轴与两条曲线]",
      "",
      "$$x^2$$"
    ].join("\n"));

    expect(result.structureTokens).toHaveLength(4);
    expect(result.structureTokens).toEqual(["heading_h2", "paragraph", "paragraph", "math_block"]);
    expect(result.markers).toEqual({ unreadable: 1, uncertain: 1, imageDescription: 1 });
  });
});

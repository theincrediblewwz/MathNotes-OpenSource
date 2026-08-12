import { describe, expect, it } from "vitest";
import { scoreFaithfulTranscription } from "./transcriptionQualityScore";

describe("scoreFaithfulTranscription", () => {
  it("keeps x and X distinct while scoring one formula token error", () => {
    const score = scoreFaithfulTranscription("$$X \\in H$$", "$$x \\in H$$");

    expect(score.formulas.exactRate).toBe(0);
    expect(score.formulas.withinOneErrorRate).toBe(1);
    expect(score.formulas.tokenErrorCount).toBe(1);
  });

  it("penalizes reordered markdown structures", () => {
    const score = scoreFaithfulTranscription("text\n\n## H", "## H\n\ntext");

    expect(score.structure.sequenceExact).toBe(false);
    expect(score.structure.lcsRatio).toBe(0.5);
  });

  it("detects reading-order changes between blocks of the same type", () => {
    const score = scoreFaithfulTranscription("$$A$$\n\n$$B$$", "$$B$$\n\n$$A$$");

    expect(score.structure.sequenceExact).toBe(false);
    expect(score.structure.lcsRatio).toBe(0.5);
  });

  it("does not count a small OCR typo as a reading-order change", () => {
    const score = scoreFaithfulTranscription("$$A'$$\n\n$$B$$", "$$A$$\n\n$$B$$");

    expect(score.structure.sequenceExact).toBe(true);
    expect(score.structure.lcsRatio).toBe(1);
  });

  it("gives exact formulas full credit", () => {
    const score = scoreFaithfulTranscription(
      "$$\\langle x,x\\rangle$$",
      "$$\\langle x,x\\rangle$$"
    );

    expect(score.formulas.exactRate).toBe(1);
    expect(score.formulas.withinOneErrorRate).toBe(1);
    expect(score.formulas.tokenErrorRate).toBe(0);
  });

  it("counts missing and extra formulas as alignment errors", () => {
    const score = scoreFaithfulTranscription("text only", "$$x^2$$\n\n$$y^2$$");

    expect(score.formulas.actualCount).toBe(0);
    expect(score.formulas.goldCount).toBe(2);
    expect(score.formulas.exactRate).toBe(0);
    expect(score.formulas.tokenErrorCount).toBeGreaterThan(0);
  });

  it("keeps formula order while ignoring how the actual output splits math spans", () => {
    const score = scoreFaithfulTranscription("$A$ and $B$", "$A \\qquad B$");

    expect(score.formulas.actualCount).toBe(2);
    expect(score.formulas.goldCount).toBe(1);
    expect(score.formulas.exactRate).toBe(1);
    expect(score.formulas.tokenErrorCount).toBe(0);
  });

  it("normalizes portable math delimiters and harmless whitespace for content comparison", () => {
    const score = scoreFaithfulTranscription("A  \r\n\r\n\\(x^2\\)\r\n", "A\n\n$x^2$\n");

    expect(score.content.similarity).toBe(1);
  });

  it("reports renderability, marker deltas, and faithful contract warnings", () => {
    const score = scoreFaithfulTranscription(
      "<div>bad</div>\n\n$$\\frac{x}{$$\n\n[不确定：x]",
      "$$x$$\n\n[看不清]\n\n[图片：坐标轴]"
    );

    expect(score.renderability.invalidFormulaCount).toBe(1);
    expect(score.markers).toEqual({ unreadableDelta: -1, uncertainDelta: 1, imageDescriptionDelta: -1 });
    expect(score.warnings).toContain("不应输出 raw HTML。");
    expect(score.warnings).toContain("检测到无法由 KaTeX 解析的数学公式。");
  });
});

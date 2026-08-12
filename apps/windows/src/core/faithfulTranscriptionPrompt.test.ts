import { describe, expect, it } from "vitest";
import { buildFaithfulTranscriptionPrompt, validateFaithfulTranscriptionOutput } from "./faithfulTranscriptionPrompt";

describe("buildFaithfulTranscriptionPrompt", () => {
  it("asks providers to preserve the source visual layout while transcribing faithfully", () => {
    const prompt = buildFaithfulTranscriptionPrompt("泛函分析");

    expect(prompt).toContain("尽量保持原照片中的换行、分组、缩进、编号、箭头、公式和分栏/列表/推导布局");
    expect(prompt).toContain("在行首使用 `&emsp;` 表达每个两字宽缩进");
    expect(prompt).toContain("上下文：泛函分析");
  });

  it("keeps notation references subordinate to the immutable faithful contract", () => {
    const prompt = buildFaithfulTranscriptionPrompt(undefined, undefined, {
      schemaVersion: "nh1-v1",
      query: "X_+",
      rules: [],
      conflicts: [],
      omittedByBudget: 0,
      characterCount: 36,
      selectionHash: "a".repeat(64),
      promptFragment: "领域消歧参考（只作辨认提示，图片证据优先）：\n- `X_+` 表示稳定子空间"
    });

    expect(prompt.indexOf("不要总结、润色、改写或补充证明")).toBeLessThan(prompt.indexOf("领域消歧参考"));
    expect(prompt).toContain("图片证据优先");
  });

  it("defines a renderer-compatible Markdown and math output contract", () => {
    const prompt = buildFaithfulTranscriptionPrompt();

    expect(prompt).toContain("行内公式统一使用 `$...$`");
    expect(prompt).toContain("独立公式、多行推导和居中公式统一使用 `$$...$$`");
    expect(prompt).toContain("不要使用 `\\(...\\)` 或 `\\[...\\]` 作为最终输出的数学分隔符");
    expect(prompt).toContain("命令、配置项、代码片段使用 Markdown inline code 或 fenced code block");
    expect(prompt).toContain("原图中被边框、浅色背景或输入框圈出的内容，用引用块、列表缩进或代码块保留为独立分组");
    expect(prompt).toContain("表单字段、按钮、标签和警告提示按视觉层级转成简洁的 Markdown");
    expect(prompt).toContain("[图片：");
    expect(prompt).toContain("图中出现无法用 Markdown 忠实表达的几何图、坐标轴、箭头关系或示意图");
    expect(prompt).toContain("不要输出 Markdown 代码围栏包住整篇转写");
    expect(prompt.length).toBeLessThan(760);
  });

  it("validates transcription output against the faithful Markdown contract", () => {
    const warnings = validateFaithfulTranscriptionOutput([
      "这里是转写结果：",
      "\\documentclass{article}",
      "\\[",
      "x^2",
      "\\]",
      "<div>raw html</div>",
      "$$",
      "y^2"
    ].join("\n"));

    expect(warnings).toContain("不应输出解释性前言，只输出 Markdown 草稿内容。");
    expect(warnings).toContain("不应生成完整 LaTeX 文档或包含 \\documentclass。");
    expect(warnings).toContain("检测到 \\[...\\]，Provider 输出应优先使用 $$...$$ 以便导出兼容。");
    expect(warnings).toContain("不应输出 raw HTML。");
    expect(warnings).toContain("检测到未闭合的 $$ display math 分隔符。");
  });

  it("distinguishes mathematical angle brackets from raw HTML and reports formula syntax separately", () => {
    expect(validateFaithfulTranscriptionOutput("$<Lx,x> < 0$")).not.toContain("不应输出 raw HTML。");
    expect(validateFaithfulTranscriptionOutput("<span>unsafe</span>")).toContain("不应输出 raw HTML。");
    expect(validateFaithfulTranscriptionOutput("$$\\frac{x}{$$")).toContain("检测到无法由 KaTeX 解析的数学公式。");
  });
});

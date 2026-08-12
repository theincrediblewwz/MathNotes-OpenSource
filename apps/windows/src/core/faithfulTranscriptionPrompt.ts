import { analyzeFaithfulMarkdown } from "./faithfulMarkdownAnalysis";
import type { NotationSelection } from "../common/notationProfiles";
import {
  buildFaithfulTranscriptionPrompt as buildCoreFaithfulTranscriptionPrompt,
  defaultFaithfulTranscriptionPromptContent
} from "@mathnotes/core-server/domain/faithful-transcription-prompt";

export { defaultFaithfulTranscriptionPromptContent };

export function buildFaithfulTranscriptionPrompt(
  context?: string,
  templateContent = defaultFaithfulTranscriptionPromptContent,
  notationSelection?: NotationSelection
): string {
  return buildCoreFaithfulTranscriptionPrompt(context, templateContent, notationSelection?.promptFragment);
}

export function validateFaithfulTranscriptionOutput(markdown: string): string[] {
  const warnings: string[] = [];
  const trimmed = markdown.trim();

  if (!trimmed) {
    warnings.push("Provider 输出为空。");
    return warnings;
  }

  if (/^(这里是|以下是|下面是|我将|好的|转写结果)([\s\S]{0,16})[：:，,]/.test(trimmed)) {
    warnings.push("不应输出解释性前言，只输出 Markdown 草稿内容。");
  }

  if (/\\documentclass|\\begin\{document\}|\\end\{document\}/.test(markdown)) {
    warnings.push("不应生成完整 LaTeX 文档或包含 \\documentclass。");
  }

  if (/\\\[[\s\S]*?\\\]/.test(markdown)) {
    warnings.push("检测到 \\[...\\]，Provider 输出应优先使用 $$...$$ 以便导出兼容。");
  }

  if (/\\\([\s\S]*?\\\)/.test(markdown)) {
    warnings.push("检测到 \\(...\\)，Provider 输出应优先使用 $...$ 以便导出兼容。");
  }

  const analysis = analyzeFaithfulMarkdown(markdown);

  if (analysis.rawHtmlTokens.length > 0) {
    warnings.push("不应输出 raw HTML。");
  }

  if (analysis.formulas.some((formula) => !formula.validKatex)) {
    warnings.push("检测到无法由 KaTeX 解析的数学公式。");
  }

  warnings.push(...analysis.delimiterWarnings);

  if (/^```[a-zA-Z0-9_-]*\s*[\s\S]*```$/.test(trimmed) && trimmed.split(/\r?\n/).length > 3) {
    warnings.push("不要输出 Markdown 代码围栏包住整篇转写。");
  }

  return warnings;
}

export const defaultFaithfulTranscriptionPromptContent = [
  "你将看到数学板书/手写笔记/书页照片。请忠实转写为 Markdown。",
  "不要总结、润色、改写或补充证明；保持原始顺序。",
  "尽量保持原照片中的换行、分组、缩进、编号、箭头、公式和分栏/列表/推导布局。",
  "可见的段首缩进不要丢失；普通空格会被 Markdown 折叠时，在行首使用 `&emsp;` 表达每个两字宽缩进。",
  "图中出现无法用 Markdown 忠实表达的几何图、坐标轴、箭头关系或示意图时，在对应位置写成 `[图片：...]`，简要说明图形内容、标注和它表达的数学关系；不要编造原图没有的结论。",
  "原图中被边框、浅色背景或输入框圈出的内容，用引用块、列表缩进或代码块保留为独立分组。",
  "表单字段、按钮、标签和警告提示按视觉层级转成简洁的 Markdown。",
  "行内公式统一使用 `$...$`。独立公式、多行推导和居中公式统一使用 `$$...$$`。",
  "不要使用 `\\(...\\)` 或 `\\[...\\]` 作为最终输出的数学分隔符；这些只作为本软件内部兼容输入。",
  "命令、配置项、代码片段使用 Markdown inline code 或 fenced code block；不要把普通文字乱包进数学公式。",
  "看不清的地方标记为 \"[看不清]\"。不确定的符号标记为 \"[不确定：...]\"。",
  "不要生成完整 LaTeX 文档，不要添加 \"\\documentclass\"，不要输出解释性废话，只输出 Markdown 草稿内容。",
  "不要输出 Markdown 代码围栏包住整篇转写；只有原图中确实是代码、命令或配置片段时才使用代码围栏。"
].join("\n");

export function buildFaithfulTranscriptionPrompt(
  context?: string,
  templateContent = defaultFaithfulTranscriptionPromptContent,
  domainGuidance?: string
): string {
  return [templateContent.trim(), domainGuidance, context ? `上下文：${context}` : ""]
    .filter(Boolean)
    .join("\n");
}

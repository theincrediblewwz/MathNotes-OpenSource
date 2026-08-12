import katex from "katex";
import MarkdownIt from "markdown-it";

type MarkdownInlineState = Parameters<Parameters<MarkdownIt["inline"]["ruler"]["before"]>[2]>[0];
type MarkdownBlockState = Parameters<Parameters<MarkdownIt["block"]["ruler"]["before"]>[2]>[0];

export type FaithfulFormulaAnalysis = {
  content: string;
  display: boolean;
  validKatex: boolean;
  parseError?: string;
};

export type FaithfulMarkdownAnalysis = {
  structureTokens: string[];
  structureBlocks: FaithfulStructureBlock[];
  formulas: FaithfulFormulaAnalysis[];
  rawHtmlTokens: Array<"html_block" | "html_inline">;
  delimiterWarnings: string[];
  markers: {
    unreadable: number;
    uncertain: number;
    imageDescription: number;
  };
};

export type FaithfulStructureBlock = {
  type: string;
  content: string;
};

const analysisParser = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false,
  breaks: false
});

analysisParser.inline.ruler.before("escape", "math_inline", mathInlineRule);
analysisParser.block.ruler.before("fence", "math_block", mathBlockRule, {
  alt: ["paragraph", "reference", "blockquote"]
});

export function analyzeFaithfulMarkdown(markdown: string): FaithfulMarkdownAnalysis {
  const tokens = analysisParser.parse(markdown, {});
  const structureTokens: string[] = [];
  const structureBlocks: FaithfulStructureBlock[] = [];
  const formulas: FaithfulFormulaAnalysis[] = [];
  const rawHtmlTokens: Array<"html_block" | "html_inline"> = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const structure = blockStructure(token, tokens[tokenIndex + 1]);
    if (structure) {
      structureTokens.push(structure.type);
      structureBlocks.push(structure);
    }

    if (token.type === "math_block") {
      formulas.push(analyzeFormula(token.content, true));
    }
    if (token.type === "html_block") {
      rawHtmlTokens.push("html_block");
    }

    for (const child of token.children ?? []) {
      if (child.type === "math_inline") {
        formulas.push(analyzeFormula(child.content, child.meta?.display === true));
      }
      if (child.type === "html_inline") {
        rawHtmlTokens.push("html_inline");
      }
      if (child.type === "image") {
        const imageBlock = { type: "image", content: `${child.attrGet("src") ?? ""} ${child.content}`.trim() };
        structureTokens.push(imageBlock.type);
        structureBlocks.push(imageBlock);
      }
    }
  }

  return {
    structureTokens,
    structureBlocks,
    formulas,
    rawHtmlTokens,
    delimiterWarnings: collectDelimiterWarnings(maskCodeForDelimiterScan(markdown)),
    markers: {
      unreadable: countMatches(markdown, /\[看不清\]/g),
      uncertain: countMatches(markdown, /\[不确定：[^\]]*\]/g),
      imageDescription: countMatches(markdown, /\[图片：[^\]]*\]/g)
    }
  };
}

function analyzeFormula(content: string, display: boolean): FaithfulFormulaAnalysis {
  const trimmed = content.trim();
  try {
    katex.renderToString(trimmed, {
      displayMode: display,
      output: "html",
      strict: false,
      throwOnError: true,
      trust: false
    });
    return { content: trimmed, display, validKatex: true };
  } catch (error) {
    return {
      content: trimmed,
      display,
      validKatex: false,
      parseError: error instanceof Error ? error.message : "Unknown KaTeX parse error"
    };
  }
}

function blockStructure(
  token: ReturnType<MarkdownIt["parse"]>[number],
  nextToken?: ReturnType<MarkdownIt["parse"]>[number]
): FaithfulStructureBlock | undefined {
  if (token.type === "heading_open") {
    return { type: `heading_${token.tag}`, content: nextToken?.type === "inline" ? nextToken.content : "" };
  }
  if (token.type === "paragraph_open") {
    return { type: "paragraph", content: nextToken?.type === "inline" ? nextToken.content : "" };
  }
  if (token.type === "bullet_list_open") return { type: "bullet_list", content: "" };
  if (token.type === "ordered_list_open") return { type: "ordered_list", content: "" };
  if (token.type === "blockquote_open") return { type: "blockquote", content: "" };
  if (token.type === "fence" || token.type === "code_block") {
    return { type: "fence", content: `${token.info} ${token.content}`.trim() };
  }
  if (token.type === "math_block") return { type: "math_block", content: token.content };
  return undefined;
}

function collectDelimiterWarnings(markdown: string): string[] {
  const warnings: string[] = [];
  if ((markdown.match(/\$\$/g) ?? []).length % 2 !== 0) {
    warnings.push("检测到未闭合的 $$ display math 分隔符。");
  }
  if ((markdown.match(/\\\[/g) ?? []).length !== (markdown.match(/\\\]/g) ?? []).length) {
    warnings.push("检测到未闭合的 \\[...\\] display math 分隔符。");
  }
  if ((markdown.match(/\\\(/g) ?? []).length !== (markdown.match(/\\\)/g) ?? []).length) {
    warnings.push("检测到未闭合的 \\(...\\) inline math 分隔符。");
  }
  if (countSingleDollarDelimiters(markdown) % 2 !== 0) {
    warnings.push("检测到未闭合的 $...$ inline math 分隔符。");
  }
  return warnings;
}

function countSingleDollarDelimiters(markdown: string): number {
  let count = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] !== "$" || markdown[index - 1] === "\\") continue;
    if (markdown[index + 1] === "$") {
      index += 1;
      continue;
    }
    count += 1;
  }
  return count;
}

function maskCodeForDelimiterScan(markdown: string): string {
  let fence: { character: "`" | "~"; length: number } | undefined;
  const withoutFences = markdown.split(/(\r?\n)/).map((part) => {
    if (/^\r?\n$/.test(part)) return part;
    const fenceMatch = part.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const closesFence = fenceMatch?.[1][0] === fence.character && fenceMatch[1].length >= fence.length;
      if (closesFence) fence = undefined;
      return " ".repeat(part.length);
    }
    if (fenceMatch) {
      fence = {
        character: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length
      };
      return " ".repeat(part.length);
    }
    return part;
  }).join("");
  return withoutFences.replace(/(`+)([\s\S]*?)\1/g, (match) => " ".repeat(match.length));
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function mathInlineRule(state: MarkdownInlineState, silent: boolean): boolean {
  const source = state.src;
  const start = state.pos;

  if (source.startsWith("$$", start)) {
    const close = source.indexOf("$$", start + 2);
    if (close === -1) return false;
    const content = source.slice(start + 2, close);
    if (!content.trim()) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.meta = { display: true };
    }
    state.pos = close + 2;
    return true;
  }

  if (source.startsWith("\\(", start)) {
    const close = source.indexOf("\\)", start + 2);
    if (close === -1) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = source.slice(start + 2, close);
    }
    state.pos = close + 2;
    return true;
  }

  if (source.charCodeAt(start) !== 0x24 || source[start + 1] === "$") {
    return false;
  }

  const close = findClosingDollar(source, start + 1);
  if (close === -1) return false;
  const content = source.slice(start + 1, close);
  if (!content.trim()) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = content;
  }
  state.pos = close + 1;
  return true;
}

function mathBlockRule(state: MarkdownBlockState, startLine: number, endLine: number, silent: boolean): boolean {
  const lineStart = state.bMarks[startLine] + state.tShift[startLine];
  const lineEnd = state.eMarks[startLine];
  const firstLine = state.src.slice(lineStart, lineEnd).trim();
  const opener = firstLine.startsWith("$$") ? "$$" : firstLine.startsWith("\\[") ? "\\[" : undefined;
  const closer = opener === "$$" ? "$$" : opener === "\\[" ? "\\]" : undefined;
  if (!opener || !closer) return false;

  const sameLineContent = firstLine.slice(opener.length);
  const sameLineClose = sameLineContent.indexOf(closer);
  if (sameLineClose !== -1) {
    if (sameLineContent.slice(sameLineClose + closer.length).trim()) {
      return false;
    }
    if (!silent) {
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = sameLineContent.slice(0, sameLineClose);
      token.map = [startLine, startLine + 1];
    }
    state.line = startLine + 1;
    return true;
  }

  const lines: string[] = [];
  if (sameLineContent.trim()) lines.push(sameLineContent);
  for (let nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
    const nextStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const nextEnd = state.eMarks[nextLine];
    const nextContent = state.src.slice(nextStart, nextEnd);
    const closeIndex = nextContent.indexOf(closer);
    if (closeIndex !== -1) {
      if (nextContent.slice(closeIndex + closer.length).trim()) {
        return false;
      }
      lines.push(nextContent.slice(0, closeIndex));
      if (!silent) {
        const token = state.push("math_block", "math", 0);
        token.block = true;
        token.content = lines.join("\n");
        token.map = [startLine, nextLine + 1];
      }
      state.line = nextLine + 1;
      return true;
    }
    lines.push(nextContent);
  }

  return false;
}

function findClosingDollar(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "$" && source[index - 1] !== "\\") return index;
  }
  return -1;
}

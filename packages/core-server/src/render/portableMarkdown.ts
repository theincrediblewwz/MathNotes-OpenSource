import katex from "katex";
import MarkdownIt from "markdown-it";
import { normalizeMathForPortableMarkdown } from "@mathnotes/shared";

type MarkdownInlineState = Parameters<Parameters<MarkdownIt["inline"]["ruler"]["before"]>[2]>[0];
type MarkdownBlockState = Parameters<Parameters<MarkdownIt["block"]["ruler"]["before"]>[2]>[0];

export type PortableImageRewrite = (source: string) => Promise<{
  source: string;
  missing?: boolean;
}>;

export async function renderPortableMarkdown(args: {
  markdown: string;
  rewriteImage?: PortableImageRewrite;
}): Promise<string> {
  const parser = createPortableMarkdownParser();
  const tokens = parser.parse(normalizeMathForPortableMarkdown(args.markdown), {});
  if (args.rewriteImage) await rewriteImages(tokens, args.rewriteImage);
  return parser.renderer.render(tokens, parser.options, {});
}

export function createPortableMarkdownParser(): MarkdownIt {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
  parser.inline.ruler.before("escape", "math_inline", mathInlineRule);
  parser.block.ruler.before("fence", "math_block", mathBlockRule, { alt: ["paragraph", "reference", "blockquote"] });
  parser.renderer.rules.math_inline = (tokens, index) => renderMath(tokens[index].content, false);
  parser.renderer.rules.math_block = (tokens, index) => renderMath(tokens[index].content, true);
  parser.renderer.rules.link_open = (tokens, index, options, _env, self) => {
    const hrefIndex = tokens[index].attrIndex("href");
    if (hrefIndex >= 0 && tokens[index].attrs) {
      const href = tokens[index].attrs![hrefIndex][1];
      if (!/^https?:\/\//i.test(href)) tokens[index].attrs![hrefIndex][1] = "#";
    }
    return self.renderToken(tokens, index, options);
  };
  return parser;
}

async function rewriteImages(tokens: ReturnType<MarkdownIt["parse"]>, rewrite: PortableImageRewrite): Promise<void> {
  for (const token of tokens) {
    if (token.children) await rewriteImages(token.children, rewrite);
    if (token.type !== "image") continue;
    const srcIndex = token.attrIndex("src");
    if (srcIndex < 0 || !token.attrs) continue;
    const result = await rewrite(token.attrs[srcIndex][1]);
    token.attrs[srcIndex][1] = result.source;
    if (result.missing) token.attrSet("data-asset-missing", "true");
  }
}

function renderMath(content: string, displayMode: boolean): string {
  try {
    const math = katex.renderToString(content.trim(), {
      displayMode,
      output: "htmlAndMathml",
      strict: false,
      throwOnError: true,
      trust: false
    });
    return displayMode ? `<div class="math-display">${math}</div>` : `<span class="math-inline">${math}</span>`;
  } catch {
    return `<code class="math-error">${escapeHtml(content.trim())}</code>`;
  }
}

function mathInlineRule(state: MarkdownInlineState, silent: boolean): boolean {
  const source = state.src;
  const start = state.pos;
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
  if (source[start] !== "$" || source[start + 1] === "$") return false;
  const close = findClosingDollar(source, start + 1);
  if (close === -1 || !source.slice(start + 1, close).trim()) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = source.slice(start + 1, close);
  }
  state.pos = close + 1;
  return true;
}

function mathBlockRule(state: MarkdownBlockState, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const end = state.eMarks[startLine];
  const first = state.src.slice(start, end).trim();
  const opener = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : undefined;
  const closer = opener === "$$" ? "$$" : opener ? "\\]" : undefined;
  if (!opener || !closer) return false;
  if (silent) return true;

  const content: string[] = [];
  const sameLine = first.slice(opener.length);
  if (sameLine.endsWith(closer)) {
    content.push(sameLine.slice(0, -closer.length));
    state.line = startLine + 1;
  } else {
    if (sameLine) content.push(sameLine);
    let line = startLine + 1;
    for (; line < endLine; line += 1) {
      const value = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (value.trim().endsWith(closer)) {
        content.push(value.trim().slice(0, -closer.length));
        line += 1;
        break;
      }
      content.push(value);
    }
    state.line = line;
  }
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content.join("\n");
  token.map = [startLine, state.line];
  return true;
}

function findClosingDollar(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "$" && source[index - 1] !== "\\") return index;
  }
  return -1;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

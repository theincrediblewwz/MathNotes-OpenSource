import type MarkdownIt from "markdown-it";

type MarkdownInlineState = Parameters<Parameters<MarkdownIt["inline"]["ruler"]["before"]>[2]>[0];
type MarkdownBlockState = Parameters<Parameters<MarkdownIt["block"]["ruler"]["before"]>[2]>[0];

export function mathInlineRule(state: MarkdownInlineState, silent: boolean): boolean {
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

export function mathBlockRule(state: MarkdownBlockState, startLine: number, endLine: number, silent: boolean): boolean {
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

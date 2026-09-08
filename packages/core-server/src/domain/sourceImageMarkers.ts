import MarkdownIt from "markdown-it";
import { encodeMarkdownAssetPath, sessionAssetPathFromMarkdown } from "./sessionAssetPath";

export const SOURCE_IMAGE_MARKER = "[[mathnotes:source-image]]";
export const sourceImageMarkerInstruction =
  `遇到图形，在图形说明后另起一段，只写 ${SOURCE_IMAGE_MARKER}，前后空行；软件会在此展示本次识别的整张已处理照片。保留图形说明，不给图片路径，不裁图、不猜坐标；没有图形时不添加此标记。`;

// Use the Markdown parser so literal markers inside code are never interpreted.
const parser = new MarkdownIt({ html: false });
// Formula content is opaque, including display formulas containing blank lines.
// This parser only locates active markers; it must never rewrite literal examples.
parser.block.ruler.before("paragraph", "mathnotes_math_literal", (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const first = state.src.slice(start, state.eMarks[startLine]);
  const opening = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : undefined;
  if (!opening) return false;
  if (silent) return true;
  const closing = opening === "$$" ? "$$" : "\\]";
  let nextLine = startLine;
  while (nextLine < endLine) {
    const text = state.src.slice(nextLine === startLine ? start + opening.length : state.bMarks[nextLine], state.eMarks[nextLine]);
    nextLine += 1;
    if (findUnescapedClosing(text, closing, 0) >= 0) break;
  }
  const token = state.push("mathnotes_math_literal", "", 0);
  token.map = [startLine, nextLine];
  state.line = nextLine;
  return true;
});
parser.inline.ruler.before("escape", "mathnotes_inline_math_literal", (state, silent) => {
  const start = state.pos;
  const opening = ["$$", "\\(", "\\[", "$"].find(value => state.src.startsWith(value, start));
  if (!opening) return false;
  const closing = opening === "\\(" ? "\\)" : opening === "\\[" ? "\\]" : opening;
  const end = findUnescapedClosing(state.src, closing, start + opening.length);
  if (end < 0) return false;
  if (!silent) state.push("mathnotes_math_literal", "", 0);
  state.pos = end + closing.length;
  return true;
});

function findUnescapedClosing(text: string, delimiter: string, start: number): number {
  let index = text.indexOf(delimiter, start);
  while (index >= 0) {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 0) return index;
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
}
parser.inline.ruler.before("link", "mathnotes_source_image", (state, silent) => {
  const start = state.pos;
  if (!state.src.startsWith(SOURCE_IMAGE_MARKER, start)) return false;
  const lineStart = state.src.lastIndexOf("\n", start - 1) + 1;
  const end = start + SOURCE_IMAGE_MARKER.length;
  const lineEnd = state.src.indexOf("\n", end);
  if (state.src.slice(lineStart, start).trim() || state.src.slice(end, lineEnd < 0 ? undefined : lineEnd).trim()) return false;
  if (!silent) {
    const token = state.push("mathnotes_source_image", "", 0);
    token.meta = { line: state.src.slice(0, start).split("\n").length - 1 };
  }
  state.pos = end;
  return true;
});

/** Bind only to the task's real, already processed asset, never to a model-supplied path. */
export function bindSourceImageMarkers(markdown: string, sourceAssetPath?: string): string {
  if (!markdown.includes(SOURCE_IMAGE_MARKER)) return markdown;
  const asset = sourceAssetPath?.replaceAll("\\", "/");
  const encodedAsset = asset === undefined ? undefined : encodeMarkdownAssetPath(asset);
  const safeAsset = asset !== undefined && /\.(?:png|jpe?g|webp)$/i.test(asset) &&
    sessionAssetPathFromMarkdown(encodedAsset!) === asset;
  const lines = markdown.split(/\r?\n/);
  const endings = markdown.match(/\r?\n/g) ?? [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type !== "inline" || !token.map) continue;
    for (const child of token.children ?? []) {
      if (child.type !== "mathnotes_source_image") continue;
      const index = token.map[0] + child.meta.line;
      // Only the specified standalone marker syntax is active (not quoted examples).
      if (!/^ {0,3}\[\[mathnotes:source-image\]\][ \t]*$/.test(lines[index] ?? "")) continue;
      lines[index] = safeAsset
        ? `![识别照片（已处理）](../${encodedAsset})`
        : "[识别照片暂不可用]";
    }
  }
  return lines.map((line, index) => line + (endings[index] ?? "")).join("");
}

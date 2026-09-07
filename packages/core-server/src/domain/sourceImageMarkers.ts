import MarkdownIt from "markdown-it";

export const SOURCE_IMAGE_MARKER = "[[mathnotes:source-image]]";
export const sourceImageMarkerInstruction =
  `遇到图形，在图形说明后另起一段，只写 ${SOURCE_IMAGE_MARKER}，前后空行；软件会在此展示本次识别的整张已处理照片。保留图形说明，不给图片路径，不裁图、不猜坐标；没有图形时不添加此标记。`;

// Use the Markdown parser so literal markers inside code are never interpreted.
const parser = new MarkdownIt({ html: false });
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
  const safeAsset = asset?.startsWith("assets/") && /\.(?:png|jpe?g|webp)$/i.test(asset) &&
    !asset.split("/").some(segment => !segment || segment === "." || segment === "..") &&
    !/[\u0000-\u0020<>"'`()?#%]/.test(asset);
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
        ? `![识别照片（已处理）](../${asset})`
        : "[识别照片暂不可用]";
    }
  }
  return lines.map((line, index) => line + (endings[index] ?? "")).join("");
}

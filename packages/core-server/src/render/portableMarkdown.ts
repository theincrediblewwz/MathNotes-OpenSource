import katex from "katex";
import MarkdownIt from "markdown-it";
import { normalizeMathForPortableMarkdown } from "@mathnotes/shared";

import { mathInlineRule, mathBlockRule } from "./markdownMathRules";
import { bindSourceImageMarkers } from "../domain/sourceImageMarkers";
export { originalImagePath } from "../domain/sourceImageMarkers";

export function materializeOriginalImageMarkers(markdown: string, path?: string): string {
  return bindSourceImageMarkers(markdown, path, { includeLegacyDescriptions: true });
}

export type PortableImageRewrite = (source: string) => Promise<{
  source: string;
  missing?: boolean;
}>;

export async function renderPortableMarkdown(args: {
  markdown: string;
  rewriteImage?: PortableImageRewrite;
  sourceImagePath?: string;
}): Promise<string> {
  const parser = createPortableMarkdownParser();
  const tokens = parser.parse(normalizeMathForPortableMarkdown(materializeOriginalImageMarkers(args.markdown, args.sourceImagePath)), {});
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


function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

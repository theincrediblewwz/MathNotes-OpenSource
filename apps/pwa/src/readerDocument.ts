import type { CachedAsset, CachedSession } from "./domain";
import { embeddedKatexReaderStyle } from "./katexReaderStyle";
import { READER_BRIDGE_SCRIPT, readerBridgeHash } from "./readerBridge";

export type ReaderDocument = Readonly<{
  html: string;
  missingAssets: number;
  dispose(): void;
}>;

export async function createReaderDocument(
  session: CachedSession,
  assets: readonly CachedAsset[],
  createDataUrl: (blob: Blob, mimeType: string) => Promise<string> = blobDataUrl,
  bridge?: { channel: string; anchor?: string }
): Promise<ReaderDocument> {
  const assetUrls = new Map<string, string>();
  for (const asset of assets) {
    const url = await createDataUrl(asset.bytes, asset.mimeType);
    assetUrls.set(asset.assetId, url);
  }

  let missingAssets = 0;
  const html = removeExternalFontFaces(session.html).replace(
    /mathnotes-companion-asset:\/\/([A-Za-z0-9._-]+)/g,
    (_match, assetId: string) => {
      const url = assetUrls.get(assetId);
      if (url) return escapeAttribute(url);
      missingAssets += 1;
      return "";
    }
  );
  const withOutline = addReaderOutline(addImagePreviews(html));
  const bridgeHash = bridge ? await readerBridgeHash() : undefined;
  const clean = bridge ? sanitizeReaderHtml(withOutline) : withOutline;
  const content = injectReaderPolicy(clean, missingAssets, bridgeHash);
  return {
    html: bridge ? content.replace(/<\/body>/i, `<script data-channel="${escapeAttribute(bridge.channel)}" data-anchor="${escapeAttribute(bridge.anchor ?? "")}">${READER_BRIDGE_SCRIPT}</script></body>`) : content,
    missingAssets,
    dispose() {}
  };
}

function blobDataUrl(blob: Blob, mimeType: string): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("无法读取离线图片"));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8_192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
    }
    return `data:${mimeType || blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
  });
}

function removeExternalFontFaces(html: string): string {
  return html.replace(/@font-face\s*\{[^{}]*\}/gi, "");
}

function addImagePreviews(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, image => {
    // Only cached/embedded images get a viewer. No navigation or iframe scripting is added.
    if (!/\bsrc\s*=\s*["'](?:data:image\/|blob:)/i.test(image)) return image;
    const expandedImage = image.replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<details class="mathnotes-image-preview"><summary aria-label="放大或关闭图片">${image}<span class="mathnotes-image-close">关闭大图</span></summary><div class="mathnotes-image-full" role="dialog" aria-label="图片大图">${expandedImage}</div></details>`;
  });
}

function injectReaderPolicy(html: string, missingAssets: number, bridgeHash?: string): string {
  const policy = [
    "<meta http-equiv=\"Content-Security-Policy\"",
    ` content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'${bridgeHash ? `; script-src 'sha256-${bridgeHash}'` : ""}">`
  ].join("");
  const mathStyle = `<style id="mathnotes-katex">${embeddedKatexReaderStyle}${katexVisibilityPolicy}${imagePreviewPolicy}${outlinePolicy}</style>`;
  const warning = missingAssets > 0
    ? `<aside class="asset-sync-warning">${missingAssets} 张图片尚未同步，文字笔记仍可阅读。</aside>`
    : "";
  const withPolicy = /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${policy}${mathStyle}`)
    : `<!doctype html><html lang="zh-CN"><head>${policy}${mathStyle}</head><body>${html}</body></html>`;
  return warning
    ? withPolicy.replace(/<\/body>/i, `${warning}</body>`)
    : withPolicy;
}

function sanitizeReaderHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script,base,iframe,object,embed,form,meta[http-equiv]").forEach(node => node.remove());
  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || attribute.name === "srcdoc" || (/^(?:href|xlink:href)$/i.test(attribute.name) && /^\s*(?:javascript|data|vbscript):/i.test(attribute.value))) element.removeAttribute(attribute.name);
    }
  }
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

export function addReaderOutline(html: string): string {
  const headings: {level:number; id:string; text:string}[] = [];
  let body = html.replace(/<section\b([^>]*\bdata-block-id=["']([A-Za-z0-9._:-]+)["'][^>]*)>/gi, (tag, attrs:string, id:string) => /\s+id\s*=/.test(attrs) ? tag : `<section id="mathnotes-block-${id}"${attrs}>`);
  body = body.replace(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (_tag, level:string, attrs:string, inner:string) => {
    const id = `mathnotes-heading-${headings.length}`;
    headings.push({level:Number(level),id,text:inner.replace(/<[^>]*>/g, "").trim() || "无标题"});
    return `<h${level}${attrs.replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")} id="${id}">${inner}</h${level}>`;
  });
  if (!headings.length) return body;
  const minimum = Math.min(...headings.map(heading => heading.level));
  const outline = `<details class="mathnotes-reader-outline"><summary>目录</summary><nav aria-label="笔记目录">${headings.map(heading => `<a href="#${heading.id}" style="padding-left:${12+(heading.level-minimum)*16}px">${heading.text}</a>`).join("")}</nav></details>`;
  return /<body\b[^>]*>/i.test(body) ? body.replace(/<body\b[^>]*>/i, match => match + outline) : outline + body;
}

const outlinePolicy = [
  "body:has(>.mathnotes-reader-outline){padding-top:64px!important}",
  ".mathnotes-reader-outline{position:fixed;top:10px;left:12px;z-index:1000;margin:0;border:0;padding:0;background:none;color:#27382b}",
  ".mathnotes-reader-outline>summary{box-sizing:border-box;min-height:42px;padding:8px 12px;cursor:pointer;width:max-content;border:1px solid #d9dfd4;border-radius:13px;background:#fbfaf6;box-shadow:0 3px 12px #27382b12;font:15px/24px sans-serif;user-select:none}",
  ".mathnotes-reader-outline[open]>summary{background:#eaf0e5}",
  ".mathnotes-reader-outline nav{box-sizing:border-box;position:absolute;top:calc(100% + 8px);left:0;width:min(340px,calc(100vw - 24px));max-height:min(50vh,calc(100dvh - 84px));overflow:auto;overscroll-behavior:contain;padding:8px;border:1px solid #d9dfd4;border-radius:18px;background:#fbfaf6;box-shadow:0 12px 36px #1c2e2426;font:15px/1.6 sans-serif}",
  ".mathnotes-reader-outline a{display:block;padding:8px 12px;color:#315b3f;text-decoration:none;border-radius:9px;overflow-wrap:anywhere}",
  ".mathnotes-reader-outline a:hover,.mathnotes-reader-outline a:focus-visible{background:#e9eee3}",
  "[id^=mathnotes-]{scroll-margin-top:64px}.mathnotes-reader-located{outline:2px solid #82a776;outline-offset:5px;border-radius:10px}"
].join("");

// Older host snapshots intentionally preferred native MathML before companion
// readers bundled KaTeX fonts. Keep MathML in the accessibility tree while the
// final reader policy makes the fully styled KaTeX HTML the visible layer.
const katexVisibilityPolicy = [
  ".katex>.katex-html{display:inline-block!important}",
  ".math-display .katex>.katex-html,.katex-display>.katex>.katex-html{display:block!important}",
  ".math-display .katex-display,.math-display .katex-display>.katex,.math-display .katex-display>.katex>.katex-html{width:max-content!important;min-width:100%!important}",
  "@media(max-width:640px){.math-display .katex-display>.katex>.katex-html>.tag{position:sticky!important;right:0!important;display:block!important;width:max-content!important;min-width:3.5em!important;margin:.4em 0 0 auto!important;text-align:right!important}}",
  ".katex>.katex-mathml{display:block!important;position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}"
].join("");

const imagePreviewPolicy = [
  ".mathnotes-image-preview{margin:12px 0!important;border:0!important;padding:0!important}",
  ".mathnotes-image-preview>summary{display:block!important;list-style:none!important;cursor:zoom-in!important}",
  ".mathnotes-image-preview>summary::-webkit-details-marker{display:none!important}",
  ".mathnotes-image-preview>summary>img{display:block!important;max-width:100%!important;height:auto!important;border-radius:12px!important}",
  ".mathnotes-image-close,.mathnotes-image-full{display:none!important}",
  ".mathnotes-image-preview[open]>summary>img{visibility:hidden!important}",
  ".mathnotes-image-preview[open] .mathnotes-image-full{display:flex!important;position:fixed!important;inset:0!important;z-index:2147483646!important;align-items:center!important;justify-content:center!important;padding:64px 16px 24px!important;box-sizing:border-box!important;background:#111410f2!important;overflow:auto!important}",
  ".mathnotes-image-preview[open] .mathnotes-image-full>img{display:block!important;position:static!important;max-width:100%!important;max-height:calc(100vh - 100px)!important;width:auto!important;height:auto!important;object-fit:contain!important;border-radius:10px!important;margin:auto!important}",
  ".mathnotes-image-preview[open] .mathnotes-image-close{display:flex!important;position:fixed!important;top:12px!important;right:14px!important;z-index:2147483647!important;align-items:center!important;justify-content:center!important;min-width:88px!important;min-height:44px!important;padding:0 14px!important;border:1px solid #a6b2a2!important;border-radius:14px!important;background:#f7f8f4!important;color:#1e271c!important;cursor:zoom-out!important;font:15px/1.4 sans-serif!important}"
].join("");

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

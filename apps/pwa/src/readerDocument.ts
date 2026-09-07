import type { CachedAsset, CachedSession } from "./domain";
import { embeddedKatexReaderStyle } from "./katexReaderStyle";

export type ReaderDocument = Readonly<{
  html: string;
  missingAssets: number;
  dispose(): void;
}>;

export async function createReaderDocument(
  session: CachedSession,
  assets: readonly CachedAsset[],
  createDataUrl: (blob: Blob, mimeType: string) => Promise<string> = blobDataUrl
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
  return {
    html: injectReaderPolicy(addImagePreviews(html), missingAssets),
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
    return `<details class="mathnotes-image-preview"><summary aria-label="放大或关闭图片">${image}<span class="mathnotes-image-close">关闭大图</span></summary><div class="mathnotes-image-full" role="dialog" aria-label="图片大图">${image}</div></details>`;
  });
}

function injectReaderPolicy(html: string, missingAssets: number): string {
  const policy = [
    "<meta http-equiv=\"Content-Security-Policy\"",
    " content=\"default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src data:\">"
  ].join("");
  const mathStyle = `<style id="mathnotes-katex">${embeddedKatexReaderStyle}${katexVisibilityPolicy}${imagePreviewPolicy}</style>`;
  const warning = missingAssets > 0
    ? `<aside class="asset-sync-warning">${missingAssets} 张图片尚未同步，文字笔记仍可阅读。</aside>`
    : "";
  const withPolicy = /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<\/head>/i, `${policy}${mathStyle}</head>`)
    : `<!doctype html><html lang="zh-CN"><head>${policy}${mathStyle}</head><body>${html}</body></html>`;
  return warning
    ? withPolicy.replace(/<\/body>/i, `${warning}</body>`)
    : withPolicy;
}

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

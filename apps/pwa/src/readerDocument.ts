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
    html: injectReaderPolicy(html, missingAssets),
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

function injectReaderPolicy(html: string, missingAssets: number): string {
  const policy = [
    "<meta http-equiv=\"Content-Security-Policy\"",
    " content=\"default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src data:\">"
  ].join("");
  const mathStyle = `<style id="mathnotes-katex">${embeddedKatexReaderStyle}${katexVisibilityPolicy}</style>`;
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

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

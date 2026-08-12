import { describe, expect, it } from "vitest";
import type { CachedSession } from "./domain";
import { createReaderDocument } from "./readerDocument";

describe("createReaderDocument", () => {
  it("embeds cached images without relaxing the opaque iframe sandbox", async () => {
    const document = await createReaderDocument(
      session("<html><head><style>@font-face{font-family:OldKatex;src:url('/fonts/old-katex.woff2')}</style></head><body><img src=\"mathnotes-companion-asset://a\"><img src=\"mathnotes-companion-asset://b\"></body></html>"),
      [{
        key: "asset",
        profileId: "phone",
        notebookId: "analysis",
        sessionId: "lecture",
        assetId: "a",
        mimeType: "image/png",
        bytes: new Blob(["image"]),
        syncedAt: "now"
      }],
      async () => "data:image/png;base64,aW1hZ2U="
    );
    expect(document.html).toContain("img-src blob: data:");
    expect(document.html).not.toContain("script-src");
    expect(document.html).toContain("id=\"mathnotes-katex\"");
    expect(document.html).toContain(".katex>.katex-html{display:inline-block!important}");
    expect(document.html).toContain(".math-display .katex-display>.katex>.katex-html{width:max-content!important;min-width:100%!important}");
    expect(document.html).toContain(".katex-html>.tag{position:sticky!important;right:0!important;display:block!important");
    expect(document.html).toContain(".katex>.katex-mathml{display:block!important;position:absolute!important");
    expect(document.html).not.toContain("/fonts/old-katex.woff2");
    expect(document.html).not.toContain("fonts/KaTeX_");
    expect(document.html).toContain("data:image/png;base64,aW1hZ2U=");
    expect(document.missingAssets).toBe(1);
    document.dispose();
  });
});

function session(html: string): CachedSession {
  return {
    key: "key",
    profileId: "phone",
    version: 1,
    notebookId: "analysis",
    sessionId: "lecture",
    title: "Lecture",
    revision: "r1",
    updatedAt: "now",
    blockCount: 1,
    markdown: "",
    html,
    assets: [],
    syncedAt: "now"
  };
}

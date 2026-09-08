import { describe, expect, it } from "vitest";
import { encodeMarkdownAssetPath, sessionAssetPathFromMarkdown } from "./sessionAssetPath";

describe("Session Markdown asset destinations", () => {
  it.each(["assets/photo#50%.png", "assets/中文 照片(1).png", "assets/percent%23%25.png", "assets/quote').png"])("roundtrips %s exactly once", path => {
    const encoded = encodeMarkdownAssetPath(path);
    expect(sessionAssetPathFromMarkdown(`../${encoded}?size=1#display`)).toBe(path);
    expect(sessionAssetPathFromMarkdown(`./${encoded}`)).toBe(path);
    expect(sessionAssetPathFromMarkdown(encoded)).toBe(path);
  });
  it("does not mistake encoded hashes for fragment separators or decode literal percent sequences twice", () => {
    expect(sessionAssetPathFromMarkdown("../assets/photo%2350%25.png#ignored")).toBe("assets/photo#50%.png");
    expect(sessionAssetPathFromMarkdown("../assets/%252e%252e.png")).toBe("assets/%2e%2e.png");
    expect(encodeMarkdownAssetPath("assets/图 (1).png")).toBe("assets/%E5%9B%BE%20%281%29.png");
  });
  it.each(["../assets/%2e%2e/private.png", "../assets/a%5C..%5Cx.png", "/assets/x.png", "file:///assets/x.png",
    "https://host/assets/x.png", "assets/C%3Asecret.png", "assets/NUL.png", "assets/com1.txt", "assets/end.%20",
    "assets/a%00.png", "assets/a%3F.png", "assets/a%ZZ.png", "assets//x.png"])("rejects unsafe destination %s", path => {
    expect(sessionAssetPathFromMarkdown(path)).toBeUndefined();
  });
});

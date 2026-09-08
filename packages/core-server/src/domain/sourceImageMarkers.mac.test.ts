import { describe, expect, it } from "vitest";
import { bindSourceImageMarkers, originalImagePath, SOURCE_IMAGE_MARKER as marker } from "./sourceImageMarkers";
import { renderPortableMarkdown } from "../render/portableMarkdown";
import { encodeMarkdownAssetPath, sessionAssetPathFromMarkdown } from "./sessionAssetPath";

describe("source image markers", () => {
  it("binds the supplied image at the description position, preserving text and CRLF", async () => {
    const path = "assets/照片 (1)#50%.png";
    const text = `图形说明\r\n\r\n${marker}\r\n\r\n后面的证明\r\n`;
    const bound = bindSourceImageMarkers(text, path);
    expect(bound).toBe(`图形说明\r\n\r\n![识别照片（已处理）](../${encodeMarkdownAssetPath(path)})\r\n\r\n后面的证明\r\n`);
    const html = await renderPortableMarkdown({ markdown: bound });
    expect(html).toContain("<img");
    expect(html.indexOf("图形说明")).toBeLessThan(html.indexOf("<img"));
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("后面的证明"));
    expect(sessionAssetPathFromMarkdown(`../${encodeMarkdownAssetPath(path)}`)).toBe(path);
  });

  it.each([
    `\`\`\`md\n${marker}\n\`\`\``, `    ${marker}`, `\`${marker}\``,
    `\`multi\n${marker}\nline\``, `> ${marker}`, `- ${marker}`,
    `$$\n${marker}\n$$`, `\\[\n${marker}\n\\]`, `$x\n${marker}\ny$`,
    `说明 ${marker}`, `\\${marker}`, `[example](${marker})`
  ])("preserves literal or non-standalone syntax: %s", text => {
    expect(bindSourceImageMarkers(text, "assets/photo.png")).toBe(text);
  });

  it("adds an image to old diagram descriptions only once and never changes code examples", () => {
    const text = "[图片：坐标轴与圆]\n\n后文";
    const options = { includeLegacyDescriptions: true };
    const once = bindSourceImageMarkers(text, "assets/photo.png", options);
    expect(once.match(/!\[/g)).toHaveLength(1);
    expect(bindSourceImageMarkers(once, "assets/photo.png", options)).toBe(once);
    const upstream = "[图片：坐标轴与圆]\n\n![different alt](../assets/photo.png)";
    expect(bindSourceImageMarkers(upstream, "assets/photo.png", options)).toBe(upstream);
    const marked = `[图片：坐标轴与圆]\n\n${marker}`;
    expect(bindSourceImageMarkers(marked, "assets/photo.png", options).match(/!\[/g)).toHaveLength(1);
    const code = "```\n[图片：示例]\n```";
    expect(bindSourceImageMarkers(code, "assets/photo.png", options)).toBe(code);
  });

  it("selects the processed PDF page before other assets and refuses model paths", () => {
    expect(originalImagePath({ sourcePageImagePath: "assets/page.png", fromAssets: ["assets/source.pdf", "assets/other.jpg"] })).toBe("assets/page.png");
    for (const path of [undefined, "/private/photo.png", "assets/../private.png", "assets\\photo.png", "https://host/photo.png"]) {
      expect(bindSourceImageMarkers(marker, path)).toBe("[识别照片暂不可用]");
    }
  });

  it("decodes exactly once and rejects encoded traversal and foreign destinations", () => {
    for (const path of ["../assets/%2e%2e/secret.png", "../assets/x%5c..%5csecret.png", "%2fprivate/a.png", "../assets/%00.png", "https://host/a.png", "../assets/%bad", "../assets//a.png"]) {
      expect(sessionAssetPathFromMarkdown(path)).toBeUndefined();
    }
    expect(sessionAssetPathFromMarkdown("../assets/percent%2520.png")).toBe("assets/percent%20.png");
  });
});

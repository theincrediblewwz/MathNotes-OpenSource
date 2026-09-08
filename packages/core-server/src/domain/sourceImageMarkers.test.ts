import { describe, expect, it } from "vitest";
import { bindSourceImageMarkers, SOURCE_IMAGE_MARKER as marker } from "./sourceImageMarkers";
import { encodeMarkdownAssetPath, sessionAssetPathFromMarkdown } from "./sessionAssetPath";

describe("source image binding", () => {
  it("keeps the description and binds repeated diagram positions to the actual processed asset", () => {
    const source = `# 图形\n\n[图片：三角形 ABC]\n\n${marker}\n\n下一图\n${marker}\n`;
    const bound = bindSourceImageMarkers(source, "assets/photos/processed-black-mask.png");
    expect(bound).toBe(source.replaceAll(marker, "![识别照片（已处理）](../assets/photos/processed-black-mask.png)"));
    expect(bindSourceImageMarkers(bound, "assets/photos/other.png")).toBe(bound);
  });

  it("preserves fenced, inline, multiline inline, escaped and indented code examples", () => {
    const source = `\`\`\`text\n${marker}\n\`\`\`\n\n\`${marker}\`\n\n\`example\n${marker}\nend\`\n\n    ${marker}\n\n\\[\\[mathnotes:source-image]]\n\n> ${marker}\n`;
    expect(bindSourceImageMarkers(source, "assets/photos/processed.png")).toBe(source);
  });

  it("never guesses another photo when the task has no trusted image asset", () => {
    for (const path of [undefined, "assets/photos/../../private.png", "https://host/secret.png", "file:///private.png", "assets/document.pdf", "assets/photos/NUL.png", "assets/photos/ads:stream.png"]) {
      expect(bindSourceImageMarkers(`说明\n\n${marker}`, path)).toBe("说明\n\n[识别照片暂不可用]");
    }
  });

  it.each(["assets/照片 (1)#50%.png", "assets/photos/quote).png", "assets/photos/%2e%2e/literal.png"])("binds a literal safe filesystem path %s without changing its identity", path => {
    const encoded = encodeMarkdownAssetPath(path);
    expect(bindSourceImageMarkers(marker, path)).toBe(`![识别照片（已处理）](../${encoded})`);
    expect(sessionAssetPathFromMarkdown(`../${encoded}`)).toBe(path);
  });

  it("leaves markers inside display and inline math literal, while binding the following real image", () => {
    for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"], ["$", "$"], ["\\(", "\\)"]]) {
      const formula = `${open}\n${marker}\n${close}`;
      const source = `${formula}\n\n图形说明\n\n${marker}\n`;
      expect(bindSourceImageMarkers(source, "assets/photos/p.png")).toBe(`${formula}\n\n图形说明\n\n![识别照片（已处理）](../assets/photos/p.png)\n`);
    }
    const formula = `$$\n\n${marker}\n\n$$`;
    expect(bindSourceImageMarkers(formula, "assets/photos/p.png")).toBe(formula);
    for (const [opening, escaped, closing] of [["$$", "\\$$", "$$"], ["\\[", "\\\\]", "\\]"]]) {
      const formula = `${opening}\nx + ${escaped}\n\n${marker}\n\ny\n${closing}`;
      const source = `${formula}\n\n${marker}`;
      expect(bindSourceImageMarkers(source, "assets/photos/p.png")).toBe(`${formula}\n\n![识别照片（已处理）](../assets/photos/p.png)`);
    }
  });

  it("preserves CRLF and does not retrofit historical image descriptions", () => {
    const source = `[图片：旧图描述]\r\n\r\n${marker}\r\n`;
    expect(bindSourceImageMarkers(source, "assets/photos/p.png")).toBe("[图片：旧图描述]\r\n\r\n![识别照片（已处理）](../assets/photos/p.png)\r\n");
    expect(bindSourceImageMarkers("[图片：旧图描述]", "assets/photos/p.png")).toBe("[图片：旧图描述]");
  });
});

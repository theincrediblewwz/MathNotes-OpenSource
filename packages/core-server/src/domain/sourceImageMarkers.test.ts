import { describe, expect, it } from "vitest";
import { bindSourceImageMarkers, SOURCE_IMAGE_MARKER as marker } from "./sourceImageMarkers";

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
    for (const path of [undefined, "assets/photos/../../private.png", "https://host/secret.png", "file:///private.png", "assets/photos/%2e%2e/private.png", "assets/document.pdf", "assets/photos/quote).png"]) {
      expect(bindSourceImageMarkers(`说明\n\n${marker}`, path)).toBe("说明\n\n[识别照片暂不可用]");
    }
  });

  it("preserves CRLF and does not retrofit historical image descriptions", () => {
    const source = `[图片：旧图描述]\r\n\r\n${marker}\r\n`;
    expect(bindSourceImageMarkers(source, "assets/photos/p.png")).toBe("[图片：旧图描述]\r\n\r\n![识别照片（已处理）](../assets/photos/p.png)\r\n");
    expect(bindSourceImageMarkers("[图片：旧图描述]", "assets/photos/p.png")).toBe("[图片：旧图描述]");
  });
});

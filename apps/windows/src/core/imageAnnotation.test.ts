import { describe, expect, it } from "vitest";
import { decodePngDataUrl, markdownForEmbeddedAsset } from "./imageAnnotation";

describe("imageAnnotation", () => {
  it("decodes png data urls for annotated image IPC", () => {
    const decoded = decodePngDataUrl("data:image/png;base64,ZWRpdGVkIHBuZw==");

    expect(decoded.toString("utf8")).toBe("edited png");
  });

  it("rejects non-png data urls", () => {
    expect(() => decodePngDataUrl("data:image/jpeg;base64,ZmFrZQ==")).toThrow(/PNG data URL/);
  });

  it("builds portable markdown references for embedded assets", () => {
    expect(markdownForEmbeddedAsset("assets\\embedded\\diagram 001.png")).toBe("![图](../assets/embedded/diagram 001.png)");
  });
});

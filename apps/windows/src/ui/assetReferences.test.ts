import { describe, expect, it } from "vitest";
import {
  findMarkdownImageReferenceAtPosition,
  normalizeSessionAssetPath,
  resolveSessionAssetPreview,
  toAssetProtocolUrl
} from "./assetReferences";

describe("assetReferences", () => {
  it("decodes Markdown URL escapes once before resolving a session asset", () => {
    expect(resolveSessionAssetPreview({ sessionDir: "C:/notes/session", target: "../assets/photos/%E5%9B%BE%20%E7%89%87.png" })).toMatchObject({
      assetPath: "assets/photos/图 片.png",
      previewUrl: "mathnotes-asset://local/C:/notes/session/assets/photos/%E5%9B%BE%20%E7%89%87.png"
    });
    expect(normalizeSessionAssetPath("assets/photos/literal%252e.png")).toBe("assets/photos/literal%2e.png");
  });

  it.each([
    "../assets/%2e%2e/secret.png", "assets/photos/%2E%2E/%2E%2E/secret.png",
    "assets/photos/..%5c..%5csecret.png", "assets/photos/%2e%2e%2f%2e%2e%2fsecret.png",
    "assets/..", "assets/photos/%00.png", "assets/photos/%E5.png", "assets/photos/file%3Asecret.png"
  ])("rejects encoded traversal or invalid path %s", (target) => {
    expect(normalizeSessionAssetPath(target)).toBeNull();
  });

  it("resolves session embedded asset references to preview urls", () => {
    const preview = resolveSessionAssetPreview({
      sessionDir: "C:\\Users\\MathNotesUser\\AppData\\Roaming\\Electron\\MyMathNotes\\notebooks\\n\\sessions\\s",
      target: "../assets/embedded/diagram 01.png"
    });

    expect(preview).toEqual({
      absolutePath: "C:\\Users\\MathNotesUser\\AppData\\Roaming\\Electron\\MyMathNotes\\notebooks\\n\\sessions\\s\\assets\\embedded\\diagram 01.png",
      assetPath: "assets/embedded/diagram 01.png",
      label: "diagram 01.png",
      mediaType: "image",
      previewUrl:
        "mathnotes-asset://local/C:/Users/MathNotesUser/AppData/Roaming/Electron/MyMathNotes/notebooks/n/sessions/s/assets/embedded/diagram%2001.png"
    });
  });

  it("marks PDF asset references for the document preview", () => {
    expect(
      resolveSessionAssetPreview({
        sessionDir: "C:\\notes\\session",
        target: "assets/pdfs/lecture.PDF"
      })
    ).toMatchObject({ label: "lecture.PDF", mediaType: "pdf" });
  });

  it("finds the markdown image reference under the clicked editor position", () => {
    const markdown = "前文\n![图](../assets/embedded/IMG_20260622_104803.png).\n后文";
    const position = markdown.indexOf("embedded") + 3;

    expect(findMarkdownImageReferenceAtPosition(markdown, position)).toEqual({
      from: 3,
      target: "../assets/embedded/IMG_20260622_104803.png",
      to: 51
    });
  });

  it("does not treat non-image markdown links as asset references", () => {
    const markdown = "[文档](../assets/embedded/diagram.png)";

    expect(findMarkdownImageReferenceAtPosition(markdown, markdown.indexOf("assets"))).toBeNull();
  });

  it("keeps the asset protocol encoder shared with preview rendering", () => {
    expect(toAssetProtocolUrl("C:/A B/assets/embedded/d.png")).toBe("mathnotes-asset://local/C:/A%20B/assets/embedded/d.png");
  });
});

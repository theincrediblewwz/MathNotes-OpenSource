import { describe, expect, it } from "vitest";
import { windowsVendorChunkName } from "./buildChunking";

describe("windowsVendorChunkName", () => {
  it.each([
    ["C:/repo/node_modules/react/index.js", "react-vendor"],
    ["C:/repo/node_modules/@codemirror/view/dist/index.js", "editor-core"],
    ["C:/repo/node_modules/@codemirror/lang-markdown/dist/index.js", "editor-features"],
    ["C:/repo/node_modules/@codemirror/lang-html/dist/index.js", "editor-features"],
    ["C:/repo/node_modules/@codemirror/search/dist/index.js", "editor-features"],
    ["C:/repo/node_modules/katex/dist/katex.mjs", "markdown-vendor"],
    ["C:/repo/node_modules/lucide-react/dist/cjs/lucide-react.js", "icon-vendor"],
    ["C:/repo/node_modules/qrcode/lib/index.js", "utility-vendor"]
  ])("groups %s into %s", (moduleId, expected) => {
    expect(windowsVendorChunkName(moduleId)).toBe(expected);
  });

  it("preserves the existing lazy PDF chunk and application modules", () => {
    expect(windowsVendorChunkName("C:/repo/node_modules/pdfjs-dist/legacy/build/pdf.mjs")).toBeUndefined();
    expect(windowsVendorChunkName("C:/repo/apps/windows/src/App.tsx")).toBeUndefined();
  });

  it("normalizes Windows module paths", () => {
    expect(windowsVendorChunkName("C:\\repo\\node_modules\\@lezer\\common\\dist\\index.js"))
      .toBe("editor-core");
  });
});

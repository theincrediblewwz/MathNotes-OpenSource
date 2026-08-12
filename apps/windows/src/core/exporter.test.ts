import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { exportSessionMarkdown } from "./exporter";

describe("exportSessionMarkdown", () => {
  let root: string;
  let store: BlockStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-export-"));
    store = new BlockStore(root);
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exports markdown blocks in session order and skips image blocks", async () => {
    await store.appendImageBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/photo_001.jpg",
      now: "2026-06-26T10:01:00.000Z"
    });
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: "## OCR 草稿",
      now: "2026-06-26T10:02:00.000Z"
    });
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user_revision",
      markdown: "用户修订内容",
      now: "2026-06-26T10:03:00.000Z"
    });

    const result = await exportSessionMarkdown({
      rootDir: root,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: true
    });

    expect(result.outPath.endsWith("lecture.md")).toBe(true);
    expect(result.exportedBlocks).toBe(2);

    const exported = await readFile(result.outPath, "utf8");
    expect(exported).toContain("<!-- block:id=0002 source=ai_transcription -->");
    expect(exported).toContain("## OCR 草稿");
    expect(exported).toContain("<!-- block:id=0003 source=user_revision -->");
    expect(exported).toContain("用户修订内容");
    expect(exported).not.toContain("photo_001.jpg");
  });

  it("normalizes bracket math delimiters for portable Markdown exports by default", async () => {
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: [
        "行内公式：\\(T_n \\to T\\)。",
        "",
        "\\[",
        "\\langle Tx, Tx\\rangle^{1/2} \\le C \\langle x, x\\rangle^{1/2}",
        "\\]"
      ].join("\n"),
      now: "2026-06-26T10:04:00.000Z"
    });

    const result = await exportSessionMarkdown({
      rootDir: root,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false
    });

    const exported = await readFile(result.outPath, "utf8");
    expect(exported).toContain("行内公式：$T_n \\to T$。");
    expect(exported).toContain("$$\n\\langle Tx, Tx\\rangle^{1/2} \\le C \\langle x, x\\rangle^{1/2}\n$$");
    expect(exported).not.toContain("\\(");
    expect(exported).not.toContain("\\[");
  });

  it("separates display math delimiters from adjacent prose for VS Code-compatible exports", async () => {
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: [
        "我会按图片内容直接转写。$$",
        "|e^{tA_0}| \\le M_0 e^{\\omega_0 t},\\quad t \\ge 0",
        "$$",
        "$c$"
      ].join("\n"),
      now: "2026-06-26T10:04:30.000Z"
    });

    const result = await exportSessionMarkdown({
      rootDir: root,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false
    });

    const exported = await readFile(result.outPath, "utf8");
    expect(exported).toContain([
      "我会按图片内容直接转写。",
      "",
      "$$",
      "|e^{tA_0}| \\le M_0 e^{\\omega_0 t},\\quad t \\ge 0",
      "$$",
      "",
      "$c$"
    ].join("\n"));
    expect(exported).not.toContain("转写。$$");
  });

  it("exports a portable share package with referenced embedded assets", async () => {
    const sessionDir = join(root, "notebooks", "functional_analysis", "sessions", "lecture");
    await writeFile(join(sessionDir, "assets", "embedded", "diagram.png"), "fake image bytes", "utf8");
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: ["## 带图笔记", "", "![示意图](../assets/embedded/diagram.png)"].join("\n"),
      now: "2026-06-26T10:05:00.000Z"
    });

    const result = await exportSessionMarkdown({
      rootDir: root,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false,
      packageMode: "share"
    });

    expect(result.packageDir?.endsWith(join("exports", "lecture_share"))).toBe(true);
    expect(result.outPath.endsWith(join("exports", "lecture_share", "lecture.md"))).toBe(true);
    expect(result.copiedAssets).toEqual(["assets/embedded/diagram.png"]);

    const exported = await readFile(result.outPath, "utf8");
    expect(exported).toContain("![示意图](assets/embedded/diagram.png)");
    expect(await readFile(join(result.packageDir!, "assets", "embedded", "diagram.png"), "utf8")).toBe("fake image bytes");
    await expect(stat(join(result.packageDir!, "assets", "photos", "unused.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps exporting a share package and reports missing referenced assets", async () => {
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: ["## 缺图笔记", "", "![缺失图](../assets/embedded/missing.png)"].join("\n"),
      now: "2026-06-26T10:06:00.000Z"
    });

    const result = await exportSessionMarkdown({
      rootDir: root,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false,
      packageMode: "share"
    });

    expect(result.missingAssets).toEqual(["assets/embedded/missing.png"]);
    expect(result.copiedAssets).toEqual([]);
    expect(await readFile(result.outPath, "utf8")).toContain("![缺失图](assets/embedded/missing.png)");
  });

  it("keeps AI remarks out by default and appends them only when requested", async () => {
    const sessionDir = join(root, "notebooks", "functional_analysis", "sessions", "lecture");
    const assistantDir = join(sessionDir, "assistant");
    await mkdir(join(assistantDir, "remarks"), { recursive: true });
    await writeFile(join(assistantDir, "remarks", "remark_1.md"), "## 旁注内容\n\n\\(T_n \\to T\\)\n", "utf8");
    await writeFile(join(assistantDir, "index.json"), JSON.stringify({
      version: 1,
      remarks: [{
        id: "remark_1",
        file: "remarks/remark_1.md",
        mode: "teach",
        focus: { kind: "block", label: "定理 3.1" },
        providerName: "测试服务",
        sourceBlockIds: [],
        createdAt: "2026-07-16T10:00:00.000Z",
        updatedAt: "2026-07-16T10:00:00.000Z"
      }]
    }), "utf8");

    const defaultResult = await exportSessionMarkdown({
      rootDir: root,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false
    });
    expect(await readFile(defaultResult.outPath, "utf8")).not.toContain("旁注内容");

    const appendixResult = await exportSessionMarkdown({
      rootDir: root,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false,
      includeAssistantRemarks: true
    });
    const exported = await readFile(appendixResult.outPath, "utf8");
    expect(exported).toContain("## AI 学习旁注");
    expect(exported).toContain("### 教学：定理 3.1");
    expect(exported).toContain("> AI 旁注 · 测试服务");
    expect(exported).toContain("$T_n \\to T$");
  });
});

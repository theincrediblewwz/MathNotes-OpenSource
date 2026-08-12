import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "@mathnotes/shared";
import {
  readReadonlySessionAsset,
  readReadonlySessionBlock,
  readReadonlySessionManifest,
  renderReadonlyMarkdownPreview,
  renderStandaloneMarkdownPreview,
  SessionReadError
} from "./sessionReadService";

describe("readonly session content", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-session-read-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await mkdir(join(sessionDir, "assets", "embedded"), { recursive: true });
    await mkdir(join(sessionDir, "assets", "pdfs"), { recursive: true });
    await writeFile(join(sessionDir, "assets", "embedded", "graph.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(sessionDir, "assets", "pdfs", "lecture.pdf"), Buffer.from("%PDF-test"));
    await writeFile(join(sessionDir, "blocks", "0001.md"), [
      "## 定理",
      "",
      "设 $T_nx \\to Tx$，且",
      "",
      "$$\\langle Tx,x\\rangle \\ge 0$$",
      "",
      "![相图](../assets/embedded/graph.png)",
      "",
      "<script>alert('no')</script>"
    ].join("\n"));
    const session: SessionRecord = {
      id: "lecture",
      title: "泛函分析 第 3 讲",
      status: "draft",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T01:00:00.000Z",
      currentDraftPolicy: "append_only",
      exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
      locks: [],
      blocks: [
        {
          ...block("0001", "markdown", "blocks/0001.md", "user"),
          fromAssets: ["assets/embedded/graph.png"]
        },
        block("0002", "image", "assets/embedded/graph.png", "user"),
        { ...block("0003", "pdf", "assets/pdfs/lecture.pdf", "pdf_import"), pageCount: 8 }
      ]
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("returns a path-free ordered manifest before reading block bodies", async () => {
    const manifest = await readReadonlySessionManifest({ rootDir: root, notebookId: "analysis", sessionId: "lecture" });
    expect(manifest.blocks.map((entry) => `${entry.order}:${entry.id}:${entry.type}`)).toEqual([
      "0:0001:markdown", "1:0002:image", "2:0003:pdf"
    ]);
    expect(manifest.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(sessionDir);
    expect(JSON.stringify(manifest)).not.toContain("blocks/0001.md");
    expect(manifest.blocks[0].sourceAssetPaths).toEqual(["assets/embedded/graph.png"]);
    expect(manifest.blocks[1].assetPath).toBe("assets/embedded/graph.png");
  });

  it("renders sanitized portable math and local embedded images with the shared renderer", async () => {
    const payload = await readReadonlySessionBlock({
      rootDir: root, notebookId: "analysis", sessionId: "lecture", blockId: "0001"
    });
    expect(payload.content.kind).toBe("markdown");
    if (payload.content.kind !== "markdown") throw new Error("expected markdown");
    expect(payload.block.editable).toBe(true);
    expect(payload.content.markdown).toContain("## 定理");
    expect(payload.content.baseRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.content).toMatchObject({ blockLocked: false, protectedSpanCount: 0 });
    expect(payload.content.html).toContain("<math");
    expect(payload.content.html).toContain(".katex>.katex-html");
    expect(payload.content.html).toContain("display:none!important");
    expect(payload.content.html).toContain("data:image/png;base64,");
    expect(payload.content.html).toContain("&lt;script&gt;alert('no')&lt;/script&gt;");
    expect(payload.content.html).not.toContain("<script>alert('no')</script>");
    expect(payload.content.html).not.toContain(sessionDir);
  });

  it("renders an unsaved draft without changing the stored block", async () => {
    const preview = await renderReadonlyMarkdownPreview({
      rootDir: root,
      notebookId: "analysis",
      sessionId: "lecture",
      blockId: "0001",
      markdown: "即时公式 $$x^2+y^2=1$$"
    });
    expect(preview.html).toContain("<math");
    expect(preview.html).toContain("即时公式");

    const stored = await readReadonlySessionBlock({
      rootDir: root, notebookId: "analysis", sessionId: "lecture", blockId: "0001"
    });
    if (stored.content.kind !== "markdown") throw new Error("expected markdown");
    expect(stored.content.markdown).toContain("## 定理");
    expect(stored.content.markdown).not.toContain("即时公式");
  });

  it("renders temporary Markdown without resolving external relative assets", async () => {
    const preview = await renderStandaloneMarkdownPreview("# 临时阅读\n\n![secret](../../secret.png)");
    expect(preview.html).toContain("临时阅读");
    expect(preview.html).not.toContain("../../secret.png");
    expect(preview.html).not.toContain("data:image");
  });

  it("marks recognition drafts as user-editable Markdown", async () => {
    const sessionPath = join(sessionDir, "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    session.blocks[0] = { ...session.blocks[0], source: "ai_transcription", readonly: false };
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);

    const payload = await readReadonlySessionBlock({
      rootDir: root, notebookId: "analysis", sessionId: "lecture", blockId: "0001"
    });
    expect(payload.block.editable).toBe(true);
  });

  it("serves only session-contained assets and reports their media type", async () => {
    const pdf = await readReadonlySessionAsset({
      rootDir: root, notebookId: "analysis", sessionId: "lecture", assetPath: "assets/pdfs/lecture.pdf"
    });
    expect(pdf.mimeType).toBe("application/pdf");
    expect(pdf.bytes.toString()).toBe("%PDF-test");
    await expect(readReadonlySessionAsset({
      rootDir: root, notebookId: "analysis", sessionId: "lecture", assetPath: "../../secret.txt"
    })).rejects.toEqual(expect.objectContaining<Partial<SessionReadError>>({ statusCode: 400 }));
  });
});

function block(
  id: string,
  type: "markdown" | "image" | "pdf",
  path: string,
  source: "user" | "pdf_import"
): SessionRecord["blocks"][number] {
  return {
    id, type, path, source, status: "draft", readonly: type !== "markdown", editableByAi: false,
    createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z"
  };
}

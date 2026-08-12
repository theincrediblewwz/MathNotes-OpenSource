// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { buildCompanionSessionSnapshot, readCompanionAsset } from "./companionReadService";

describe("buildCompanionSessionSnapshot", () => {
  let root: string;
  let store: BlockStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-companion-"));
    store = new BlockStore(root);
    await store.createSession({
      notebookId: "analysis",
      sessionId: "lecture",
      title: "泛函分析",
      now: "2026-07-14T08:00:00.000Z"
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a sanitized self-contained read-only document", async () => {
    await store.saveEmbeddedAsset({
      notebookId: "analysis",
      sessionId: "lecture",
      fileName: "graph.png",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47])
    });
    await store.appendImageBlock({
      notebookId: "analysis",
      sessionId: "lecture",
      assetPath: "assets/photos/source.jpg",
      now: "2026-07-14T08:01:00.000Z"
    });
    await store.appendMarkdownBlock({
      notebookId: "analysis",
      sessionId: "lecture",
      source: "user",
      markdown: [
        "## 定理",
        "",
        "$$\\langle Tx,x\\rangle \\ge 0$$",
        "",
        "![相图](../assets/embedded/graph.png)",
        "",
        "<script>alert('no')</script>"
      ].join("\n"),
      now: "2026-07-14T08:02:00.000Z"
    });

    const snapshot = await buildCompanionSessionSnapshot({
      store,
      notebookId: "analysis",
      sessionId: "lecture"
    });

    expect(snapshot).toMatchObject({
      version: 1,
      title: "泛函分析",
      blockCount: 1,
      updatedAt: "2026-07-14T08:02:00.000Z"
    });
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.markdown).toContain("<!-- block:");
    expect(snapshot.markdown).toContain("## 定理");
    expect(snapshot.html).toContain("<math");
    expect(snapshot.html).toContain("mathnotes-companion-asset://");
    expect(snapshot.html).not.toContain("data:image/png;base64");
    expect(snapshot.assets).toEqual([
      expect.objectContaining({ path: "assets/embedded/graph.png", mimeType: "image/png" })
    ]);
    expect(snapshot.html).toContain("&lt;script&gt;alert('no')&lt;/script&gt;");
    expect(snapshot.html).not.toContain("source.jpg");

    const asset = await readCompanionAsset({
      store,
      notebookId: "analysis",
      sessionId: "lecture",
      assetPath: snapshot.assets[0].path
    });
    expect(asset.bytes).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("keeps a stable revision until markdown changes", async () => {
    const block = await store.appendMarkdownBlock({
      notebookId: "analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "初稿",
      now: "2026-07-14T08:01:00.000Z"
    });
    const first = await buildCompanionSessionSnapshot({ store, notebookId: "analysis", sessionId: "lecture" });
    const same = await buildCompanionSessionSnapshot({ store, notebookId: "analysis", sessionId: "lecture" });
    expect(same.revision).toBe(first.revision);

    await store.updateMarkdownBlock({
      notebookId: "analysis",
      sessionId: "lecture",
      blockId: block.id,
      markdown: "校订稿",
      now: "2026-07-14T08:02:00.000Z"
    });
    const changed = await buildCompanionSessionSnapshot({ store, notebookId: "analysis", sessionId: "lecture" });
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.html).toContain("校订稿");
  });

  it("renders list-contained display and inline math without turning continuations into code", async () => {
    await store.appendMarkdownBlock({
      notebookId: "analysis",
      sessionId: "lecture",
      source: "ai_transcription",
      markdown: [
        "* temporal formulation 中，$\\alpha \\in R$，中性条件是",
        "    $$\\text{Im}\\omega = 0,$$",
        "    或者 $\\omega = \\alpha c$ 时",
        "    $$\\text{Im} c = 0.$$"
      ].join("\n"),
      now: "2026-07-14T08:03:00.000Z"
    });

    const snapshot = await buildCompanionSessionSnapshot({
      store,
      notebookId: "analysis",
      sessionId: "lecture"
    });

    expect(snapshot.html.match(/<math/g)?.length).toBeGreaterThanOrEqual(4);
    expect(snapshot.html).not.toContain("<pre><code>或者");
    expect(snapshot.html).not.toContain("$\\omega");
  });
});

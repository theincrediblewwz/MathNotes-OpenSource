import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@mathnotes/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindSourceImageMarkers } from "../domain/sourceImageMarkers";
import { encodeMarkdownAssetPath } from "../domain/sessionAssetPath";
import { readReadonlySessionBlock, readReadonlySessionPreview } from "./sessionReadService";
import { exportSessionMarkdown } from "./sessionExportService";
import { WorkspaceSyncService } from "../sync/workspaceSyncService";
import { buildCompanionSessionSnapshot, readCompanionAsset } from "./companionReadService";

describe("source image read / share / sync", () => {
  let root: string;
  let directory: string;
  const path = "assets/照片 (1)#50%.png";
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const markdown = "[图片：单位圆与坐标轴]\n\n[[mathnotes:source-image]]\n\n圆的方程为 $x^2+y^2=1$。\n";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-source-image-"));
    directory = join(root, "notebooks", "n", "sessions", "s");
    await mkdir(join(directory, "assets"), { recursive: true });
    await mkdir(join(directory, "blocks"));
    const now = "2026-09-08T00:00:00Z";
    const session: SessionRecord = { id: "s", title: "原图验证", status: "draft", createdAt: now, updatedAt: now,
      locks: [], currentDraftPolicy: "append_only", exportPolicy: { includeImageLinks: true, includeMetadataComments: true },
      blocks: [{ id: "b", path: "blocks/b.md", type: "markdown", source: "ai_transcription", status: "draft",
        readonly: false, editableByAi: true, createdAt: now, updatedAt: now, fromAssets: [path] }] };
    await writeFile(join(directory, "session.json"), JSON.stringify(session));
    await writeFile(join(directory, "blocks/b.md"), markdown);
    await writeFile(join(directory, path), bytes);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  function companion() {
    return { notebookId: "n", sessionId: "s", store: {
      getSessionDir: () => directory,
      readSession: async () => JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as SessionRecord
    } };
  }

  it("serves source markers and encoded image names to the PWA with stable upload anchors", async () => {
    const snapshot = await buildCompanionSessionSnapshot(companion());
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.assets[0].path).toBe(path);
    expect(snapshot.html).toContain(`mathnotes-block-b-asset-${snapshot.assets[0].id}`);
    expect(snapshot.html).not.toContain("识别照片暂不可用");
    expect((await readCompanionAsset({ ...companion(), assetPath: path })).bytes).toEqual(bytes);
    expect(await readFile(join(directory, "blocks/b.md"), "utf8")).toBe(markdown);
  });

  it("keeps split formulas and images continuous in companion reading while hiding source-only blocks", async () => {
    const session = await companion().store.readSession();
    const text = `$$x^2+y^2=1$$\n\n![图](../${encodeMarkdownAssetPath(path)})\n`;
    const cuts = [text.slice(0, 6), text.slice(6, 24), text.slice(24)];
    session.blocks = cuts.map((_, index) => ({ ...session.blocks[0], id: `p${index}`, path: `blocks/p${index}.md`, continuationGroup: "g" }));
    session.blocks.push({ ...session.blocks[0], id: "hidden", path: "blocks/hidden.md", renderInNote: false });
    await Promise.all(cuts.map((part, index) => writeFile(join(directory, `blocks/p${index}.md`), part)));
    await writeFile(join(directory, "blocks/hidden.md"), "HIDDEN_SOURCE_ONLY");
    await writeFile(join(directory, "session.json"), JSON.stringify(session));
    const snapshot = await buildCompanionSessionSnapshot(companion());
    expect(snapshot.blockCount).toBe(1);
    expect(snapshot.html).toContain("katex");
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.html).toContain(`mathnotes-block-p2-asset-${snapshot.assets[0].id}`);
    expect(snapshot.html).not.toContain("HIDDEN_SOURCE_ONLY");
  });

  it("renders original metadata without modifying old notes and exports the real image with a portable path", async () => {
    const block = await readReadonlySessionBlock({ rootDir: root, notebookId: "n", sessionId: "s", blockId: "b" });
    if (block.content.kind !== "markdown") throw new Error("markdown required");
    expect(block.content.html.match(/<img /g)).toHaveLength(1);
    expect(block.content.html).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(block.content.html).toContain("katex");
    expect(block.content.markdown).toBe(markdown);
    expect(await readFile(join(directory, "blocks/b.md"), "utf8")).toBe(markdown);
    const preview = await readReadonlySessionPreview({ rootDir: root, notebookId: "n", sessionId: "s" });
    expect(JSON.stringify(preview)).toContain("data:image/png;base64,");
    const exported = await exportSessionMarkdown({ rootDir: root, notebookId: "n", sessionId: "s", includeMetadataComments: false, packageMode: "share" });
    expect(exported.copiedAssets).toEqual([path]);
    expect(exported.missingAssets).toEqual([]);
    expect(await readFile(join(exported.packageDir!, path))).toEqual(bytes);
    expect(await readFile(exported.outPath, "utf8")).toContain(`](${encodeMarkdownAssetPath(path)})`);
  });

  it("syncs bound percent-encoded images once using the real filesystem path and hash", async () => {
    await writeFile(join(directory, "blocks/b.md"), bindSourceImageMarkers(markdown, path));
    const writes = new SessionWriteCoordinator();
    const sync = new WorkspaceSyncService(root, join(root, "state"), (n, s, op) => writes.run(n, s, op));
    const snapshot = await sync.snapshot("n", "s");
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.assets[0].path).toBe(path);
    expect(await sync.asset("n", "s", path, snapshot.assets[0].sha256)).toEqual(bytes);
  });

  it("never embeds or exports bytes through a symlink outside the asset directory", async () => {
    await rm(join(directory, path));
    const outside = join(root, "outside.png");
    await writeFile(outside, "PRIVATE_OUTSIDE_FIXTURE");
    await symlink(outside, join(directory, path));
    const block = await readReadonlySessionBlock({ rootDir: root, notebookId: "n", sessionId: "s", blockId: "b" });
    if (block.content.kind !== "markdown") throw new Error("markdown required");
    expect(block.content.html).toContain('data-asset-missing="true"');
    expect(block.content.html).not.toContain(Buffer.from("PRIVATE_OUTSIDE_FIXTURE").toString("base64"));
    const exported = await exportSessionMarkdown({ rootDir: root, notebookId: "n", sessionId: "s", includeMetadataComments: false, packageMode: "share" });
    expect(exported.copiedAssets).toEqual([]);
    expect(exported.missingAssets).toEqual([path]);
    const writes = new SessionWriteCoordinator();
    const sync = new WorkspaceSyncService(root, join(root, "state"), (n, s, op) => writes.run(n, s, op));
    await expect(sync.snapshot("n", "s")).rejects.toMatchObject({ code: "unsafe_path" });
    expect((await buildCompanionSessionSnapshot(companion())).assets).toEqual([]);
    await expect(readCompanionAsset({ ...companion(), assetPath: path })).rejects.toMatchObject({ message: "invalid_asset_path", statusCode: 400 });
  });
});

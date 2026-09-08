import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { afterEach, describe, expect, it } from "vitest";
import { bindSourceImageMarkers } from "../domain/sourceImageMarkers";
import { encodeMarkdownAssetPath } from "../domain/sessionAssetPath";
import { readReadonlySessionBlock, readReadonlySessionPreview } from "./sessionReadService";
import { exportSessionMarkdown } from "./sessionExportService";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { WorkspaceSyncService } from "../sync/workspaceSyncService";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-source-image-")); roots.push(root);
  const directory = join(root, "notebooks", "n", "sessions", "s");
  await mkdir(join(directory, "assets", "photos"), { recursive: true });
  await mkdir(join(directory, "blocks"));
  const path = "assets/photos/照片 (1)#50%23%25.png";
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const markdown = bindSourceImageMarkers("[图片：单位圆与坐标轴]\n\n[[mathnotes:source-image]]\n\n圆的方程为 $x^2+y^2=1$。\n", path);
  const session = createSessionRecord({ id: "s", title: "原图验证", createdAt: "2026-09-08T00:00:00Z" });
  session.blocks = [{ ...createBlockRef({ id: "b", type: "markdown", source: "ai_transcription", path: "blocks/b.md", createdAt: session.createdAt }), fromAssets: [path] }];
  await writeFile(join(directory, "session.json"), JSON.stringify(session));
  await writeFile(join(directory, "blocks/b.md"), markdown);
  await writeFile(join(directory, path), bytes);
  const queue = new SessionWriteCoordinator();
  const sync = new WorkspaceSyncService(root, join(root, "state"), (n, s, op) => queue.run(n, s, op));
  return { root, directory, path, bytes, markdown, sync };
}

describe("encoded source image read / share / sync", () => {
  it("renders and shares the actual processed image, then preserves it across a body push", async () => {
    const f = await fixture();
    const block = await readReadonlySessionBlock({ rootDir: f.root, notebookId: "n", sessionId: "s", blockId: "b" });
    if (block.content.kind !== "markdown") throw new Error("markdown required");
    expect(block.content.html.match(/<img /g)).toHaveLength(1);
    expect(block.content.html).toContain(`data:image/png;base64,${f.bytes.toString("base64")}`);
    expect(block.content.html).toContain("katex");
    expect(block.content.markdown).toBe(f.markdown);
    expect(await readFile(join(f.directory, "blocks/b.md"), "utf8")).toBe(f.markdown);
    const preview = await readReadonlySessionPreview({ rootDir: f.root, notebookId: "n", sessionId: "s" });
    expect(preview.html).toContain(`data:image/png;base64,${f.bytes.toString("base64")}`);
    const exported = await exportSessionMarkdown({ rootDir: f.root, notebookId: "n", sessionId: "s", includeMetadataComments: false, packageMode: "share" });
    expect(exported.copiedAssets).toEqual([f.path]);
    expect(exported.missingAssets).toEqual([]);
    expect(await readFile(join(exported.packageDir!, f.path))).toEqual(f.bytes);
    expect(await readFile(exported.outPath, "utf8")).toContain(`](${encodeMarkdownAssetPath(f.path)})`);
    const snapshot = await f.sync.snapshot("n", "s");
    expect(snapshot.assets.map(asset => asset.path)).toEqual([f.path]);
    expect(await f.sync.asset("n", "s", f.path, snapshot.assets[0].sha256)).toEqual(f.bytes);
    const next = structuredClone(snapshot); next.markdown["blocks/b.md"] += "\n追加正文。";
    const after = await f.sync.push({ operationId: randomUUID(), baseRevision: snapshot.revision, snapshot: next });
    expect(after.assets).toEqual(snapshot.assets);
  });
  it("rejects a junction or symlink to outside images in read, export and sync", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside"); await mkdir(outside);
    await writeFile(join(outside, "照片 (1)#50%23%25.png"), "PRIVATE_OUTSIDE_FIXTURE");
    await rm(join(f.directory, "assets", "photos"), { recursive: true });
    await symlink(outside, join(f.directory, "assets", "photos"), process.platform === "win32" ? "junction" : "dir");
    const block = await readReadonlySessionBlock({ rootDir: f.root, notebookId: "n", sessionId: "s", blockId: "b" });
    if (block.content.kind !== "markdown") throw new Error("markdown required");
    expect(block.content.html).toContain('data-asset-missing="true"');
    expect(block.content.html).not.toContain(Buffer.from("PRIVATE_OUTSIDE_FIXTURE").toString("base64"));
    const exported = await exportSessionMarkdown({ rootDir: f.root, notebookId: "n", sessionId: "s", includeMetadataComments: false, packageMode: "share" });
    expect(exported.copiedAssets).toEqual([]); expect(exported.missingAssets).toEqual([f.path]);
    await expect(f.sync.snapshot("n", "s")).rejects.toMatchObject({ code: "unsafe_path" });
  });
});

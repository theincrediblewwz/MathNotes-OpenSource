import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildCompanionSessionSnapshot } from "./companionReadService";
import { FilesystemCompanionStore } from "./filesystemCompanionStore";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(["processed.png", "黑板 课后.png"])("anchors the actual photo %s once even when the source block is hidden", async (fileName) => {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-queue-destination-")); roots.push(root);
  const sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "assets", "photos"), { recursive: true });
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  const assetPath = `assets/photos/${fileName}`;
  await writeFile(join(sessionDir, assetPath), Buffer.from([1, 2, 3]));
  await writeFile(join(sessionDir, "blocks", "0002.md"), `# 第一部分\n\n说明\n\n![处理后照片](<../${assetPath}>)\n\n后续说明\n\n![同一张照片](<../${assetPath}>)`);
  await writeFile(join(sessionDir, "session.json"), JSON.stringify({
    id: "lecture", title: "Lecture", createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", locks: [],
    blocks: [{ id: "0001", type: "image", path: assetPath, source: "android_camera" },
      { id: "0002", type: "markdown", path: "blocks/0002.md", source: "ai_transcription", fromAssets: [assetPath] }]
  }));
  const snapshot = await buildCompanionSessionSnapshot({ store: new FilesystemCompanionStore(root), notebookId: "analysis", sessionId: "lecture" });
  const assetId = createHash("sha256").update(assetPath).digest("hex").slice(0, 24);
  expect(snapshot.html).toContain('id="mathnotes-block-0002" data-block-id="0002"');
  expect(snapshot.html).not.toContain('id="mathnotes-block-0001"');
  expect(snapshot.html.match(new RegExp(`id="mathnotes-block-0002-asset-${assetId}"`, "g"))).toHaveLength(1);
  expect(snapshot.html.match(new RegExp(`data-companion-asset-id="${assetId}"`, "g"))).toHaveLength(2);
  expect(snapshot.assets).toEqual([{ id: assetId, path: assetPath, mimeType: "image/png" }]);
  await writeFile(join(sessionDir, "blocks", "0002.md"), "![escape](%2e%2e/%2e%2e/private.png)");
  await expect(buildCompanionSessionSnapshot({ store: new FilesystemCompanionStore(root), notebookId: "analysis", sessionId: "lecture" })).rejects.toThrow("escapes");
});

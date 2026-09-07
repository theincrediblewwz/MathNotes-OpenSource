import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord, normalizeMathForPortableMarkdown } from "@mathnotes/shared";
import { exportSessionMarkdown } from "./sessionExportService";
import { readReadonlySessionPreview } from "./sessionReadService";
import { buildCompanionSessionSnapshot } from "./companionReadService";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(original: string, cut: number) {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-continuation-")); roots.push(root);
  const sessionDir = join(root, "notebooks", "n", "sessions", "s");
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  const session = createSessionRecord({ id: "s", title: "连续片段", createdAt: "now" });
  const parts = [original.slice(0, cut), original.slice(cut, cut + 2), original.slice(cut + 2)];
  session.blocks = parts.map((_, index) => ({ ...createBlockRef({ id: String(index), type: "markdown", path: `blocks/${index}.md`, source: "user", continuationGroup: "g", createdAt: "now" }), ...(index === 1 ? { status: "locked" as const } : {}) }));
  for (const [index, part] of parts.entries()) await writeFile(join(sessionDir, session.blocks[index].path), part);
  await writeFile(join(sessionDir, "session.json"), JSON.stringify(session));
  return { root, session, sessionDir, store: { readSession: async () => session, getSessionDir: () => sessionDir } };
}
describe("continuation hover, HTML and portable Markdown export", () => {
  for (const original of ["中文🙂\n\n$$\\frac{x+y}{z}=1$$\n\n尾部  \n", "| 姓名 | 值 |\n| --- | --- |\n| 中文🙂 | 文本 |\n", "\r\n 中文🙂\r\n\r\n尾部  \r\n"]) {
    it(`renders and exports split payload without new separators: ${JSON.stringify(original)}`, async () => {
      const { root, store } = await fixture(original, Math.floor(original.length / 2));
      const input = { rootDir: root, notebookId: "n", sessionId: "s", includeMetadataComments: false };
      const internal = await exportSessionMarkdown({ ...input, mathCompatibility: "internal" });
      expect(await readFile(internal.outPath, "utf8")).toBe(original + "\n");
      expect(internal.exportedBlocks).toBe(3);
      const portable = await exportSessionMarkdown(input);
      expect(await readFile(portable.outPath, "utf8")).toBe(normalizeMathForPortableMarkdown(original) + "\n");
      const withMetadata = await exportSessionMarkdown({ ...input, mathCompatibility: "internal", includeMetadataComments: true });
      const metadataText = await readFile(withMetadata.outPath, "utf8");
      expect(metadataText.slice(metadataText.lastIndexOf("-->") + 5)).toBe(original + "\n");
      const preview = await readReadonlySessionPreview(input);
      const snapshot = await buildCompanionSessionSnapshot({ store, notebookId: "n", sessionId: "s" });
      if (original.includes("$$")) { expect(preview.html).toContain("<math"); expect(snapshot.html).toContain("<math"); }
      if (original.includes("| ---")) { expect(preview.html).toContain("<table>"); expect(snapshot.html).toContain("<table>"); }
      expect(preview.html.match(/class="session-preview-block"/g)).toHaveLength(1);
      for (const id of ["0", "1", "2"]) expect(snapshot.html).toContain(`id="mathnotes-block-${id}"`);
      expect(snapshot.markdown.endsWith(original)).toBe(true);
    });
  }
  it("does not render hidden pieces or reconnect across image and PDF barriers", async () => {
    const { root, store, session, sessionDir } = await fixture("beforeHIDDENafter", 6);
    session.blocks[1].renderInNote = false;
    await writeFile(join(sessionDir, "blocks/1.md"), "HIDDEN");
    await writeFile(join(sessionDir, "blocks/2.md"), "after");
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(session));
    const preview = await readReadonlySessionPreview({ rootDir: root, notebookId: "n", sessionId: "s" });
    expect(preview.html.match(/class="session-preview-block"/g)).toHaveLength(2);
    expect(preview.html).not.toContain("HIDDEN");
    const snapshot = await buildCompanionSessionSnapshot({ store, notebookId: "n", sessionId: "s" });
    expect(snapshot.html).not.toContain("HIDDEN");
    const exported = await exportSessionMarkdown({ rootDir: root, notebookId: "n", sessionId: "s", includeMetadataComments: false, mathCompatibility: "internal" });
    expect(await readFile(exported.outPath, "utf8")).toBe("before\n\nafter\n");
  });
});

it("keeps source-image preview anchors for each original continuation member", async () => {
  const original = "前文\n\n![整张处理后照片](../assets/photo.png)\n";
  const { root, store, sessionDir } = await fixture(original, original.indexOf("照片"));
  await mkdir(join(sessionDir, "assets"));
  await writeFile(join(sessionDir, "assets/photo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V1YAAAAASUVORK5CYII=", "base64"));
  const preview = await readReadonlySessionPreview({ rootDir: root, notebookId: "n", sessionId: "s" });
  expect(preview.html).toContain("data:image/png;base64,");
  const snapshot = await buildCompanionSessionSnapshot({ store, notebookId: "n", sessionId: "s" });
  expect(snapshot.assets).toHaveLength(1);
  for (const id of ["0", "1", "2"]) expect(snapshot.html).toContain(`id="mathnotes-block-${id}-asset-${snapshot.assets[0].id}"`);
  const exported = await exportSessionMarkdown({ rootDir: root, notebookId: "n", sessionId: "s", includeMetadataComments: false, mathCompatibility: "internal", packageMode: "share" });
  expect(exported.copiedAssets).toContain("assets/photo.png");
  expect(await readFile(exported.outPath, "utf8")).toContain("![整张处理后照片](assets/photo.png)");
});

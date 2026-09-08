import { mkdtemp, rm, rename, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { exportSessionMarkdown } from "./exporter";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function gate() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() }; }
describe("desktop root write barrier", () => {
  it("shares the barrier across wrapper instances and Windows root aliases but isolates libraries", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-workspace-")); roots.push(root);
    const first = new BlockStore(root), second = new BlockStore(process.platform === "win32" ? root.toUpperCase() : root);
    const hold = gate(), entered = gate(); let wrote = false;
    const barrier = first.getWriteCoordinator().runWorkspace(async () => { entered.release(); await hold.promise; });
    await entered.promise;
    const write = second.getWriteCoordinator().run("BOOK", "S", async () => { wrote = true; });
    await new BlockStore(join(root, "separate-library")).getWriteCoordinator().runWorkspace(async () => {});
    expect(wrote).toBe(false); hold.release(); await barrier; await write; expect(wrote).toBe(true);
  });
  it("directory moves exclude block and asset writers and no writer recreates a removed Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-workspace-")); roots.push(root);
    const store = new BlockStore(root), now = new Date().toISOString();
    await store.getWriteCoordinator().runWorkspace(async () => {
      await store.createSession({ notebookId: "book", sessionId: "s", title: "test", now });
      await store.appendMarkdownBlock({ notebookId: "book", sessionId: "s", markdown: "original", source: "user", now });
    });
    const entered = gate(), hold = gate();
    const moving = new BlockStore(root).getWriteCoordinator().runWorkspace(async () => {
      entered.release(); await hold.promise;
      await rename(store.getSessionDir("book", "s"), join(root, "trashed-session"));
    });
    await entered.promise;
    const append = expect(store.appendMarkdownBlock({ notebookId: "book", sessionId: "s", markdown: "late", source: "user", now })).rejects.toMatchObject({ code: "ENOENT" });
    const asset = expect(store.savePhotoAsset({ notebookId: "book", sessionId: "s", fileName: "late.png", bytes: Buffer.from("test") })).rejects.toMatchObject({ code: "ENOENT" });
    const exported = expect(exportSessionMarkdown({ rootDir: root, notebookId: "book", sessionId: "s", includeMetadataComments: false })).rejects.toMatchObject({ code: "session_not_found" });
    hold.release(); await moving; await append; await asset; await exported;
    await expect(access(store.getSessionDir("book", "s"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

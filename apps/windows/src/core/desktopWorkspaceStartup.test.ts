import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotebook, WorkspaceCatalogSyncService, writeWorkspaceContext } from "@mathnotes/core-server";
import { BlockStore } from "./blockStore";
import { emptyDesktopSessionDocument, initializeDesktopWorkspace, selectDesktopWorkspace } from "./desktopWorkspaceStartup";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-startup-")); roots.push(root);
  const store = new BlockStore(root);
  const state = join(root, "state");
  const catalog = new WorkspaceCatalogSyncService(root, state, store.getWriteCoordinator());
  const createWelcome = vi.fn(async () => {
    await createNotebook({ rootDir: root, notebookId: "functional_analysis", title: "欢迎", now: "2026-09-08T00:00:00Z" });
    await store.createSession({ notebookId: "functional_analysis", sessionId: "lecture", title: "欢迎笔记", now: "2026-09-08T00:00:00Z" });
    await store.appendMarkdownBlock({ notebookId: "functional_analysis", sessionId: "lecture", source: "user", markdown: "欢迎正文", now: "2026-09-08T00:00:00Z" });
  });
  return { root, store, state, catalog, createWelcome };
}

describe("desktop workspace startup", () => {
  it("creates welcome data once only and never reseeds user-edited default notes", async () => {
    const f = await fixture();
    const initialize = () => initializeDesktopWorkspace({ store: f.store, recoverCatalog: () => f.catalog.recover(), createWelcome: f.createWelcome });
    await initialize(); await initialize();
    expect(f.createWelcome).toHaveBeenCalledTimes(1);
    expect(await selectDesktopWorkspace(f.store)).toEqual({ notebookId: "functional_analysis", sessionId: "lecture" });
  });
  it("prefers existing saved notes, falling back to another actual note without creating the default", async () => {
    const f = await fixture();
    await f.store.createSession({ notebookId: "existing", sessionId: "one", title: "我的内容", now: "2026-09-08T00:00:00Z" });
    await writeWorkspaceContext(f.root, { notebookId: "functional_analysis", sessionId: "lecture" });
    await initializeDesktopWorkspace({ store: f.store, recoverCatalog: () => f.catalog.recover(), createWelcome: f.createWelcome });
    expect(f.createWelcome).not.toHaveBeenCalled();
    expect(await selectDesktopWorkspace(f.store)).toEqual({ notebookId: "existing", sessionId: "one" });
    await f.store.createSession({ notebookId: "existing", sessionId: "two", title: "新笔记", now: "2026-09-08T01:00:00Z" });
    await writeWorkspaceContext(f.root, { notebookId: "existing", sessionId: "one" });
    expect(await selectDesktopWorkspace(f.store)).toEqual({ notebookId: "existing", sessionId: "one" });
  });
  it.each([".mathnotes-trash", "notebooks"])("keeps an old empty workspace with %s empty", async evidence => {
    const f = await fixture(); await mkdir(join(f.root, evidence));
    await initializeDesktopWorkspace({ store: f.store, recoverCatalog: () => f.catalog.recover(), createWelcome: f.createWelcome });
    expect(f.createWelcome).not.toHaveBeenCalled();
    expect(await selectDesktopWorkspace(f.store)).toEqual({ notebookId: "", sessionId: "" });
    expect(emptyDesktopSessionDocument()).toMatchObject({ sessionId: "", sourceDocument: { text: "", markdownBlocks: [] }, renderBlocks: [] });
  });
  it.each([false, true])("does not resurrect a trashed default %s and can restore its original IDs", async wholeNotebook => {
    const f = await fixture();
    await initializeDesktopWorkspace({ store: f.store, recoverCatalog: () => f.catalog.recover(), createWelcome: f.createWelcome });
    await writeWorkspaceContext(f.root, { notebookId: "functional_analysis", sessionId: "lecture" });
    const before = (await f.catalog.catalogState()).notebooks[0];
    const sessionId = wholeNotebook ? undefined : "lecture";
    const baseRevision = wholeNotebook ? before.revision : before.sessions![0].revision;
    const deletion = await f.catalog.execute({ action: "trash", operationId: randomUUID(), notebookId: "functional_analysis", sessionId, baseRevision });
    const restarted = new WorkspaceCatalogSyncService(f.root, f.state, f.store.getWriteCoordinator());
    await initializeDesktopWorkspace({ store: f.store, recoverCatalog: () => restarted.recover(), createWelcome: f.createWelcome });
    expect(f.createWelcome).toHaveBeenCalledTimes(1);
    expect((await selectDesktopWorkspace(f.store)).sessionId).toBe("");
    await expect(stat(f.store.getSessionDir("functional_analysis", "lecture"))).rejects.toMatchObject({ code: "ENOENT" });
    const trash = (await restarted.catalogState()).trash[0];
    await restarted.execute({ action: "restore", operationId: randomUUID(), notebookId: "functional_analysis", sessionId,
      deletionId: deletion.deletionId, baseRevision: trash.revision });
    expect((await f.store.readSession("functional_analysis", "lecture")).blocks).toHaveLength(1);
    expect(await selectDesktopWorkspace(f.store)).toEqual({ notebookId: "functional_analysis", sessionId: "lecture" });
  });
  it("runs recovery before checking for welcome data, including old roots without an initialization marker", async () => {
    const f = await fixture(); await f.createWelcome();
    const recovered = vi.fn(async () => {
      await mkdir(join(f.root, ".mathnotes-trash"));
      await rename(join(f.root, "notebooks", "functional_analysis"), join(f.root, ".mathnotes-trash", "payload"));
    });
    await initializeDesktopWorkspace({ store: f.store, recoverCatalog: recovered, createWelcome: f.createWelcome });
    expect(recovered).toHaveBeenCalledOnce(); expect(f.createWelcome).toHaveBeenCalledTimes(1);
    expect((await selectDesktopWorkspace(f.store)).sessionId).toBe("");
  });
});

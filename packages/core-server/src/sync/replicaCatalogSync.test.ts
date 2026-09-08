import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceNotebook, createWorkspaceSession } from "../catalog/workspaceCommandService";
import { WorkspaceManagementService } from "../catalog/workspaceManagementService";
import { readNotesCatalog } from "../catalog/sessionCatalog";
import { SessionEditService } from "../session/sessionEditService";
import { readReadonlySessionBlock } from "../session/sessionReadService";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { NetworkApiServer } from "../api/networkApiServer";
import { WorkspaceSyncService } from "./workspaceSyncService";
import { WorkspaceCatalogSyncService } from "./workspaceCatalogSyncService";
import { ReplicaWorkspaceService } from "./replicaWorkspaceService";

const roots: string[] = []; const servers: NetworkApiServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(modern = true) {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-replica-catalog-")); roots.push(root);
  const remoteRoot = join(root, "host"); const localRoot = join(root, "replica");
  const notebook = await createWorkspaceNotebook({ rootDir: remoteRoot, title: "Host notebook" });
  const session = await createWorkspaceSession({ rootDir: remoteRoot, notebookId: notebook.notebookId, title: "Host session" });
  const hostWrites = new SessionWriteCoordinator(); const hostState = join(root, "host-state");
  const host = new WorkspaceSyncService(remoteRoot, hostState, (n, s, op) => hostWrites.run(n, s, op));
  const catalog = new WorkspaceCatalogSyncService(remoteRoot, hostState, hostWrites);
  const token = "synthetic-only-credential";
  const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token, workspaceSync: host, workspaceCatalog: modern ? catalog : undefined });
  servers.push(server); const started = await server.start();
  const connection = { origin: started.url, token, hostId: (await host.identity()).hostId };
  const writes = new SessionWriteCoordinator(); const stateDir = join(root, "replica-state");
  const replica = new ReplicaWorkspaceService(localRoot, stateDir, writes);
  const manager = new WorkspaceManagementService(localRoot, writes);
  await replica.sync(connection);
  return { root, remoteRoot, localRoot, host, catalog, replica, manager, writes, stateDir, connection,
    notebookId: notebook.notebookId, sessionId: session.sessionId };
}
async function edit(rootDir: string, notebookId: string, sessionId: string, text: string, writes?: SessionWriteCoordinator) {
  const block = await readReadonlySessionBlock({ rootDir, notebookId, sessionId, blockId: "0001" });
  if (block.content.kind !== "markdown") throw new Error("fixture");
  await new SessionEditService(rootDir, undefined, writes).saveMarkdownBlock({ notebookId, sessionId, blockId: "0001", markdown: text, baseRevision: block.content.baseRevision });
}
async function body(rootDir: string, notebookId: string, sessionId: string) {
  const block = await readReadonlySessionBlock({ rootDir, notebookId, sessionId, blockId: "0001" });
  if (block.content.kind !== "markdown") throw new Error("fixture"); return block.content.markdown;
}

describe("replica catalog outbox", () => {
  it("registers a newly created unedited Session before the next pull, then survives restart and edit", async () => {
    const f = await fixture();
    const notebook = await f.replica.createNotebook("Fresh notebook");
    await f.replica.sync(f.connection);
    const session = await f.replica.createSession(notebook.notebookId, "Unedited session");
    const result = await f.replica.sync(f.connection);
    expect(result.sessions.find(item => item.sessionId === session.sessionId)).toMatchObject({ status: "synced" });
    const restarted = new ReplicaWorkspaceService(f.localRoot, f.stateDir, f.writes);
    await edit(f.localRoot, notebook.notebookId, session.sessionId, "First edit after restart", f.writes);
    expect((await restarted.sync(f.connection)).sessions.find(item => item.sessionId === session.sessionId)?.status).toBe("synced");
    expect(await body(f.remoteRoot, notebook.notebookId, session.sessionId)).toBe("First edit after restart");
  });
  it.each(["unchanged", "edited", "unrelated"])("recovers old missing create registrations conservatively: %s", async mode => {
    const f = await fixture();
    const created = await f.replica.createSession(f.notebookId, "Previously created");
    await f.replica.sync(f.connection);
    const entries = await Promise.all((await readdir(join(f.stateDir, "catalog-outbox")))
      .map(async name => JSON.parse(await readFile(join(f.stateDir, "catalog-outbox", name), "utf8"))));
    const entry = entries.find(item => item.input.sessionId === created.sessionId)!;
    const sessionPath = join(f.localRoot, "notebooks", f.notebookId, "sessions", created.sessionId, "session.json");
    const previous = structuredClone(entry.localResult.target.snapshot.session);
    if (mode === "unrelated") delete previous.remoteCatalogOperations;
    await writeFile(sessionPath, JSON.stringify(previous));
    for (const name of await readdir(join(f.stateDir, "sessions"))) {
      const path = join(f.stateDir, "sessions", name);
      if (JSON.parse(await readFile(path, "utf8")).base.session.id === created.sessionId) await rm(path);
    }
    if (mode !== "unchanged") await edit(f.localRoot, f.notebookId, created.sessionId, "Later local work", f.writes);
    const restarted = new ReplicaWorkspaceService(f.localRoot, f.stateDir, f.writes);
    const result = await restarted.sync(f.connection);
    const status = result.sessions.find(item => item.sessionId === created.sessionId);
    if (mode === "unrelated") {
      expect(status).toMatchObject({ status: "error", error: "replica_untracked_session" });
      expect(await body(f.localRoot, f.notebookId, created.sessionId)).toBe("Later local work");
      expect(await body(f.remoteRoot, f.notebookId, created.sessionId)).not.toBe("Later local work");
    } else {
      expect(status?.status).toBe("synced");
      expect(await body(f.remoteRoot, f.notebookId, created.sessionId)).toBe(await body(f.localRoot, f.notebookId, created.sessionId));
      if (mode === "edited") expect(await body(f.localRoot, f.notebookId, created.sessionId)).toBe("Later local work");
    }
  });
  it("pulls empty notebooks and later host renames", async () => {
    const f = await fixture();
    const empty = await createWorkspaceNotebook({ rootDir: f.remoteRoot, title: "Empty" });
    await f.replica.sync(f.connection);
    expect((await readNotesCatalog({ rootDir: f.localRoot })).notebooks.find(n => n.notebookId === empty.notebookId)?.title).toBe("Empty");
    const target = (await f.catalog.catalogState()).notebooks.find(n => n.notebookId === empty.notebookId)!;
    await f.catalog.execute({ action: "rename", operationId: randomUUID(), notebookId: empty.notebookId, title: "Host renamed", baseRevision: target.revision });
    await f.replica.sync(f.connection);
    expect((await readNotesCatalog({ rootDir: f.localRoot })).notebooks.find(n => n.notebookId === empty.notebookId)?.title).toBe("Host renamed");
  });

  it("creates offline, survives restart, and uploads edits made after creating the session", async () => {
    const f = await fixture();
    const notebook = await f.replica.createNotebook("Mac notebook");
    const session = await f.replica.createSession(notebook.notebookId, "Mac session");
    await edit(f.localRoot, notebook.notebookId, session.sessionId, "Edited while offline", f.writes);
    expect((await f.replica.status()).catalogOperations).toHaveLength(2);
    const restarted = new ReplicaWorkspaceService(f.localRoot, f.stateDir, f.writes);
    const result = await restarted.sync(f.connection);
    expect(result.catalogOperations).toEqual([]);
    expect(await body(f.remoteRoot, notebook.notebookId, session.sessionId)).toBe("Edited while offline");
    expect(await body(f.localRoot, notebook.notebookId, session.sessionId)).toBe("Edited while offline");
  });

  it("orders create, rename, trash and restore without discarding later local edits", async () => {
    const f = await fixture();
    const notebook = await f.replica.createNotebook("Offline notebook");
    const session = await f.replica.createSession(notebook.notebookId, "Offline session");
    const target = { notebookId: notebook.notebookId, sessionId: session.sessionId };
    await edit(f.localRoot, target.notebookId, target.sessionId, "Before rename", f.writes);
    await f.replica.manageWorkspace({ ...target, action: "rename", title: "Renamed session" });
    await f.replica.manageWorkspace({ notebookId: target.notebookId, action: "rename", title: "Renamed notebook" });
    await f.replica.manageWorkspace({ ...target, action: "trash" });
    const receipt = (await f.manager.listTrash())[0];
    await f.replica.manageWorkspace({ ...target, action: "restore", deletionId: receipt.id });
    await edit(f.localRoot, target.notebookId, target.sessionId, "After restore", f.writes);
    const result = await f.replica.sync(f.connection);
    expect(result.catalogOperations).toEqual([]);
    expect(await body(f.remoteRoot, target.notebookId, target.sessionId)).toBe("After restore");
    expect((await f.host.snapshot(target.notebookId, target.sessionId)).session.title).toBe("Renamed session");
    expect((await f.catalog.catalogState()).notebooks.find(n => n.notebookId === target.notebookId)?.title).toBe("Renamed notebook");
    expect((await f.manager.listTrash())).toEqual([]);
  });

  it("uploads the captured body and assets before moving the host notebook into trash", async () => {
    const f = await fixture();
    const directory = join(f.localRoot, "notebooks", f.notebookId, "sessions", f.sessionId);
    await mkdir(join(directory, "assets"), { recursive: true });
    const photo = Buffer.from("synthetic image bytes");
    await writeFile(join(directory, "assets", "photo.png"), photo);
    await edit(f.localRoot, f.notebookId, f.sessionId, "Unsynced note\n\n![photo](assets/photo.png)", f.writes);
    await f.replica.manageWorkspace({ action: "trash", notebookId: f.notebookId });
    const deletion = (await f.manager.listTrash())[0];
    expect((await f.replica.sync(f.connection)).catalogOperations).toEqual([]);
    expect((await readNotesCatalog({ rootDir: f.localRoot })).notebooks).toEqual([]);
    expect((await f.catalog.catalogState()).notebooks).toEqual([]);
    expect(await readFile(join(f.remoteRoot, ".mathnotes-trash", deletion.id, "payload", "sessions", f.sessionId, "assets", "photo.png"))).toEqual(photo);
    await f.replica.manageWorkspace({ action: "restore", notebookId: f.notebookId, deletionId: deletion.id });
    expect((await f.replica.sync(f.connection)).catalogOperations).toEqual([]);
    expect(await body(f.remoteRoot, f.notebookId, f.sessionId)).toContain("Unsynced note");
    expect((await f.replica.status()).sessions[0].status).toBe("synced");
  });

  it("keeps a conflicting deletion in trash locally and never recreates it through ordinary pull", async () => {
    const f = await fixture();
    await f.replica.manageWorkspace({ action: "trash", notebookId: f.notebookId });
    await edit(f.remoteRoot, f.notebookId, f.sessionId, "Another host's new work");
    const result = await f.replica.sync(f.connection);
    expect(result.catalogOperations?.[0]).toMatchObject({ status: "conflict", error: "revision_conflict" });
    expect(await body(f.remoteRoot, f.notebookId, f.sessionId)).toBe("Another host's new work");
    expect((await readNotesCatalog({ rootDir: f.localRoot })).notebooks).toEqual([]);
    await f.replica.sync(f.connection);
    expect((await readNotesCatalog({ rootDir: f.localRoot })).notebooks).toEqual([]);
    expect(await f.manager.listTrash()).toHaveLength(1);
  });

  it("retries a lost directory response using the same operation, including after restart", async () => {
    const f = await fixture();
    await f.replica.manageWorkspace({ action: "rename", notebookId: f.notebookId, sessionId: f.sessionId, title: "Durable rename" });
    const fetch = globalThis.fetch; let lost = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith("/workspace/catalog-operation") && !lost) { lost = true; throw new Error("lost reply"); }
      return response;
    });
    expect((await f.replica.sync(f.connection)).catalogOperations?.[0].status).toBe("pending");
    const revision = (await f.host.snapshot(f.notebookId, f.sessionId)).revision;
    vi.restoreAllMocks();
    const restarted = new ReplicaWorkspaceService(f.localRoot, f.stateDir, f.writes);
    expect((await restarted.sync(f.connection)).catalogOperations).toEqual([]);
    expect((await f.host.snapshot(f.notebookId, f.sessionId)).revision).toBe(revision);
  });

  it("does not poison the durable queue with invalid titles, and keeps old hosts compatible", async () => {
    const f = await fixture();
    await expect(f.replica.createNotebook(" ")).rejects.toMatchObject({ code: "invalid_title" });
    await expect(f.replica.manageWorkspace({ action: "rename", notebookId: f.notebookId, title: " " })).rejects.toMatchObject({ code: "invalid_title" });
    await expect(f.replica.createSession("missing_parent", "Orphan")).rejects.toMatchObject({ code: "item_not_found" });
    await expect(f.replica.manageWorkspace({ action: "restore", notebookId: "missing_parent", deletionId: randomUUID() })).rejects.toMatchObject({ code: "invalid_receipt" });
    await f.replica.createNotebook("Valid after error");
    expect((await f.replica.sync(f.connection)).catalogOperations).toEqual([]);
    const old = await fixture(false);
    await expect(old.replica.createNotebook("Unsupported")).rejects.toMatchObject({ code: "host_catalog_upgrade_required" });
    expect((await old.replica.sync(old.connection)).sessions[0].status).toBe("synced");
    expect(await readdir(join(old.stateDir, "catalog-outbox")).catch(() => [])).toEqual([]);
  });

  it("recovers the local intent after a directory moved but its outbox checkpoint did not", async () => {
    const f = await fixture();
    await f.replica.manageWorkspace({ action: "trash", notebookId: f.notebookId, sessionId: f.sessionId });
    const directory = join(f.stateDir, "catalog-outbox");
    const file = join(directory, (await readdir(directory))[0]);
    const entry = JSON.parse(await readFile(file, "utf8"));
    entry.status = "prepared"; delete entry.localResult;
    await writeFile(file, JSON.stringify(entry));
    const restarted = new ReplicaWorkspaceService(f.localRoot, f.stateDir, f.writes);
    expect((await restarted.sync(f.connection)).catalogOperations).toEqual([]);
    expect((await f.catalog.catalogState()).trash[0].id).toBe(entry.id);
    expect(await f.manager.listTrash()).toHaveLength(1);
  });

  it("does not authorize deleting a host rename that happened after the catalog was read", async () => {
    const f = await fixture();
    const fetch = globalThis.fetch; let changed = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith("/workspace/catalog") && !changed) {
        changed = true;
        const target = (await f.catalog.catalogState()).notebooks[0];
        await f.catalog.execute({ operationId: randomUUID(), action: "rename", notebookId: f.notebookId,
          title: "Unseen host rename", baseRevision: target.revision });
      }
      return response;
    });
    await f.replica.sync(f.connection);
    vi.restoreAllMocks();
    expect((await readNotesCatalog({ rootDir: f.localRoot })).notebooks[0].title).toBe("Host notebook");
    await f.replica.manageWorkspace({ action: "trash", notebookId: f.notebookId });
    expect((await f.replica.sync(f.connection)).catalogOperations?.[0]).toMatchObject({ status: "conflict", error: "revision_conflict" });
    expect((await f.catalog.catalogState()).notebooks[0].title).toBe("Unseen host rename");
  });

  it("archives local notes, trash and pending operations before adopting the host version", async () => {
    const f = await fixture();
    await edit(f.localRoot, f.notebookId, f.sessionId, "Local content must survive", f.writes);
    await f.replica.manageWorkspace({ action: "rename", notebookId: f.notebookId, title: "Local name" });
    await f.replica.manageWorkspace({ action: "trash", notebookId: f.notebookId, sessionId: f.sessionId });
    const receipt = (await f.manager.listTrash())[0];
    await edit(f.remoteRoot, f.notebookId, f.sessionId, "New host content");
    const synced = await f.replica.sync(f.connection);
    const operationId = synced.catalogOperations![0].id;
    expect((await f.replica.catalogConflicts())[0]).toMatchObject({ id: operationId, pendingCount: 2 });
    const hostBefore = (await f.host.snapshot(f.notebookId, f.sessionId)).revision;
    const resolved = await f.replica.resolveCatalog({ catalogOperationId: operationId, choice: "remote" });
    const backup = join(f.localRoot, resolved.backupRelativePath);
    expect(JSON.parse(await readFile(join(backup, "notebook", "notebook.json"), "utf8")).title).toBe("Local name");
    const payload = join(backup, "trash", receipt.id, "payload");
    const manifest = JSON.parse(await readFile(join(payload, "session.json"), "utf8"));
    expect(await readFile(join(payload, manifest.blocks[0].path), "utf8")).toBe("Local content must survive");
    expect(await readdir(join(backup, "sync-state"))).toHaveLength(1);
    expect((await f.host.snapshot(f.notebookId, f.sessionId)).revision).toBe(hostBefore);
    expect((await f.replica.status()).catalogOperations).toEqual([]);
    expect(await f.manager.listTrash()).toEqual([]);
    await f.replica.sync(f.connection);
    expect(await body(f.localRoot, f.notebookId, f.sessionId)).toBe("New host content");
    // Repeating the resolution must not archive the freshly downloaded notebook.
    expect(await f.replica.resolveCatalog({ catalogOperationId: operationId, choice: "remote" })).toEqual(resolved);
    expect(await body(f.localRoot, f.notebookId, f.sessionId)).toBe("New host content");
  });

  it("resumes a prepared resolution after its first directory move on restart", async () => {
    const f = await fixture();
    await f.replica.manageWorkspace({ action: "rename", notebookId: f.notebookId, title: "Local rename" });
    await edit(f.remoteRoot, f.notebookId, f.sessionId, "Host wins after recovery");
    const operationId = (await f.replica.sync(f.connection)).catalogOperations![0].id;
    const resolution = await f.replica.resolveCatalog({ catalogOperationId: operationId, choice: "remote" });
    const file = join(f.stateDir, "catalog-resolutions", operationId + ".json");
    const journal = JSON.parse(await readFile(file, "utf8")); journal.phase = "prepared";
    await writeFile(file, JSON.stringify(journal));
    for (const entry of journal.operations) await writeFile(join(f.stateDir, "catalog-outbox", entry.id + ".json"), JSON.stringify(entry));
    const backup = join(f.localRoot, resolution.backupRelativePath);
    // The note has already moved. Recovery should finish bookkeeping exactly once.
    const restarted = new ReplicaWorkspaceService(f.localRoot, f.stateDir, f.writes);
    await restarted.recover();
    expect((await restarted.status()).catalogOperations).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8")).phase).toBe("applied");
    expect(await readdir(join(backup, "notebook", "sessions"))).toContain(f.sessionId);
    await restarted.sync(f.connection);
    expect(await body(f.localRoot, f.notebookId, f.sessionId)).toBe("Host wins after recovery");
  });
});

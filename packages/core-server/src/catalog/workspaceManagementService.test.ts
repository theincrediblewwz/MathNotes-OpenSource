import { mkdtemp, readFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceNotebook, createWorkspaceSession } from "./workspaceCommandService";
import { readNotesCatalog } from "./sessionCatalog";
import { WorkspaceManagementService } from "./workspaceManagementService";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-workspace-management-")); roots.push(root);
  const notebook = await createWorkspaceNotebook({ rootDir: root, title: "原笔记本" });
  const session = await createWorkspaceSession({ rootDir: root, notebookId: notebook.notebookId, title: "原 Session" });
  const writes = new SessionWriteCoordinator();
  return { root, notebook, session, writes, manager: new WorkspaceManagementService(root, writes) };
}
describe("recoverable workspace management", () => {
  it("renames metadata without moving identities or altering blocks, then restores all bytes after restart", async () => {
    const { root, notebook, session, manager } = await fixture();
    const target = { notebookId: notebook.notebookId, sessionId: session.sessionId };
    const block = join(root, "notebooks", target.notebookId, "sessions", target.sessionId, "blocks/0001_user_note.md");
    const original = await readFile(block);
    await manager.manage({ action: "rename", notebookId: target.notebookId, title: " 新笔记本 " });
    await manager.manage({ action: "rename", ...target, title: "新 Session" });
    expect((await readNotesCatalog({ rootDir: root })).notebooks[0]).toMatchObject({ title: "新笔记本", sessions: [{ title: "新 Session" }] });
    await manager.manage({ action: "trash", ...target });
    expect((await readNotesCatalog({ rootDir: root })).notebooks[0].sessions).toHaveLength(0);
    const restarted = new WorkspaceManagementService(root);
    const [entry] = await restarted.listTrash();
    expect(entry.title).toBe("新 Session");
    await restarted.manage({ action: "restore", ...target, deletionId: entry.id });
    expect(await readFile(block)).toEqual(original);
    expect(await restarted.listTrash()).toEqual([]);
  });
  it("moves and restores a whole notebook including assets, but refuses to overwrite existing destinations", async () => {
    const { root, notebook, manager } = await fixture();
    const notebookPath = join(root, "notebooks", notebook.notebookId);
    await writeFile(join(notebookPath, "retained-photo.jpg"), Buffer.from([1, 2, 3]));
    await manager.manage({ action: "trash", notebookId: notebook.notebookId });
    expect((await readNotesCatalog({ rootDir: root })).notebooks).toEqual([]);
    const [entry] = await manager.listTrash();
    await mkdir(notebookPath);
    await expect(manager.manage({ action: "restore", notebookId: notebook.notebookId, deletionId: entry.id })).rejects.toMatchObject({ code: "restore_conflict" });
    expect(await manager.listTrash()).toHaveLength(1);
    await rm(notebookPath, { recursive: true });
    await manager.manage({ action: "restore", notebookId: notebook.notebookId, deletionId: entry.id });
    expect(await readFile(join(notebookPath, "retained-photo.jpg"))).toEqual(Buffer.from([1, 2, 3]));
  });
  it("requires the original notebook to exist when restoring a separately deleted session", async () => {
    const { root, notebook, session, manager } = await fixture();
    const target = { notebookId: notebook.notebookId, sessionId: session.sessionId };
    await manager.manage({ action: "trash", ...target });
    const [deletedSession] = await manager.listTrash();
    await manager.manage({ action: "trash", notebookId: notebook.notebookId });
    await expect(manager.manage({ action: "restore", ...target, deletionId: deletedSession.id })).rejects.toMatchObject({ code: "workspace_item_not_found" });
    expect((await readNotesCatalog({ rootDir: root })).notebooks).toEqual([]);
    const deletedNotebook = (await manager.listTrash()).find(entry => !entry.sessionId)!;
    await manager.manage({ action: "restore", notebookId: notebook.notebookId, deletionId: deletedNotebook.id });
    await manager.manage({ action: "restore", ...target, deletionId: deletedSession.id });
    expect((await readNotesCatalog({ rootDir: root })).notebooks[0].sessions).toHaveLength(1);
  });
  it("rejects traversal, symlink destinations, malformed recovery receipts and blank names", async () => {
    const { root, notebook, manager } = await fixture();
    await expect(manager.manage({ action: "trash", notebookId: "../outside" })).rejects.toMatchObject({ code: "invalid_id" });
    await expect(manager.manage({ action: "rename", notebookId: notebook.notebookId, title: " " })).rejects.toMatchObject({ code: "invalid_title" });
    await symlink(join(root, "notebooks", notebook.notebookId), join(root, "notebooks", "linked"));
    await expect(manager.manage({ action: "trash", notebookId: "linked" })).rejects.toMatchObject({ code: "unsafe_path" });
    await manager.manage({ action: "trash", notebookId: notebook.notebookId });
    const [entry] = await manager.listTrash();
    await writeFile(join(root, ".mathnotes-trash", entry.id, "receipt.json"), JSON.stringify({ ...entry, notebookId: "../outside" }));
    expect(await manager.listTrash()).toEqual([]);
    await expect(manager.manage({ action: "restore", notebookId: notebook.notebookId, deletionId: entry.id })).rejects.toMatchObject({ code: "invalid_id" });
  });
  it("waits for an in-flight save before moving a notebook and fences subsequent saves", async () => {
    const { root, notebook, session, manager, writes } = await fixture();
    const sequence: string[] = [];
    let finish!: () => void;
    const save = writes.run(notebook.notebookId, session.sessionId, async () => {
      sequence.push("save started");
      await new Promise<void>(resolve => { finish = resolve; });
      await writeFile(join(root, "notebooks", notebook.notebookId, "saved.txt"), "retained");
      sequence.push("save finished");
    });
    await new Promise(resolve => setImmediate(resolve));
    const deletion = manager.manage({ action: "trash", notebookId: notebook.notebookId }).then(() => { sequence.push("deleted"); });
    const later = writes.run(notebook.notebookId, session.sessionId, async () => { sequence.push("later"); });
    expect(sequence).toEqual(["save started"]);
    finish(); await Promise.all([save, deletion, later]);
    expect(sequence).toEqual(["save started", "save finished", "deleted", "later"]);
    const [entry] = await manager.listTrash();
    expect(await readFile(join(root, ".mathnotes-trash", entry.id, "payload", "saved.txt"), "utf8")).toBe("retained");
  });
});

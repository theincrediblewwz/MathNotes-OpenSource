import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { SessionEditService } from "../session/sessionEditService";


import { WorkspaceSyncService, replicaRevision, type ReplicaSnapshot } from "./workspaceSyncService";
import { WorkspaceCatalogSyncService, type CatalogOperation } from "./workspaceCatalogSyncService";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-catalog-sync-")); roots.push(root);
  await mkdir(join(root, "notebooks"));
  const state = join(root, "state");
  const writes = new SessionWriteCoordinator();
  const catalog = new WorkspaceCatalogSyncService(root, state, writes);
  const sync = new WorkspaceSyncService(root, state, (n, s, operation) => writes.run(n, s, operation));
  return { root, state, writes, catalog, sync };
}
function op(input: Omit<CatalogOperation, "operationId">): CatalogOperation { return { operationId: randomUUID(), ...input }; }
function journalPath(root: string, state: string, operationId: string): string {
  const identity = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  return join(state, "catalog-operations", createHash("sha256").update(identity).digest("hex"), operationId + ".json");
}
function snapshot(notebookId = "n", sessionId = "s"): ReplicaSnapshot {
  const session = createSessionRecord({ id: sessionId, title: "数学课", createdAt: "2026-09-08T00:00:00Z" });
  session.blocks.push(createBlockRef({ id: "b", type: "markdown", path: "blocks/b.md", source: "user", createdAt: session.createdAt }));
  const result: ReplicaSnapshot = { version: 1, notebookId, session, markdown: { "blocks/b.md": "正文 $a+b=c$" }, assets: [], revision: "" };
  result.revision = replicaRevision(result); return result;
}
async function seed(catalog: WorkspaceCatalogSyncService) {
  await catalog.execute(op({ action: "create_notebook", notebookId: "n", title: "笔记本", baseRevision: null }));
  return catalog.execute(op({ action: "create_session", notebookId: "n", sessionId: "s", snapshot: snapshot(), baseRevision: null }));
}

describe("workspace catalog mutations", () => {
  it("keeps identical target IDs and operation IDs independent when two libraries share app state", async () => {
    const { root, state, catalog, sync } = await fixture();
    const otherRoot = join(root, "other-library");
    await mkdir(join(otherRoot, "notebooks"), { recursive: true });
    const otherWrites = new SessionWriteCoordinator();
    const other = new WorkspaceCatalogSyncService(otherRoot, state, otherWrites);
    const otherSync = new WorkspaceSyncService(otherRoot, state, (n, s, operation) => otherWrites.run(n, s, operation));
    const notebook = op({ action: "create_notebook", notebookId: "n", title: "第一份库", baseRevision: null });
    const firstNotebook = await catalog.execute(notebook);
    const secondNotebookInput = { ...notebook, title: "第二份库" };
    const secondNotebook = await other.execute(secondNotebookInput);
    expect(firstNotebook.target.title).toBe("第一份库");
    expect(secondNotebook.target.title).toBe("第二份库");
    const create = op({ action: "create_session", notebookId: "n", sessionId: "s", snapshot: snapshot(), baseRevision: null });
    const firstSession = await catalog.execute(create);
    const secondCreate = structuredClone(create);
    secondCreate.snapshot!.session.title = "另一份课";
    secondCreate.snapshot!.markdown["blocks/b.md"] = "独立的正文";
    const secondSession = await other.execute(secondCreate);
    expect(await catalog.execute(create)).toEqual(firstSession);
    expect(await other.execute(secondCreate)).toEqual(secondSession);
    expect(Object.values((await sync.snapshot("n", "s")).markdown)).toEqual(["正文 $a+b=c$"]);
    expect(Object.values((await otherSync.snapshot("n", "s")).markdown)).toEqual(["独立的正文"]);
    expect((await catalog.catalogState()).notebooks[0].title).toBe("第一份库");
    expect((await other.catalogState()).notebooks[0].title).toBe("第二份库");
    const ledger = firstSession.target.metadata.remoteCatalogOperations as Record<string, string>;
    const otherLedger = secondSession.target.metadata.remoteCatalogOperations as Record<string, string>;
    expect(ledger[create.operationId]).not.toBe(otherLedger[create.operationId]);
    expect((await readdir(join(state, "catalog-operations"))).sort()).toHaveLength(2);
  });

  it("recovers only the selected library's unfinished receipt despite a shared state directory", async () => {
    const { root, state, writes } = await fixture();
    const otherRoot = join(root, "other-library");
    await mkdir(join(otherRoot, "notebooks"), { recursive: true });
    const otherWrites = new SessionWriteCoordinator();
    const fail = { afterCommit: async () => { throw new Error("lost_reply"); } };
    const first = new WorkspaceCatalogSyncService(root, state, writes, fail);
    const second = new WorkspaceCatalogSyncService(otherRoot, state, otherWrites, fail);
    const input = op({ action: "create_notebook", notebookId: "n", title: "A库", baseRevision: null });
    const otherInput = { ...input, title: "B库" };
    await expect(first.execute(input)).rejects.toThrow("lost_reply");
    await expect(second.execute(otherInput)).rejects.toThrow("lost_reply");
    const firstFile = journalPath(root, state, input.operationId);
    const secondFile = journalPath(otherRoot, state, input.operationId);
    const firstReceipt = JSON.parse(await readFile(firstFile, "utf8"));
    const secondReceipt = JSON.parse(await readFile(secondFile, "utf8"));
    expect(firstReceipt.phase).toBe("prepared"); expect(secondReceipt.phase).toBe("prepared");
    const restartedSecond = new WorkspaceCatalogSyncService(otherRoot, state, otherWrites);
    await restartedSecond.recover();
    expect(JSON.parse(await readFile(firstFile, "utf8")).phase).toBe("prepared");
    expect(JSON.parse(await readFile(secondFile, "utf8")).phase).toBe("applied");
    const restartedFirst = new WorkspaceCatalogSyncService(root, state, writes);
    await restartedFirst.recover();
    expect(JSON.parse(await readFile(firstFile, "utf8")).phase).toBe("applied");
    expect(await restartedFirst.execute(input)).toEqual(firstReceipt.result);
    expect(await restartedSecond.execute(otherInput)).toEqual(secondReceipt.result);
  });

  it("validates typed requests before recording any intent or creating any target", async () => {
    const { state, root, catalog } = await fixture();
    const create = op({ action: "create_notebook", notebookId: "n", title: "合法", baseRevision: null });
    for (const change of [{ title: 42 }, { title: "\0秘密" }, { title: "   " }, { notebookId: "CON" },
      { notebookId: "x:private" }, { notebookId: "n." }, { notebookId: "n " }, { notebookId: "x".repeat(129) },
      { baseRevision: "wrong" }, { operationId: "-".repeat(36) }, { sessionId: "s" }]) {
      await expect(catalog.execute({ ...create, ...change } as CatalogOperation)).rejects.toMatchObject({ statusCode: 400 });
    }
    const badSnapshot = op({ action: "create_session", notebookId: "n", sessionId: "s", baseRevision: null,
      snapshot: snapshot("other") });
    await expect(catalog.execute(badSnapshot)).rejects.toMatchObject({ code: "invalid_snapshot" });
    expect(await readdir(join(root, "notebooks"))).toEqual([]);
    await expect(stat(state)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures a queued request before callers mutate it", async () => {
    const { catalog, writes } = await fixture();
    let release!: () => void;
    const prior = writes.run("n", "s", () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve(); await Promise.resolve();
    const input = op({ action: "create_notebook", notebookId: "n", title: "原始中文", baseRevision: null });
    const exact = structuredClone(input);
    const pending = catalog.execute(input);
    input.title = "被修改"; input.notebookId = "../escape";
    release(); await prior;
    const result = await pending;
    expect(result.target.title).toBe("原始中文");
    expect(result.target.notebookId).toBe("n");
    expect(await catalog.execute(exact)).toEqual(result);
  });

  it("serializes concurrent creates and does not replace the winning stable ID", async () => {
    const { catalog } = await fixture();
    const create = op({ action: "create_notebook", notebookId: "n", title: "第一个", baseRevision: null });
    const outcomes = await Promise.allSettled([catalog.execute(create), catalog.execute({ ...create }),
      catalog.execute({ ...create, operationId: randomUUID(), title: "第二个" })]);
    expect(outcomes[0].status).toBe("fulfilled"); expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toMatchObject({ status: "rejected", reason: { code: "workspace_conflict" } });
    expect((await catalog.catalogState()).notebooks[0].title).toBe("第一个");
  });

  it("rejects stale renames and includes every session in the notebook revision", async () => {
    const { catalog } = await fixture();
    const added = await seed(catalog);
    const old = (await catalog.catalogState()).notebooks[0];
    await catalog.execute(op({ action: "create_session", notebookId: "n", sessionId: "s2", snapshot: snapshot("n", "s2"), baseRevision: null }));
    await expect(catalog.execute(op({ action: "rename", notebookId: "n", title: "旧目录重命名", baseRevision: old.revision }))).rejects.toMatchObject({ code: "revision_conflict" });
    const renamed = await catalog.execute(op({ action: "rename", notebookId: "n", sessionId: "s", title: "新名字", baseRevision: added.target.revision }));
    await expect(catalog.execute(op({ action: "rename", notebookId: "n", sessionId: "s", title: "旧名字覆盖", baseRevision: added.target.revision }))).rejects.toMatchObject({ code: "revision_conflict" });
    expect(renamed.target.snapshot!.markdown).toEqual(added.target.snapshot!.markdown);
    expect((await catalog.catalogState()).notebooks[0].sessions!.map(item => item.sessionId)).toEqual(["s", "s2"]);
  });

  it("strips client-supplied host ledgers when importing a new session", async () => {
    const { catalog } = await fixture();
    await catalog.execute(op({ action: "create_notebook", notebookId: "n", title: "名字", baseRevision: null }));
    const imported = snapshot();
    Object.assign(imported.session, { remoteCatalogOperations: { forged: "proof" }, remoteSyncOperations: { forged: "proof" } });
    const created = await catalog.execute(op({ action: "create_session", notebookId: "n", sessionId: "s", snapshot: imported, baseRevision: null }));
    expect(created.target.metadata.remoteCatalogOperations).toEqual({ [created.operationId]: expect.any(String) });
    expect(created.target.metadata.remoteSyncOperations).toBeUndefined();
  });

  it("never publishes an incomplete snapshot when staged bytes fail verification", async () => {
    const { catalog, root, state } = await fixture();
    await catalog.execute(op({ action: "create_notebook", notebookId: "n", title: "名字", baseRevision: null }));
    const input = op({ action: "create_session", notebookId: "n", sessionId: "s", snapshot: snapshot(), baseRevision: null });
    const bytes = Buffer.from("correct"); const sha256 = createHash("sha256").update(bytes).digest("hex");
    input.snapshot!.assets = [{ path: "assets/图片.png", sha256, byteLength: bytes.length }];
    input.snapshot!.session.blocks[0].fromAssets = ["assets/图片.png"];
    await mkdir(join(state, "incoming", input.operationId), { recursive: true });
    await writeFile(join(state, "incoming", input.operationId, sha256), "corrupt");
    await expect(catalog.execute(input)).rejects.toMatchObject({ code: "asset_hash_mismatch" });
    await expect(stat(join(root, "notebooks/n/sessions/s"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await catalog.catalogState()).notebooks[0].sessions).toEqual([]);
  });

  it.each(["create_notebook", "create_session", "rename", "trash", "restore"] as const)("keeps %s recoverable across a failure before publication", async action => {
    const { catalog, root, state, writes } = await fixture();
    const added = await seed(catalog);
    let input: CatalogOperation;
    if (action === "create_notebook") input = op({ action, notebookId: "new", title: "新目录", baseRevision: null });
    else if (action === "create_session") input = op({ action, notebookId: "n", sessionId: "new", snapshot: snapshot("n", "new"), baseRevision: null });
    else if (action === "restore") {
      const deleted = await catalog.execute(op({ action: "trash", notebookId: "n", sessionId: "s", baseRevision: added.target.revision }));
      input = op({ action, notebookId: "n", sessionId: "s", deletionId: deleted.deletionId, baseRevision: deleted.target.revision });
    } else input = op({ action, notebookId: "n", sessionId: "s", title: "新名字", baseRevision: added.target.revision });
    const before = await catalog.catalogState();
    const failing = new WorkspaceCatalogSyncService(root, state, writes, { beforeCommit: async () => { throw new Error("before_publication"); } });
    await expect(failing.execute(input)).rejects.toThrow("before_publication");
    const restarted = new WorkspaceCatalogSyncService(root, state, writes);
    await restarted.recover();
    expect(await restarted.catalogState()).toEqual(before);
    const result = await restarted.execute(input);
    expect(await restarted.execute(input)).toEqual(result);
  });

  it.each(["create_notebook", "create_session", "rename", "trash", "restore"] as const)("recovers the original %s result after publication but before its result receipt", async action => {
    const { catalog, root, state, writes } = await fixture();
    const added = await seed(catalog);
    let input: CatalogOperation;
    if (action === "create_notebook") input = op({ action, notebookId: "new", title: "新目录", baseRevision: null });
    else if (action === "create_session") input = op({ action, notebookId: "n", sessionId: "new", snapshot: snapshot("n", "new"), baseRevision: null });
    else if (action === "restore") {
      const deleted = await catalog.execute(op({ action: "trash", notebookId: "n", sessionId: "s", baseRevision: added.target.revision }));
      input = op({ action, notebookId: "n", sessionId: "s", deletionId: deleted.deletionId, baseRevision: deleted.target.revision });
    } else input = op({ action, notebookId: "n", sessionId: "s", title: "新名字", baseRevision: added.target.revision });
    const failing = new WorkspaceCatalogSyncService(root, state, writes, { afterCommit: async () => { throw new Error("lost_reply"); } });
    await expect(failing.execute(input)).rejects.toThrow("lost_reply");
    const file = journalPath(root, state, input.operationId);
    const journal = JSON.parse(await readFile(file, "utf8")); expect(journal.phase).toBe("prepared");
    const restarted = new WorkspaceCatalogSyncService(root, state, writes);
    await restarted.recover();
    expect(JSON.parse(await readFile(file, "utf8")).phase).toBe("applied");
    expect(await restarted.execute(input)).toEqual(journal.result);
  });

  it("creates empty notebooks and image sessions; persistent retries keep their original results", async () => {
    const { root, state, catalog, writes, sync } = await fixture();
    const create = op({ action: "create_notebook", notebookId: "n", title: "空笔记本", baseRevision: null });
    const first = await catalog.execute(create);
    expect((await catalog.catalogState()).notebooks[0].sessions).toEqual([]);
    const createSession = op({ action: "create_session", notebookId: "n", sessionId: "s", snapshot: snapshot(), baseRevision: null });
    const bytes = Buffer.from("synthetic photo"); const sha256 = createHash("sha256").update(bytes).digest("hex");
    createSession.snapshot!.assets.push({ path: "assets/照片.png", sha256, byteLength: bytes.length });
    createSession.snapshot!.session.blocks[0].fromAssets = ["assets/照片.png"];
    await expect(catalog.execute(createSession)).rejects.toMatchObject({ code: "asset_not_staged" });
    await sync.stageAsset({ operationId: createSession.operationId, sha256, base64: bytes.toString("base64") });
    const added = await catalog.execute(createSession);
    expect((await sync.snapshot("n", "s")).revision).toBe(added.target.revision);
    expect(await readFile(join(root, "notebooks/n/sessions/s/assets/照片.png"))).toEqual(bytes);
    const fresh = new WorkspaceCatalogSyncService(root, state, writes);
    expect(await fresh.execute(create)).toEqual(first);
    await expect(fresh.execute({ ...create, title: "另一名字" })).rejects.toMatchObject({ code: "operation_reused" });
  });

  it("rejects deleting an outdated notebook and restores all its notes and fixed blocks", async () => {
    const { root, catalog, sync, writes } = await fixture();
    await seed(catalog);
    const old = (await catalog.catalogState()).notebooks[0];
    const base = await sync.snapshot("n", "s");
    const edited = structuredClone(base); edited.markdown[edited.session.blocks[0].path] += "\n主机新增";
    await sync.push({ operationId: randomUUID(), baseRevision: base.revision, snapshot: edited });
    await expect(catalog.execute(op({ action: "trash", notebookId: "n", baseRevision: old.revision }))).rejects.toMatchObject({ code: "revision_conflict" });
    await new SessionEditService(root, undefined, writes).setMarkdownBlockLock({ notebookId: "n", sessionId: "s", blockId: "b", locked: true });
    const current = (await catalog.catalogState()).notebooks[0];
    const deletion = op({ action: "trash", notebookId: "n", baseRevision: current.revision });
    const deleted = await catalog.execute(deletion);
    expect((await catalog.catalogState()).notebooks).toEqual([]);
    expect((await catalog.catalogState()).trash[0].id).toBe(deleted.deletionId);
    const trash = (await catalog.catalogState()).trash[0];
    const restore = op({ action: "restore", notebookId: "n", deletionId: trash.id, baseRevision: trash.revision });
    await catalog.execute(restore);
    expect((await sync.snapshot("n", "s")).session.blocks[0].status).toBe("locked");
    expect(Object.values((await sync.snapshot("n", "s")).markdown).join("")).toContain("主机新增");
    expect(await catalog.execute(deletion)).toEqual(deleted); // Do not delete again after restore.
    expect((await catalog.catalogState()).notebooks).toHaveLength(1);
  });

  it("recovers a committed rename whose result journal was not finalized", async () => {
    const { root, state, writes, catalog, sync } = await fixture();
    const added = await seed(catalog);
    const input = op({ action: "rename", notebookId: "n", sessionId: "s", title: "改名", baseRevision: added.target.revision });
    const result = await catalog.execute(input);
    const file = journalPath(root, state, input.operationId);
    const journal = JSON.parse(await readFile(file, "utf8")); journal.phase = "prepared"; await writeFile(file, JSON.stringify(journal));
    const restarted = new WorkspaceCatalogSyncService(root, state, writes);
    expect(await restarted.execute(input)).toEqual(result);
    expect((await sync.snapshot("n", "s")).session.title).toBe("改名");
  });

  it("resumes a restore interrupted after preparing metadata but before moving the directory", async () => {
    const { root, state, writes, catalog } = await fixture();
    const added = await seed(catalog);
    const deleted = await catalog.execute(op({ action: "trash", notebookId: "n", sessionId: "s", baseRevision: added.target.revision }));
    const input = op({ action: "restore", notebookId: "n", sessionId: "s", deletionId: deleted.deletionId!, baseRevision: deleted.target.revision });
    const result = await catalog.execute(input);
    await rename(join(root, "notebooks/n/sessions/s"), join(root, ".mathnotes-trash", deleted.deletionId!, "payload"));
    const file = journalPath(root, state, input.operationId);
    const journal = JSON.parse(await readFile(file, "utf8")); journal.phase = "prepared"; await writeFile(file, JSON.stringify(journal));
    expect(await new WorkspaceCatalogSyncService(root, state, writes).execute(input)).toEqual(result);
    expect((await stat(join(root, "notebooks/n/sessions/s/session.json"))).isFile()).toBe(true);
  });

  it("recovers a moved but unfinalized trash entry before the host accepts requests", async () => {
    const { root, state, catalog, writes } = await fixture();
    const added = await seed(catalog);
    const input = op({ action: "trash", notebookId: "n", sessionId: "s", baseRevision: added.target.revision });
    await catalog.execute(input);
    const journalFile = journalPath(root, state, input.operationId);
    const receiptFile = join(root, ".mathnotes-trash", input.operationId, "receipt.json");
    const journal = JSON.parse(await readFile(journalFile, "utf8")); journal.phase = "prepared";
    const receipt = JSON.parse(await readFile(receiptFile, "utf8")); delete receipt.committedAt;
    await writeFile(journalFile, JSON.stringify(journal)); await writeFile(receiptFile, JSON.stringify(receipt));
    const restarted = new WorkspaceCatalogSyncService(root, state, writes);
    await restarted.recover();
    expect((await restarted.catalogState()).trash[0].id).toBe(input.operationId);
  });

  it("refuses a restore when a different note now occupies the original ID", async () => {
    const { catalog, sync } = await fixture();
    const added = await seed(catalog);
    const deleted = await catalog.execute(op({ action: "trash", notebookId: "n", sessionId: "s", baseRevision: added.target.revision }));
    const replacement = snapshot(); replacement.markdown["blocks/b.md"] = "replacement note";
    await catalog.execute(op({ action: "create_session", notebookId: "n", sessionId: "s", snapshot: replacement, baseRevision: null }));
    await expect(catalog.execute(op({ action: "restore", notebookId: "n", sessionId: "s", deletionId: deleted.deletionId,
      baseRevision: deleted.target.revision }))).rejects.toMatchObject({ code: "restore_conflict" });
    expect(Object.values((await sync.snapshot("n", "s")).markdown)).toEqual(["replacement note"]);
    expect((await catalog.catalogState()).trash).toHaveLength(1);
  });

  it("serializes a notebook delete behind a running session edit and rejects its stale baseline", async () => {
    const { catalog, writes, root } = await fixture();
    await seed(catalog);
    const notebook = (await catalog.catalogState()).notebooks[0];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const edit = writes.run("n", "s", async () => { await gate; await writeFile(join(root, "notebooks/n/sessions/s/blocks/b.md"), "in-flight edit"); });
    const deletion = catalog.execute(op({ action: "trash", notebookId: "n", baseRevision: notebook.revision }));
    release(); await edit;
    await expect(deletion).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await catalog.catalogState()).notebooks).toHaveLength(1);
  });

  it("preserves the host catalog-operation history when a content push omits it", async () => {
    const { catalog, sync } = await fixture();
    const added = await seed(catalog);
    const base = await sync.snapshot("n", "s");
    const edit = structuredClone(base);
    delete (edit.session as unknown as Record<string, unknown>).remoteCatalogOperations;
    edit.markdown[edit.session.blocks[0].path] += "\n正文编辑";
    const after = await sync.push({ operationId: randomUUID(), baseRevision: base.revision, snapshot: edit });
    expect(after.session).toHaveProperty(["remoteCatalogOperations", added.operationId]);
  });

  it("keeps path escapes and symlinked notebooks out of directory mutations", async () => {
    const { catalog, root } = await fixture();
    await expect(catalog.execute(op({ action: "create_notebook", notebookId: "../escape", title: "bad", baseRevision: null }))).rejects.toMatchObject({ code: "invalid_id" });
    await mkdir(join(root, "outside")); await symlink(join(root, "outside"), join(root, "notebooks/n"), "junction");
    await expect(catalog.execute(op({ action: "create_notebook", notebookId: "n", title: "bad", baseRevision: null }))).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(catalog.catalogState()).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("refuses linked stage and state directories before reading or writing through them", async () => {
    const { catalog, root, state, writes } = await fixture();
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, ".mathnotes-catalog-stage"), "junction");
    await expect(catalog.execute(op({ action: "create_notebook", notebookId: "n", title: "bad", baseRevision: null }))).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readdir(join(root, "outside"))).toEqual([]);
    const linkedState = join(root, "linked-state");
    await symlink(state, linkedState, "junction");
    await expect(new WorkspaceCatalogSyncService(root, linkedState, writes).recover()).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it.runIf(process.platform === "win32")("rejects case aliases for notebook and session IDs", async () => {
    const { catalog } = await fixture();
    const added = await seed(catalog);
    await expect(catalog.execute(op({ action: "create_notebook", notebookId: "N", title: "alias", baseRevision: null }))).rejects.toMatchObject({ code: "noncanonical_id" });
    await expect(catalog.execute(op({ action: "rename", notebookId: "N", sessionId: "s", title: "alias", baseRevision: added.target.revision }))).rejects.toMatchObject({ code: "noncanonical_id" });
    await expect(catalog.execute(op({ action: "trash", notebookId: "n", sessionId: "S", baseRevision: added.target.revision }))).rejects.toMatchObject({ code: "noncanonical_id" });
    expect((await catalog.catalogState()).notebooks[0].sessions![0].title).toBe("数学课");
  });

  it.each(process.platform === "win32" ? ["rename", "trash", "restore"] as const : [])("keeps %s intact while Windows holds the manifest without delete sharing, then retries", async action => {
    const { catalog, root } = await fixture();
    const added = await seed(catalog);
    let input = op({ action, notebookId: "n", sessionId: "s", title: "完成后中文标题", baseRevision: added.target.revision });
    let path = join(root, "notebooks/n/sessions/s/session.json");
    if (action === "restore") {
      const deleted = await catalog.execute(op({ action: "trash", notebookId: "n", sessionId: "s", baseRevision: added.target.revision }));
      input = { ...input, deletionId: deleted.deletionId };
      path = join(root, ".mathnotes-trash", deleted.deletionId!, "payload/session.json");
    }
    const originalBytes = await readFile(path);
    const before = await catalog.catalogState();
    const script = "$f=[IO.File]::Open($env:MATHNOTES_TEST_MANIFEST,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, MATHNOTES_TEST_MANIFEST: path }, windowsHide: true });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.on("data", bytes => { if (String(bytes).includes("LOCKED")) resolve(); }); child.once("error", reject); child.once("exit", code => { if (code) reject(new Error(`lock child ${code}`)); }); });
      await expect(catalog.execute(input)).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EACCES|EBUSY/) });
      expect((await readFile(path)).equals(originalBytes)).toBe(true);
      expect(await catalog.catalogState()).toEqual(before);
      expect((await readdir(join(path, ".."))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally { child.stdin.end("release\n"); await exited; }
    const after = await catalog.execute(input);
    expect(await catalog.execute(input)).toEqual(after);
  }, 15000);


});

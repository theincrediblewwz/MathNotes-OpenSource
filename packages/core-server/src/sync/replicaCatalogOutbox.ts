import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { WorkspaceCatalogSyncService, type CatalogOperation, type CatalogOperationResult, type CatalogTargetState } from "./workspaceCatalogSyncService";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { readReplicaSnapshotDirectory, replicaRevision, safeReplicaPath, validateReplicaId, WorkspaceSyncError, type ReplicaPush, type ReplicaSnapshot } from "./workspaceSyncService";
import type { WorkspaceManageInput } from "../catalog/workspaceManagementService";
import type { NotebookSummary, NotebookSessionSummary } from "../catalog/sessionCatalog";

export type HostCatalogState = Awaited<ReturnType<WorkspaceCatalogSyncService["catalogState"]>>;
export type CatalogDependency = { snapshot: ReplicaSnapshot; request?: ReplicaPush; done?: ReplicaSnapshot };
export type ReplicaCatalogOperation = {
  version: 1; sequence: number; id: string; title: string; input: CatalogOperation;
  status: "prepared" | "pending" | "conflict" | "applied" | "cancelled";
  dependencies: CatalogDependency[]; localResult?: CatalogOperationResult;
  remoteRequest?: CatalogOperation; remoteResult?: CatalogOperationResult;
  error?: string; remoteConflict?: HostCatalogState;
};
export type ReplicaCatalogStatus = Pick<ReplicaCatalogOperation, "id" | "title" | "status" | "error"> & {
  action: CatalogOperation["action"]; notebookId: string; sessionId?: string;
};
export type CatalogFlushBridge = {
  // Callbacks execute inside the replica's outer workspace barrier.
  syncDependency(dependency: CatalogDependency, checkpoint: () => Promise<void>): Promise<ReplicaSnapshot>;
  send(input: CatalogOperation): Promise<CatalogOperationResult>;
  readRemote(): Promise<HostCatalogState>;
  acknowledge(entry: ReplicaCatalogOperation): Promise<void>;
};

/** The caller holds the real replica workspace barrier for every method. The
 * local catalog's private queue therefore cannot race other local note writes. */
export class ReplicaCatalogOutbox {
  private readonly local: WorkspaceCatalogSyncService;
  constructor(private root: string, private state: string) {
    this.local = new WorkspaceCatalogSyncService(root, join(state, "catalog-local"), new SessionWriteCoordinator());
  }

  async entries(): Promise<ReplicaCatalogOperation[]> {
    const names = await readdir(join(this.state, "catalog-outbox")).catch(error => { if (missing(error)) return []; throw error; });
    const entries: ReplicaCatalogOperation[] = [];
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      entries.push(JSON.parse(await readFile(join(this.state, "catalog-outbox", name), "utf8")));
    }
    return entries.sort((a, b) => a.sequence - b.sequence);
  }
  async statuses(): Promise<ReplicaCatalogStatus[]> {
    return (await this.entries()).filter(active).map(entry => ({ id: entry.id, title: entry.title, status: entry.status,
      error: entry.error, action: entry.input.action, notebookId: entry.input.notebookId, sessionId: entry.input.sessionId }));
  }
  async blockedNotebooks(): Promise<Set<string>> {
    return new Set((await this.entries()).filter(active).map(entry => entry.input.notebookId));
  }
  async recoverLocal(): Promise<void> {
    for (const entry of (await this.entries()).filter(entry => entry.status === "prepared")) {
      try {
        entry.localResult = await this.local.execute(entry.input);
        entry.status = "pending";
      } catch (error) {
        if (!(error instanceof WorkspaceSyncError) || ![400, 404, 409, 423].includes(error.statusCode)) throw error;
        entry.status = "conflict"; entry.error = "local_" + error.code;
      }
      await this.save(entry);
    }
  }

  async updateBaseline(remote: HostCatalogState): Promise<void> {
    const blocked = await this.blockedNotebooks();
    const previous = await this.baseline();
    const notebooks = remote.notebooks.filter(item => !blocked.has(item.notebookId));
    notebooks.push(...(previous?.notebooks ?? []).filter(item => blocked.has(item.notebookId)));
    const trash = remote.trash.filter(item => !blocked.has(item.notebookId));
    trash.push(...(previous?.trash ?? []).filter(item => blocked.has(item.notebookId)));
    await atomicJSON(join(this.state, "catalog-baseline.json"), { version: 1, notebooks, trash });
  }
  baseline(): Promise<HostCatalogState | undefined> { return readJSON(join(this.state, "catalog-baseline.json")); }

  async forgetNotebook(notebookId: string): Promise<void> {
    const baseline = await this.baseline(); if (!baseline) return;
    baseline.notebooks = baseline.notebooks.filter(item => item.notebookId !== notebookId);
    baseline.trash = baseline.trash.filter(item => item.notebookId !== notebookId);
    await atomicJSON(join(this.state, "catalog-baseline.json"), baseline);
  }

  async createNotebook(title: string): Promise<NotebookSummary> {
    const notebookId = "notebook_" + randomUUID();
    const entry = await this.enqueue({ operationId: randomUUID(), action: "create_notebook", notebookId, title, baseRevision: null });
    const target = entry.localResult!.target;
    return { notebookId, title: target.title, sessionCount: 0,
      createdAt: String(target.metadata.createdAt), updatedAt: String(target.metadata.updatedAt) };
  }
  async createSession(notebookId: string, title: string): Promise<NotebookSessionSummary> {
    validateReplicaId(notebookId);
    await this.recoverLocal();
    if (!(await this.local.catalogState()).notebooks.some(item => item.notebookId === notebookId)) throw new WorkspaceSyncError("item_not_found", 404);
    const session = createSessionRecord({ id: "session_" + randomUUID(), title: title.trim(), createdAt: new Date().toISOString() });
    if (!session.title || title.length > 120) throw new WorkspaceSyncError("invalid_title", 400);
    const block = createBlockRef({ id: "0001", type: "markdown", path: "blocks/0001_user_note.md", source: "user", createdAt: session.createdAt });
    session.blocks.push(block);
    const snapshot: ReplicaSnapshot = { version: 1, notebookId, session, assets: [], revision: "",
      markdown: { [block.path]: "## 新 Session\n\n这里开始整理本次课堂、讨论或阅读笔记。\n" } };
    snapshot.revision = replicaRevision(snapshot);
    const entry = await this.enqueue({ operationId: randomUUID(), action: "create_session", notebookId,
      sessionId: session.id, snapshot, baseRevision: null });
    const stored = entry.localResult!.target.snapshot!.session;
    return { notebookId, sessionId: stored.id, title: stored.title, status: stored.status, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  }
  async manage(input: WorkspaceManageInput): Promise<void> {
    await this.recoverLocal();
    const state = await this.local.catalogState();
    const notebook = state.notebooks.find(item => item.notebookId === input.notebookId);
    const target = input.sessionId ? notebook?.sessions?.find(item => item.sessionId === input.sessionId) : notebook;
    const receipt = state.trash.find(item => item.id === input.deletionId);
    if (input.action === "restore") {
      if (target) throw new WorkspaceSyncError("restore_conflict", 409);
      if (!receipt || receipt.notebookId !== input.notebookId || receipt.sessionId !== input.sessionId) throw new WorkspaceSyncError("invalid_receipt", 400);
      if (input.sessionId && !notebook) throw new WorkspaceSyncError("item_not_found", 404);
    }
    const revision = input.action === "restore" ? receipt?.revision : target?.revision;
    if (!revision) throw new WorkspaceSyncError("item_not_found", 404);
    await this.enqueue({ operationId: randomUUID(), ...input, baseRevision: revision });
  }

  async flush(bridge: CatalogFlushBridge): Promise<void> {
    await this.recoverLocal();
    const blocked = new Set<string>();
    for (const entry of (await this.entries()).filter(active)) {
      if (blocked.has(entry.input.notebookId) || entry.status === "conflict") { blocked.add(entry.input.notebookId); continue; }
      const checkpoint = () => this.save(entry);
      try {
        if (!entry.remoteResult) {
          for (const dependency of entry.dependencies) {
            dependency.done ??= await bridge.syncDependency(dependency, checkpoint);
            await this.updateRemoteSession(dependency.done);
            await checkpoint();
          }
          entry.remoteRequest ??= await this.remoteRequest(entry);
          await checkpoint();
          entry.remoteResult = await bridge.send(entry.remoteRequest);
          if (entry.remoteResult.operationId !== entry.id || entry.remoteResult.target.notebookId !== entry.input.notebookId ||
              entry.remoteResult.target.sessionId !== entry.input.sessionId) throw new WorkspaceSyncError("invalid_catalog_result", 400);
          await checkpoint();
        }
        await bridge.acknowledge(entry);
        await this.updateRemoteResult(entry);
        entry.status = "applied"; entry.error = undefined; entry.remoteConflict = undefined;
        await checkpoint();
      } catch (error) {
        entry.error = error instanceof WorkspaceSyncError ? error.code : "connection_unavailable";
        entry.status = error instanceof WorkspaceSyncError && [400, 404, 409, 423].includes(error.statusCode) ? "conflict" : "pending";
        if (entry.status === "conflict") entry.remoteConflict = await bridge.readRemote().catch(() => entry.remoteConflict);
        await checkpoint(); blocked.add(entry.input.notebookId);
      }
    }
  }

  private async enqueue(input: CatalogOperation): Promise<ReplicaCatalogOperation> {
    validateReplicaId(input.notebookId);
    if (input.sessionId !== undefined) validateReplicaId(input.sessionId);
    if (["rename", "create_notebook"].includes(input.action) && (!input.title?.trim() || input.title.length > 120)) {
      throw new WorkspaceSyncError("invalid_title", 400);
    }
    await this.recoverLocal();
    if (!await this.baseline()) throw new WorkspaceSyncError("host_catalog_upgrade_required", 409);
    if ((await this.entries()).some(entry => active(entry) && entry.input.notebookId === input.notebookId && entry.status === "conflict")) {
      throw new WorkspaceSyncError("resolve_catalog_conflict_first", 409);
    }
    const dependencies: CatalogDependency[] = [];
    if (input.action === "rename" || input.action === "trash") {
      const notebook = (await this.local.catalogState()).notebooks.find(item => item.notebookId === input.notebookId);
      for (const session of notebook?.sessions ?? []) {
        if (input.sessionId && input.sessionId !== session.sessionId) continue;
        const directory = await safeReplicaPath(this.root, `notebooks/${input.notebookId}/sessions/${session.sessionId}`);
        const snapshot = await readReplicaSnapshotDirectory(directory, input.notebookId);
        await this.cacheSnapshot(snapshot);
        dependencies.push({ snapshot });
      }
    }
    const previous = await this.entries();
    const entry: ReplicaCatalogOperation = { version: 1, sequence: Math.max(0, ...previous.map(entry => entry.sequence)) + 1,
      id: input.operationId, input, status: "prepared", dependencies,
      title: input.title ?? input.snapshot?.session.title ?? input.sessionId ?? input.notebookId };
    // The intent is durable before a local directory can move/disappear.
    await this.save(entry);
    try { entry.localResult = await this.local.execute(input); }
    catch (error) {
      if (error instanceof WorkspaceSyncError && [400, 404, 409, 423].includes(error.statusCode)) {
        entry.status = "conflict"; entry.error = "local_" + error.code; await this.save(entry);
      }
      throw error;
    }
    entry.title = entry.localResult.target.title;
    entry.status = "pending";
    await this.save(entry);
    return entry;
  }

  async cacheSnapshot(snapshot: ReplicaSnapshot): Promise<void> {
    for (const asset of snapshot.assets) {
      const destination = join(this.state, "assets", asset.sha256);
      const cached = await readFile(destination).catch(() => undefined);
      if (cached && hash(cached) === asset.sha256) continue;
      const source = await safeReplicaPath(this.root, `notebooks/${snapshot.notebookId}/sessions/${snapshot.session.id}/${asset.path}`);
      const bytes = await readFile(source);
      if (hash(bytes) !== asset.sha256 || bytes.length !== asset.byteLength) throw new WorkspaceSyncError("asset_changed", 409);
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes, { mode: 0o600 });
    }
  }

  private async remoteRequest(entry: ReplicaCatalogOperation): Promise<CatalogOperation> {
    const baseline = await this.baseline();
    if (!baseline) throw new WorkspaceSyncError("catalog_baseline_missing", 409);
    const request = structuredClone(entry.input);
    if (request.action === "create_notebook" || request.action === "create_session") return request;
    const notebook = baseline.notebooks.find(item => item.notebookId === request.notebookId);
    const target = request.sessionId ? notebook?.sessions?.find(item => item.sessionId === request.sessionId) : notebook;
    request.baseRevision = request.action === "restore"
      ? baseline.trash.find(item => item.id === request.deletionId)?.revision ?? null : target?.revision ?? null;
    if (!request.baseRevision) throw new WorkspaceSyncError("catalog_baseline_missing", 409);
    return request;
  }

  async updateRemoteSession(snapshot: ReplicaSnapshot): Promise<void> {
    const baseline = await this.baseline(); if (!baseline) return;
    const notebook = baseline.notebooks.find(item => item.notebookId === snapshot.notebookId); if (!notebook) return;
    notebook.sessions = [...(notebook.sessions ?? []).filter(item => item.sessionId !== snapshot.session.id),
      { sessionId: snapshot.session.id, title: snapshot.session.title, revision: snapshot.revision }].sort((a, b) => a.sessionId < b.sessionId ? -1 : 1);
    notebook.revision = notebookRevision(notebook);
    await atomicJSON(join(this.state, "catalog-baseline.json"), baseline);
  }
  private async updateRemoteResult(entry: ReplicaCatalogOperation): Promise<void> {
    const baseline = await this.baseline(); if (!baseline) throw new WorkspaceSyncError("catalog_baseline_missing", 409);
    const { target, deletionId } = entry.remoteResult!;
    if (entry.input.action === "trash") {
      if (target.sessionId) {
        const notebook = baseline.notebooks.find(item => item.notebookId === target.notebookId);
        if (notebook) { notebook.sessions = notebook.sessions?.filter(item => item.sessionId !== target.sessionId); notebook.revision = notebookRevision(notebook); }
      } else baseline.notebooks = baseline.notebooks.filter(item => item.notebookId !== target.notebookId);
      baseline.trash = [...baseline.trash.filter(item => item.id !== deletionId), { notebookId: target.notebookId,
        sessionId: target.sessionId, id: deletionId!, title: target.title, deletedAt: new Date().toISOString(), revision: target.revision }];
    } else {
      if (entry.input.action === "restore") baseline.trash = baseline.trash.filter(item => item.id !== entry.input.deletionId);
      if (!target.sessionId) baseline.notebooks = [...baseline.notebooks.filter(item => item.notebookId !== target.notebookId), target];
      await atomicJSON(join(this.state, "catalog-baseline.json"), baseline);
      if (target.snapshot) await this.updateRemoteSession(target.snapshot);
      return;
    }
    await atomicJSON(join(this.state, "catalog-baseline.json"), baseline);
  }
  save(entry: ReplicaCatalogOperation): Promise<void> { return atomicJSON(join(this.state, "catalog-outbox", entry.id + ".json"), entry); }
}

function active(entry: ReplicaCatalogOperation): boolean { return !["applied", "cancelled"].includes(entry.status); }
function notebookRevision(target: CatalogTargetState): string { return hash(JSON.stringify([target.metadata, (target.sessions ?? []).map(item => [item.sessionId, item.revision])])); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function readJSON<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (missing(error)) return undefined; throw error; } }
async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path);
}

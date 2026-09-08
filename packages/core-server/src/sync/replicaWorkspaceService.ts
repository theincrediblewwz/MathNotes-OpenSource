import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NotesCatalog } from "../catalog/sessionCatalog";
import type { WorkspaceManageInput } from "../catalog/workspaceManagementService";
import { ReplicaCatalogOutbox, type CatalogDependency, type HostCatalogState, type ReplicaCatalogOperation, type ReplicaCatalogStatus } from "./replicaCatalogOutbox";
import type { CatalogOperationResult } from "./workspaceCatalogSyncService";
import { ReplicaCatalogResolution } from "./replicaCatalogResolution";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { replicaRevision, safeReplicaPath, validateReplicaId, validateReplicaSnapshot, WorkspaceSyncError,
  WorkspaceSyncService, type ReplicaPush, type ReplicaSnapshot } from "./workspaceSyncService";

export type ReplicaConnection = { origin: string; token: string; hostId: string };
export type ReplicaSessionStatus = { notebookId: string; sessionId: string; title: string;
  status: "synced" | "pending" | "conflict" | "error" | "host_deleted"; error?: string };
export type ReplicaSyncResult = { hostId: string; sessions: ReplicaSessionStatus[]; catalogOperations?: ReplicaCatalogStatus[]; catalogManagementAvailable?: boolean };
type SessionState = { base: ReplicaSnapshot; localRevision: string; pending?: ReplicaPush;
  catalogDeleted?: string;
  installation?: { remote: ReplicaSnapshot; expectedRevision: string; previousRevision?: string };
  conflict?: { remote: ReplicaSnapshot; local: ReplicaSnapshot; createdAt: string } };

/** One isolated notes root per host. Credentials are never persisted by this service. */
export class ReplicaWorkspaceService {
  private readonly local: WorkspaceSyncService;
  private readonly catalogOutbox: ReplicaCatalogOutbox;
  private readonly catalogResolution: ReplicaCatalogResolution;
  private flight?: Promise<ReplicaSyncResult>;
  constructor(private rootDir: string, private stateDir: string, private writes: SessionWriteCoordinator) {
    // Reuse the same reentrant workspace barrier as all replica mutations.
    this.local = new WorkspaceSyncService(rootDir, join(stateDir, "local-identity"), (n, s, op) => writes.run(n, s, op));
    this.catalogOutbox = new ReplicaCatalogOutbox(rootDir, stateDir);
    this.catalogResolution = new ReplicaCatalogResolution(rootDir, stateDir, this.catalogOutbox);
  }

  recover() { return this.writes.runWorkspace(async () => { await this.catalogResolution.recover(); await this.catalogOutbox.recoverLocal(); }); }
  createNotebook(title: string) { return this.writes.runWorkspace(async () => { await this.catalogResolution.recover(); return this.catalogOutbox.createNotebook(title); }); }
  createSession(notebookId: string, title: string) { return this.writes.runWorkspace(async () => { await this.catalogResolution.recover(); return this.catalogOutbox.createSession(notebookId, title); }); }
  manageWorkspace(input: WorkspaceManageInput): Promise<void> {
    return this.writes.runWorkspace(async () => {
      await this.catalogResolution.recover();
      // Retain assets referenced by an older persisted push before moving its directory.
      for (const state of await this.states()) {
        if (state.pending && state.base.notebookId === input.notebookId && (!input.sessionId || state.base.session.id === input.sessionId)) {
          await this.catalogOutbox.cacheSnapshot(state.pending.snapshot);
        }
      }
      await this.catalogOutbox.manage(input);
    });
  }

  sync(connection: ReplicaConnection): Promise<ReplicaSyncResult> {
    if (this.flight) return this.flight;
    this.flight = this.synchronize(connection).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  async status(): Promise<ReplicaSyncResult> {
    return this.writes.runWorkspace(async () => {
      await this.catalogResolution.recover();
      const binding = await readJSON<{ hostId: string }>(join(this.stateDir, "host.json"));
      const result = await readJSON<ReplicaSyncResult>(join(this.stateDir, "status.json")) ?? { hostId: binding?.hostId ?? "", sessions: [] };
      result.catalogOperations = await this.catalogOutbox.statuses();
      result.catalogManagementAvailable ??= Boolean(await this.catalogOutbox.baseline());
      const blocked = await this.catalogOutbox.blockedNotebooks();
      result.sessions = result.sessions.filter(item => !blocked.has(item.notebookId));
      for (const state of await this.states()) {
        if (state.catalogDeleted || blocked.has(state.base.notebookId)) continue;
        let status = result.sessions.find(item => item.notebookId === state.base.notebookId && item.sessionId === state.base.session.id);
        if (!status) {
          status = { notebookId: state.base.notebookId, sessionId: state.base.session.id, title: state.base.session.title, status: "synced" };
          result.sessions.push(status);
        }
        if (state.conflict) { status.status = "conflict"; continue; }
        try {
          const local = await this.local.snapshot(status.notebookId, status.sessionId);
          if (state.pending || local.revision !== state.localRevision) status.status = "pending";
        } catch { status.status = "error"; status.error = "local_replica_unavailable"; }
      }
      return result;
    });
  }

  async conflicts(): Promise<Array<{ notebookId: string; sessionId: string; title: string; conflict: NonNullable<SessionState["conflict"]> }>> {
    const states = await this.states();
    return states.filter(item => item.conflict).map(item => ({ notebookId: item.base.notebookId, sessionId: item.base.session.id,
      title: item.base.session.title, conflict: item.conflict! }));
  }

  catalogConflicts() {
    return this.writes.runWorkspace(async () => {
      await this.catalogResolution.recover();
      const entries = await this.catalogOutbox.entries();
      const baseline = await this.catalogOutbox.baseline();
      return entries.filter(entry => entry.status === "conflict").map(entry => {
        const remote = entry.remoteConflict?.notebooks.find(item => item.notebookId === entry.input.notebookId);
        const local = baseline?.notebooks.find(item => item.notebookId === entry.input.notebookId);
        return { id: entry.id, notebookId: entry.input.notebookId, title: entry.title, action: entry.input.action, error: entry.error,
          notebookTitle: local?.title ?? remote?.title ?? entry.input.notebookId,
          remoteTitle: entry.input.sessionId ? remote?.sessions?.find(item => item.sessionId === entry.input.sessionId)?.title : remote?.title,
          pendingCount: entries.filter(item => item.input.notebookId === entry.input.notebookId && !["applied", "cancelled"].includes(item.status)).length,
          localText: entry.dependencies.map(item => item.snapshot.session.title + "\n\n" +
            item.snapshot.session.blocks.filter(block => block.type === "markdown").map(block => item.snapshot.markdown[block.path]).join("\n\n")).join("\n\n——\n\n") };
      });
    });
  }

  resolveCatalog(input: { catalogOperationId: string; choice: "remote" }) {
    if (input.choice !== "remote") throw new WorkspaceSyncError("invalid_resolution", 400);
    return this.writes.runWorkspace(() => this.catalogResolution.useRemote(input.catalogOperationId));
  }

  async resolve(input: { notebookId: string; sessionId: string; choice: "local" | "remote" }): Promise<void> {
    validateReplicaId(input.notebookId); validateReplicaId(input.sessionId);
    await this.writes.runWorkspace(async () => {
      const state = await this.readState(input.notebookId, input.sessionId);
      if (!state?.conflict) throw new WorkspaceSyncError("conflict_not_found", 404);
      state.conflict.local = await this.local.snapshot(input.notebookId, input.sessionId);
      // Retain both versions even after the user resolves a conflict.
      await writeJSON(join(this.stateDir, "resolved", `${randomUUID()}.json`), state);
      if (input.choice === "local") {
        const current = await this.local.snapshot(input.notebookId, input.sessionId);
        state.base = state.conflict.remote;
        state.pending = { operationId: randomUUID(), baseRevision: state.base.revision, snapshot: current };
        state.conflict = undefined;
        await this.saveState(state);
      } else if (input.choice === "remote") {
        // Assets have already been downloaded to the content-addressed cache.
        const snapshot = state.conflict.remote;
        await this.commitInstall(snapshot, state, state.conflict.local.revision);
      } else throw new WorkspaceSyncError("invalid_resolution", 400);
    });
  }

  private async synchronize(connection: ReplicaConnection): Promise<ReplicaSyncResult> {
    validateReplicaId(connection.hostId);
    await this.recover();
    const identity = await remoteJSON<{ version: number; hostId: string; capabilities?: string[] }>(connection, "identity");
    if (identity.version !== 1 || identity.hostId !== connection.hostId) throw new WorkspaceSyncError("host_identity_changed", 409);
    await mkdir(this.rootDir, { recursive: true });
    const bindingPath = join(this.stateDir, "host.json");
    const binding = await readJSON<{ hostId: string }>(bindingPath);
    if (binding && binding.hostId !== connection.hostId) throw new WorkspaceSyncError("replica_host_mismatch", 409);
    await writeJSON(bindingPath, { hostId: connection.hostId });
    const supportsCatalog = identity.capabilities?.includes("catalog-operations-v1") ?? false;
    if (supportsCatalog) {
      await this.writes.runWorkspace(async () => {
        if (!await this.catalogOutbox.baseline()) await this.catalogOutbox.updateBaseline(await remoteJSON<HostCatalogState>(connection, "catalog-state"));
        await this.catalogOutbox.flush({
          syncDependency: (dependency, checkpoint) => this.syncCatalogDependency(connection, dependency, checkpoint),
          send: input => remoteJSON<CatalogOperationResult>(connection, "catalog-operation", input),
          readRemote: () => remoteJSON<HostCatalogState>(connection, "catalog-state"),
          acknowledge: entry => this.acknowledgeCatalog(connection, entry)
        });
      });
    }
    const blocked = await this.writes.runWorkspace(() => this.catalogOutbox.blockedNotebooks());
    // Keep the exact notebook metadata version that this pull installs. A later
    // catalog read must not silently authorize deleting changes we never showed.
    const catalogSnapshot = supportsCatalog ? await remoteJSON<HostCatalogState>(connection, "catalog-state") : undefined;
    const catalog = await remoteJSON<NotesCatalog>(connection, "catalog");
    if (!Array.isArray(catalog.notebooks)) throw new WorkspaceSyncError("invalid_catalog", 400);
    const result: ReplicaSyncResult = { hostId: connection.hostId, sessions: [], catalogManagementAvailable: supportsCatalog };
    const present = new Set<string>();
    for (const notebook of catalog.notebooks) {
      validateReplicaId(notebook.notebookId);
      if (typeof notebook.title !== "string" || !Array.isArray(notebook.sessions)) throw new WorkspaceSyncError("invalid_catalog", 400);
      if (blocked.has(notebook.notebookId)) continue;
      await this.writes.runWorkspace(async () => {
        if (!(await this.catalogOutbox.blockedNotebooks()).has(notebook.notebookId)) {
          await this.installNotebook(notebook, catalogSnapshot?.notebooks.find(item => item.notebookId === notebook.notebookId)?.metadata);
        }
      });
      for (const session of notebook.sessions) {
        validateReplicaId(session.sessionId);
        const status: ReplicaSessionStatus = { notebookId: notebook.notebookId, sessionId: session.sessionId, title: session.title, status: "synced" };
        present.add(`${status.notebookId}/${status.sessionId}`);
        try {
          // Fetch assets outside the edit barrier. A subsequent version check guards the push.
          let remote = await this.remoteSnapshot(connection, status.notebookId, status.sessionId);
          await this.cacheAssets(connection, remote);
          await this.writes.runWorkspace(async () => {
            // An offline directory command may have arrived during the HTTP read.
            if ((await this.catalogOutbox.blockedNotebooks()).has(status.notebookId)) { status.status = "pending"; return; }
            let state = await this.readState(status.notebookId, status.sessionId);
            if (!state) {
              // Never adopt/overwrite an unrelated local directory as a new remote replica.
              const path = join(this.rootDir, "notebooks", status.notebookId, "sessions", status.sessionId, "session.json");
              const existing = await readJSON<ReplicaSnapshot["session"] & { remoteCatalogOperations?: Record<string, string> }>(path);
              if (!existing) {
                await this.commitInstall(remote, { base: remote, localRevision: "" });
                return;
              }
              // Older clients could mark an unedited create as acknowledged
              // before writing its sync state. Recover only with both durable
              // operation evidence and the matching commit marker in this file.
              const creation = (await this.catalogOutbox.entries()).find(entry => {
                const saved = entry.localResult?.target.snapshot?.session as typeof existing | undefined;
                const proof = saved?.remoteCatalogOperations?.[entry.id];
                return entry.status === "applied" && entry.input.action === "create_session" &&
                  entry.input.notebookId === status.notebookId && entry.input.sessionId === status.sessionId &&
                  entry.remoteResult?.target.snapshot && typeof proof === "string" &&
                  existing.id === status.sessionId && existing.remoteCatalogOperations?.[entry.id] === proof;
              });
              if (!creation) throw new WorkspaceSyncError("replica_untracked_session", 409);
              await this.acknowledgeCatalog(connection, creation);
              state = await this.readState(status.notebookId, status.sessionId);
              if (!state) throw new WorkspaceSyncError("replica_untracked_session", 409);
            }
            if (state.installation) {
              let current: ReplicaSnapshot | undefined;
              try { current = await this.local.snapshot(status.notebookId, status.sessionId); }
              catch (error) { if (!(error instanceof WorkspaceSyncError && error.code === "item_not_found")) throw error; }
              const installation = state.installation;
              if (current?.revision === installation.expectedRevision) {
                await this.saveState({ base: installation.remote, localRevision: installation.expectedRevision });
              } else if (current?.revision === installation.previousRevision) {
                await this.commitInstall(installation.remote, state, current?.revision);
              } else if (current) {
                state.conflict = { remote, local: current, createdAt: new Date().toISOString() };
                state.installation = undefined;
                await this.saveState(state);
              } else throw new WorkspaceSyncError("replica_install_incomplete", 409);
              state = (await this.readState(status.notebookId, status.sessionId))!;
            }
            const local = await this.local.snapshot(status.notebookId, status.sessionId);
            if (state.conflict) { status.status = "conflict"; return; }
            if (state.pending || local.revision !== state.localRevision) {
              // The exact request is durable before sending, including its operation id.
              state.pending ??= { operationId: randomUUID(), baseRevision: state.base.revision, snapshot: local };
              await this.saveState(state);
              try {
                await this.uploadAssets(connection, state.pending);
                remote = await remoteJSON<ReplicaSnapshot>(connection, "push", state.pending);
                validateReplicaSnapshot(remote);
                if (remote.notebookId !== status.notebookId || remote.session.id !== status.sessionId || replicaRevision(remote) !== remote.revision) throw new WorkspaceSyncError("invalid_snapshot", 400);
                if (!sameReplicaContent(remote, state.pending.snapshot)) throw new WorkspaceSyncError("replayed_push_changed_remotely", 409);
                await this.cacheAssets(connection, remote);
                if (local.revision !== state.pending.snapshot.revision) {
                  // More edits arrived after the persisted request (e.g. while offline).
                  state.base = remote;
                  state.pending = { operationId: randomUUID(), baseRevision: remote.revision, snapshot: local };
                  await this.saveState(state);
                  status.status = "pending";
                  return;
                }
              } catch (error) {
                if (error instanceof WorkspaceSyncError && [409, 423].includes(error.statusCode)) {
                  const latest = await this.remoteSnapshot(connection, status.notebookId, status.sessionId);
                  await this.cacheAssets(connection, latest);
                  state.conflict = { remote: latest, local, createdAt: new Date().toISOString() };
                  await this.saveState(state);
                  status.status = "conflict";
                } else {
                  status.status = "pending";
                  status.error = error instanceof WorkspaceSyncError ? error.code : "connection_unavailable";
                }
                return;
              }
            }
            if (local.revision === state.localRevision && remote.revision === state.base.revision && !state.pending) return;
            await this.commitInstall(remote, state, local.revision);
          });
        } catch (error) {
          status.status = "error";
          status.error = error instanceof WorkspaceSyncError ? error.code : "connection_unavailable";
        }
        result.sessions.push(status);
      }
    }
    for (const state of await this.states()) {
      if (state.catalogDeleted || (await this.catalogOutbox.blockedNotebooks()).has(state.base.notebookId)) continue;
      if (!present.has(`${state.base.notebookId}/${state.base.session.id}`)) result.sessions.push({ notebookId: state.base.notebookId,
        sessionId: state.base.session.id, title: state.base.session.title, status: "host_deleted" });
    }
    await this.writes.runWorkspace(async () => {
      if (catalogSnapshot) {
        const states = await this.states();
        for (const notebook of catalogSnapshot.notebooks) {
          // Only versions actually adopted by the replica may become a mutation
          // baseline. Failed downloads and unresolved conflicts stay conservative.
          notebook.sessions = states.filter(state => !state.catalogDeleted && state.base.notebookId === notebook.notebookId)
            .map(state => ({ sessionId: state.base.session.id, title: state.base.session.title, revision: state.base.revision }))
            .sort((a, b) => a.sessionId < b.sessionId ? -1 : 1);
          notebook.revision = digest(Buffer.from(JSON.stringify([notebook.metadata, notebook.sessions.map(item => [item.sessionId, item.revision])])));
        }
        await this.catalogOutbox.updateBaseline(catalogSnapshot);
      }
      result.catalogOperations = await this.catalogOutbox.statuses();
    });
    await writeJSON(join(this.stateDir, "status.json"), result);
    return result;
  }

  private async syncCatalogDependency(connection: ReplicaConnection, dependency: CatalogDependency, checkpoint: () => Promise<void>): Promise<ReplicaSnapshot> {
    const captured = dependency.snapshot;
    const state = await this.readState(captured.notebookId, captured.session.id);
    if (!state) throw new WorkspaceSyncError("replica_untracked_session", 409);
    if (state.conflict) throw new WorkspaceSyncError("resolve_content_conflict_first", 409);
    if (!dependency.request && !state.pending && captured.revision === state.localRevision) return state.base;
    for (;;) {
      dependency.request ??= state.pending ?? { operationId: randomUUID(), baseRevision: state.base.revision, snapshot: captured };
      await checkpoint();
      const request = dependency.request;
      await this.uploadAssets(connection, request);
      const remote = await remoteJSON<ReplicaSnapshot>(connection, "push", request);
      validateReplicaSnapshot(remote);
      if (remote.notebookId !== captured.notebookId || remote.session.id !== captured.session.id || replicaRevision(remote) !== remote.revision) {
        throw new WorkspaceSyncError("invalid_snapshot", 400);
      }
      if (!sameReplicaContent(remote, request.snapshot)) throw new WorkspaceSyncError("replayed_push_changed_remotely", 409);
      await this.cacheAssets(connection, remote);
      state.base = remote; state.pending = undefined;
      state.localRevision = request.snapshot.revision;
      await this.saveState(state);
      if (request.snapshot.revision === captured.revision) return remote;
      dependency.request = { operationId: randomUUID(), baseRevision: remote.revision, snapshot: captured };
      await checkpoint();
    }
  }

  private async acknowledgeCatalog(connection: ReplicaConnection, entry: ReplicaCatalogOperation): Promise<void> {
    const target = entry.remoteResult!.target;
    if (entry.input.action === "trash") {
      for (const state of await this.states()) {
        if (state.base.notebookId === target.notebookId && (!target.sessionId || target.sessionId === state.base.session.id)) {
          state.catalogDeleted = entry.remoteResult!.deletionId;
          await this.saveState(state);
        }
      }
      return;
    }
    if (target.snapshot) {
      const remote = target.snapshot;
      validateReplicaSnapshot(remote);
      if (replicaRevision(remote) !== remote.revision || remote.notebookId !== target.notebookId || remote.session.id !== target.sessionId) {
        throw new WorkspaceSyncError("invalid_snapshot", 400);
      }
      const localResult = entry.localResult?.target.snapshot;
      if (!localResult || !sameReplicaContent(localResult, remote)) throw new WorkspaceSyncError("catalog_content_changed", 409);
      await this.cacheAssets(connection, remote);
      const later = (await this.catalogOutbox.entries()).some(item => item.sequence > entry.sequence &&
        !["applied", "cancelled"].includes(item.status) && item.input.notebookId === target.notebookId);
      let current: ReplicaSnapshot | undefined;
      if (!later) current = await this.local.snapshot(target.notebookId, target.sessionId!);
      const savedState = await this.readState(target.notebookId, target.sessionId!);
      const state = savedState ?? { base: remote, localRevision: localResult.revision };
      // If acknowledgement was already installed before a crash, do not turn the
      // host's canonical metadata into another local edit on the replay.
      if (savedState && !state.pending && !state.conflict && state.base.revision === remote.revision && current?.revision === state.localRevision) return;
      if (current?.revision === localResult.revision) await this.commitInstall(remote, state, current.revision);
      else await this.saveState({ ...state, base: remote, localRevision: localResult.revision, pending: undefined, catalogDeleted: undefined });
    } else if (entry.input.action === "restore") {
      for (const child of target.sessions ?? []) {
        const state = await this.readState(target.notebookId, child.sessionId);
        if (!state || state.base.revision !== child.revision) throw new WorkspaceSyncError("catalog_content_changed", 409);
        state.catalogDeleted = undefined; await this.saveState(state);
      }
    }
  }

  private async remoteSnapshot(connection: ReplicaConnection, notebookId: string, sessionId: string): Promise<ReplicaSnapshot> {
    const snapshot = await remoteJSON<ReplicaSnapshot>(connection, `snapshot?${new URLSearchParams({ notebookId, sessionId })}`);
    validateReplicaSnapshot(snapshot);
    if (snapshot.notebookId !== notebookId || snapshot.session.id !== sessionId || replicaRevision(snapshot) !== snapshot.revision) throw new WorkspaceSyncError("invalid_snapshot", 400);
    return snapshot;
  }
  private async cacheAssets(connection: ReplicaConnection, snapshot: ReplicaSnapshot): Promise<void> {
    for (const asset of snapshot.assets) {
      const path = join(this.stateDir, "assets", asset.sha256);
      const cached = await readFile(path).catch(() => undefined);
      if (cached && digest(cached) === asset.sha256) continue;
      const response = await remoteFetch(connection, `asset?${new URLSearchParams({ notebookId: snapshot.notebookId, sessionId: snapshot.session.id,
        path: asset.path, sha256: asset.sha256 })}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== asset.byteLength || digest(bytes) !== asset.sha256) throw new WorkspaceSyncError("asset_hash_mismatch", 400);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
    }
  }
  private async uploadAssets(connection: ReplicaConnection, input: ReplicaPush): Promise<void> {
    for (const asset of input.snapshot.assets) {
      let bytes = await readFile(join(this.stateDir, "assets", asset.sha256)).catch(() => undefined);
      if (!bytes || digest(bytes) !== asset.sha256) bytes = await readFile(await safeReplicaPath(this.rootDir, `notebooks/${input.snapshot.notebookId}/sessions/${input.snapshot.session.id}/${asset.path}`));
      if (digest(bytes) !== asset.sha256 || bytes.length !== asset.byteLength) throw new WorkspaceSyncError("asset_changed", 409);
      await mkdir(join(this.stateDir, "assets"), { recursive: true });
      await writeFile(join(this.stateDir, "assets", asset.sha256), bytes, { mode: 0o600 });
      await remoteJSON(connection, "asset", { operationId: input.operationId, sha256: asset.sha256, base64: bytes.toString("base64") });
    }
  }
  private async installNotebook(notebook: { notebookId: string; title: string; createdAt: string; updatedAt: string }, metadata?: Record<string, unknown>): Promise<void> {
    const directory = await safeReplicaPath(this.rootDir, `notebooks/${notebook.notebookId}`, true);
    await mkdir(join(directory, "sessions"), { recursive: true });
    const previous = await readJSON<Record<string, unknown>>(join(directory, "notebook.json"));
    await writeJSON(join(directory, "notebook.json"), metadata ?? { ...previous,
      id: notebook.notebookId, title: notebook.title, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt });
  }
  private async commitInstall(snapshot: ReplicaSnapshot, state: SessionState, previousRevision?: string): Promise<void> {
    const materialized = structuredClone(snapshot);
    const markdown: Record<string, string> = {};
    for (const block of materialized.session.blocks) {
      if (block.type !== "markdown") continue;
      const text = snapshot.markdown[block.path];
      block.path = materializedMarkdownPath(block.id, text);
      markdown[block.path] = text;
    }
    materialized.markdown = markdown;
    const expectedRevision = replicaRevision(materialized);
    await this.saveState({ ...state, installation: { remote: snapshot, expectedRevision, previousRevision } });
    await this.install(snapshot);
    const actual = await this.local.snapshot(snapshot.notebookId, snapshot.session.id);
    if (actual.revision !== expectedRevision) throw new WorkspaceSyncError("replica_install_mismatch", 409);
    await this.saveState({ base: snapshot, localRevision: actual.revision });
  }
  private async install(snapshot: ReplicaSnapshot): Promise<void> {
    validateReplicaSnapshot(snapshot);
    const directory = await safeReplicaPath(this.rootDir, `notebooks/${snapshot.notebookId}/sessions/${snapshot.session.id}`, true);
    await mkdir(join(directory, "blocks"), { recursive: true });
    const next = structuredClone(snapshot.session);
    for (const asset of snapshot.assets) {
      const bytes = await readFile(join(this.stateDir, "assets", asset.sha256));
      if (digest(bytes) !== asset.sha256) throw new WorkspaceSyncError("asset_hash_mismatch", 400);
      const target = await safeReplicaPath(directory, asset.path, true);
      await mkdir(dirname(target), { recursive: true });
      // Retain overwritten asset versions in the content-addressed cache.
      const previous = await readFile(target).catch(() => undefined);
      if (previous) await writeFile(join(this.stateDir, "assets", digest(previous)), previous, { mode: 0o600 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes); await rename(temporary, target);
    }
    for (const block of next.blocks) {
      if (block.type !== "markdown") continue;
      const markdown = snapshot.markdown[block.path];
      block.path = materializedMarkdownPath(block.id, markdown);
      const target = await safeReplicaPath(directory, block.path, true);
      await writeFile(target, markdown, { encoding: "utf8", flag: "wx" }).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(target, "utf8") !== markdown) throw error;
      });
    }
    await writeJSON(join(directory, "session.json"), next);
  }
  private statePath(notebookId: string, sessionId: string): string {
    validateReplicaId(notebookId); validateReplicaId(sessionId);
    return join(this.stateDir, "sessions", digest(Buffer.from(`${notebookId}/${sessionId}`)) + ".json");
  }
  private readState(notebookId: string, sessionId: string) { return readJSON<SessionState>(this.statePath(notebookId, sessionId)); }
  private saveState(state: SessionState) { return writeJSON(this.statePath(state.base.notebookId, state.base.session.id), state); }
  private async states(): Promise<SessionState[]> {
    const directory = join(this.stateDir, "sessions");
    const names = await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    const result: SessionState[] = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const state = await readJSON<SessionState>(join(directory, name)); if (state) result.push(state);
    }
    return result;
  }
}
async function remoteFetch(connection: ReplicaConnection, path: string, body?: unknown): Promise<Response> {
  const origin = new URL(connection.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new WorkspaceSyncError("invalid_origin", 400);
  const response = await fetch(new URL(`/api/v3/workspace/${path}`, origin), { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new WorkspaceSyncError(error.error ?? (response.status === 404 ? "host_upgrade_required" : "remote_request_failed"), response.status);
  }
  return response;
}
async function remoteJSON<T>(connection: ReplicaConnection, path: string, body?: unknown): Promise<T> {
  return (await remoteFetch(connection, path, body)).json() as Promise<T>;
}
async function readJSON<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function writeJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function materializedMarkdownPath(id: string, text: string): string {
  return `blocks/replica_${digest(Buffer.from(id + "\0" + text)).slice(0, 40)}.md`;
}

/** Push responses can replay a previously committed operation after subsequent
 * host edits. Only server-owned timestamps, storage paths and ledgers may differ. */
function sameReplicaContent(a: ReplicaSnapshot, b: ReplicaSnapshot): boolean {
  function normalized(snapshot: ReplicaSnapshot): unknown {
    const { updatedAt, createdAt, remoteSyncOperations, remoteCatalogOperations, blocks, ...session } = snapshot.session as
      ReplicaSnapshot["session"] & { remoteSyncOperations?: unknown; remoteCatalogOperations?: unknown };
    return { notebookId: snapshot.notebookId, session: { ...session, blocks: blocks.map(block => {
      const { updatedAt, path, ...rest } = block;
      return { ...rest, content: block.type === "markdown" ? snapshot.markdown[path] : path };
    }) }, assets: [...snapshot.assets].sort((a, b) => a.path.localeCompare(b.path)) };
  }
  return stableJSON(normalized(a)) === stableJSON(normalized(b));
}
function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJSON).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => JSON.stringify(key) + ":" + stableJSON(value)).join(",") + "}";
  return JSON.stringify(value);
}

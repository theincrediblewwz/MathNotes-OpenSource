import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { readReplicaSnapshotDirectory, replicaRevision, safeReplicaPath, validateReplicaId,
  validateReplicaSnapshot, atomicWrite, boundedRead, WorkspaceSyncError, type ReplicaSnapshot } from "./workspaceSyncService";

export type CatalogTarget = { notebookId: string; sessionId?: string };
export type CatalogTargetState = CatalogTarget & { revision: string; title: string; metadata: Record<string, unknown>;
  snapshot?: ReplicaSnapshot; sessions?: Array<{ sessionId: string; title: string; revision: string }> };
export type CatalogOperation = CatalogTarget & { operationId: string;
  action: "create_notebook" | "create_session" | "rename" | "trash" | "restore";
  baseRevision: string | null; title?: string; snapshot?: ReplicaSnapshot; deletionId?: string };
export type CatalogOperationResult = { version: 1; operationId: string; target: CatalogTargetState; deletionId?: string };
type Journal = { input: CatalogOperation; requestHash: string; phase: "prepared" | "applied";
  preparedAt: string; result: CatalogOperationResult; nextMetadata?: Record<string, unknown> };
type Receipt = CatalogTarget & { id: string; title: string; deletedAt: string; catalogOperationId?: string;
  requestHash?: string; committedAt?: string };
export type WorkspaceCatalogSyncOptions = {
  /** Test hooks at the publication boundary; never called for an already applied retry. */
  beforeCommit?: (input: CatalogOperation) => Promise<void>;
  afterCommit?: (input: CatalogOperation) => Promise<void>;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;

/** Trusted-host directory mutations share the SAME workspace barrier as note edits.
 * Prepared requests and immutable result snapshots make retries recoverable. */
export class WorkspaceCatalogSyncService {
  private readonly appliedJournals = new Set<string>();
  private readonly journalDirectory: string;
  constructor(private rootDir: string, private stateDir: string, private writes: SessionWriteCoordinator,
    private options: WorkspaceCatalogSyncOptions = {}) {
    this.rootDir = resolve(rootDir); this.stateDir = resolve(stateDir);
    // userData survives switching the selected notes folder. A receipt from a
    // different library must never authorize or suppress a mutation here.
    const rootIdentity = process.platform === "win32" ? this.rootDir.toLowerCase() : this.rootDir;
    this.journalDirectory = `catalog-operations/${hash(rootIdentity)}`;
  }

  recover(): Promise<void> { return this.writes.runWorkspace(() => this.recoverCommitted()); }

  catalogState(): Promise<{ version: 1; notebooks: CatalogTargetState[]; trash: Array<Receipt & { revision: string }> }> {
    return this.writes.runWorkspace(async () => {
      await this.recoverCommitted();
      const notebooks: CatalogTargetState[] = [];
      const root = await checkedPath(this.rootDir, "notebooks", true);
      const entries = await readdir(root, { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error; });
      for (const item of entries) {
        if (item.isSymbolicLink()) throw new WorkspaceSyncError("unsafe_path", 400);
        if (!item.isDirectory()) continue;
        validateReplicaId(item.name);
        notebooks.push(await this.readTarget({ notebookId: item.name }));
      }
      const trash: Array<Receipt & { revision: string }> = [];
      for (const { receipt, directory } of await this.receipts()) {
        if (receipt.catalogOperationId && !receipt.committedAt) continue;
        const payload = await this.existingPath(join(directory, "payload"));
        if (payload) trash.push({ ...receipt, revision: (await this.readTarget(receipt, payload)).revision });
      }
      return { version: 1, notebooks, trash };
    });
  }

  async execute(input: CatalogOperation): Promise<CatalogOperationResult> {
    this.validateOperation(input);
    // Capture before joining the barrier: the caller cannot change a queued
    // request after its ID, fingerprint, or paths have been validated.
    const requestHash = hash(JSON.stringify(input));
    input = structuredClone(input);
    return this.writes.runWorkspace(async () => {
      await this.recoverCommitted();
      const file = await this.journalPath(input.operationId);
      let journal = await readJSON<Journal>(file);
      if (journal && journal.requestHash !== requestHash) throw new WorkspaceSyncError("operation_reused", 409);
      if (journal?.phase === "applied") return journal.result;
      if (!journal) {
        journal = await this.prepare(input, requestHash);
        await atomicJSON(file, journal);
      }
      // Re-check preconditions after an interrupted preparation. Never replay an
      // old intent over another operation's replacement of the same object ID.
      await this.checkPrecondition(input, journal.result.target);
      await this.apply(journal);
      await this.options.afterCommit?.(structuredClone(input));
      await this.finish(journal);
      return journal.result;
    });
  }

  private async prepare(input: CatalogOperation, requestHash: string): Promise<Journal> {
    const before = await this.checkPrecondition(input);
    const preparedAt = new Date().toISOString();
    const target = { notebookId: input.notebookId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    let metadata = before?.metadata ?? { id: input.notebookId, createdAt: preparedAt };
    let snapshot = before?.snapshot;
    if (input.action === "create_session") {
      validateReplicaSnapshot(input.snapshot!);
      if (input.snapshot!.notebookId !== input.notebookId || input.snapshot!.session.id !== input.sessionId) throw new WorkspaceSyncError("invalid_snapshot", 400);
      snapshot = structuredClone(input.snapshot!);
      metadata = snapshot.session as unknown as Record<string, unknown>;
      // Ledger ownership belongs to this host. A newly imported note has never
      // committed a remote operation here, even when the client supplies one.
      delete metadata.remoteCatalogOperations;
      delete metadata.remoteSyncOperations;
    }
    const operations = isRecord(metadata.remoteCatalogOperations) ? metadata.remoteCatalogOperations : {};
    const nextMetadata = input.action === "trash" ? undefined : { ...metadata,
      ...(input.action === "rename" || input.action === "create_notebook" ? { title: this.title(input.title) } : {}),
      updatedAt: preparedAt,
      remoteCatalogOperations: { ...Object.fromEntries(Object.entries(operations).slice(-255)), [input.operationId]: requestHash } };
    let after: CatalogTargetState;
    if (input.action === "trash") after = before!;
    else if (snapshot) {
      snapshot = structuredClone(snapshot);
      snapshot.session = nextMetadata as unknown as ReplicaSnapshot["session"];
      snapshot.revision = replicaRevision(snapshot);
      after = { ...target, title: snapshot.session.title, metadata: nextMetadata!, revision: snapshot.revision, snapshot };
    } else {
      const sessions = before?.sessions ?? [];
      after = { ...target, title: nextMetadata!.title as string, metadata: nextMetadata!, sessions,
        revision: notebookRevision(nextMetadata!, sessions) };
    }
    return { input, requestHash, phase: "prepared", preparedAt, nextMetadata,
      result: { version: 1, operationId: input.operationId, target: after,
        ...(input.action === "trash" ? { deletionId: input.operationId } : {}) } };
  }

  private async checkPrecondition(input: CatalogOperation, prepared?: CatalogTargetState): Promise<CatalogTargetState | undefined> {
    if (input.action === "restore") {
      const directory = await checkedPath(this.rootDir, `.mathnotes-trash/${input.deletionId}`);
      const receipt = await readJSON<Receipt>(await checkedPath(directory, "receipt.json", true));
      if (!receipt || receipt.id !== input.deletionId || receipt.notebookId !== input.notebookId || receipt.sessionId !== input.sessionId) throw new WorkspaceSyncError("invalid_receipt", 400);
      if (receipt.catalogOperationId && !receipt.committedAt) throw new WorkspaceSyncError("invalid_receipt", 400);
      const state = await this.readTarget(input, await checkedPath(directory, "payload"));
      if (state.revision !== input.baseRevision && state.revision !== prepared?.revision) throw new WorkspaceSyncError("revision_conflict", 409);
      if (await this.existingPath(this.targetPath(input))) throw new WorkspaceSyncError("restore_conflict", 409);
      await this.parentDirectory(input);
      return state;
    }
    const current = await this.existingPath(this.targetPath(input));
    if (input.action === "create_notebook" || input.action === "create_session") {
      if (input.baseRevision !== null || current) throw new WorkspaceSyncError("workspace_conflict", 409);
      if (input.sessionId) await this.parentDirectory(input);
      return undefined;
    }
    if (!current) throw new WorkspaceSyncError("item_not_found", 404);
    const state = await this.readTarget(input);
    if (state.revision !== input.baseRevision) throw new WorkspaceSyncError("revision_conflict", 409);
    return state;
  }

  private async apply(journal: Journal): Promise<void> {
    const { input } = journal;
    const targetPath = await checkedPath(this.rootDir, this.relativeTarget(input), true);
    if (input.action === "create_notebook" || input.action === "create_session") {
      // Same-volume rename is required even when notes live on an external disk.
      const stage = await checkedPath(this.rootDir, `.mathnotes-catalog-stage/${input.operationId}`, true);
      await mkdir(stage, { recursive: true });
      if (input.action === "create_notebook") await mkdir(await checkedPath(stage, "sessions", true), { recursive: true });
      else {
        const snapshot = journal.result.target.snapshot!;
        for (const asset of snapshot.assets) {
          let source: string;
          try { source = await checkedPath(this.stateDir, `incoming/${input.operationId}/${asset.sha256}`); }
          catch (error) { if (missing(error) || error instanceof WorkspaceSyncError && error.code === "item_not_found") throw new WorkspaceSyncError("asset_not_staged", 409); throw error; }
          const info = await lstat(source);
          if (!info.isFile() || info.size !== asset.byteLength) throw new WorkspaceSyncError("asset_hash_mismatch", 400);
          const bytes = await boundedRead(source);
          if (hash(bytes) !== asset.sha256 || bytes.length !== asset.byteLength) throw new WorkspaceSyncError("asset_hash_mismatch", 400);
          const destination = await checkedPath(stage, asset.path, true);
          await mkdir(dirname(destination), { recursive: true }); await atomicWrite(destination, bytes);
        }
        for (const block of snapshot.session.blocks) {
          if (block.type !== "markdown") continue;
          const destination = await checkedPath(stage, block.path, true);
          await mkdir(dirname(destination), { recursive: true }); await atomicWrite(destination, Buffer.from(snapshot.markdown[block.path], "utf8"));
        }
      }
      await atomicJSON(await checkedPath(stage, input.sessionId ? "session.json" : "notebook.json", true), journal.nextMetadata);
      if (input.sessionId && (await readReplicaSnapshotDirectory(stage, input.notebookId)).revision !== journal.result.target.revision) {
        throw new WorkspaceSyncError("invalid_snapshot", 400);
      }
      await assertTreeHasNoLinks(stage);
      await this.options.beforeCommit?.(structuredClone(input));
      await mkdir(dirname(targetPath), { recursive: true });
      await renameWithRetry(stage, targetPath);
    } else if (input.action === "rename") {
      await this.options.beforeCommit?.(structuredClone(input));
      await atomicJSON(await checkedPath(targetPath, input.sessionId ? "session.json" : "notebook.json", true), journal.nextMetadata);
    } else if (input.action === "trash") {
      const directory = await checkedPath(this.rootDir, `.mathnotes-trash/${input.operationId}`, true);
      await mkdir(directory, { recursive: true });
      await atomicJSON(await checkedPath(directory, "receipt.json", true), { notebookId: input.notebookId, sessionId: input.sessionId,
        id: input.operationId, title: journal.result.target.title, deletedAt: journal.preparedAt,
        catalogOperationId: input.operationId, requestHash: journal.requestHash });
      await this.options.beforeCommit?.(structuredClone(input));
      await renameWithRetry(targetPath, await checkedPath(directory, "payload", true));
    } else {
      const payload = await checkedPath(this.rootDir, `.mathnotes-trash/${input.deletionId}/payload`);
      await this.options.beforeCommit?.(structuredClone(input));
      await atomicJSON(await checkedPath(payload, input.sessionId ? "session.json" : "notebook.json", true), journal.nextMetadata);
      await mkdir(dirname(targetPath), { recursive: true });
      await renameWithRetry(payload, targetPath);
    }
  }

  private async finish(journal: Journal): Promise<void> {
    if (journal.input.action === "trash") {
      const file = await checkedPath(this.rootDir, `.mathnotes-trash/${journal.input.operationId}/receipt.json`);
      const receipt = await readJSON<Receipt>(file);
      if (receipt && !receipt.committedAt) await atomicJSON(file, { ...receipt, committedAt: journal.preparedAt });
    }
    await atomicJSON(await this.journalPath(journal.input.operationId), { ...journal, phase: "applied" });
    this.appliedJournals.add(journal.input.operationId);
  }

  private async recoverCommitted(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const directory = await checkedPath(this.stateDir, this.journalDirectory, true);
    const names = await readdir(directory).catch(error => { if (missing(error)) return []; throw error; });
    for (const name of names.filter(name => name.endsWith(".json") && UUID.test(name.slice(0, -5)))) {
      if (this.appliedJournals.has(name.slice(0, -5))) continue;
      const journal = await readJSON<Journal>(await checkedPath(directory, name));
      if (!journal) continue;
      if (journal.phase === "applied") { this.appliedJournals.add(name.slice(0, -5)); continue; }
      const { input } = journal;
      this.validateOperation(input);
      if (input.operationId !== name.slice(0, -5) || hash(JSON.stringify(input)) !== journal.requestHash) throw new WorkspaceSyncError("invalid_catalog_journal", 500);
      if (input.action === "trash") {
        const directory = await checkedPath(this.rootDir, `.mathnotes-trash/${input.operationId}`, true);
        const receipt = await readJSON<Receipt>(await checkedPath(this.rootDir, `.mathnotes-trash/${input.operationId}/receipt.json`, true));
        if (receipt?.requestHash === journal.requestHash && (receipt.committedAt || await this.existingPath(join(directory, "payload")))) await this.finish(journal);
        continue;
      }
      const candidates = [this.targetPath(input)];
      for (const { receipt, directory } of await this.receipts()) {
        // Restore prepares the manifest inside its source trash directory before
        // moving it; that source is not evidence that the move committed.
        if (input.action === "restore" && receipt.id === input.deletionId) continue;
        if (receipt.notebookId !== input.notebookId) continue;
        if (receipt.sessionId === input.sessionId) candidates.push(join(directory, "payload"));
        else if (!receipt.sessionId && input.sessionId) candidates.push(join(directory, "payload", "sessions", input.sessionId));
      }
      for (const candidate of candidates) {
        if (!await this.existingPath(candidate)) continue;
        const metadata = await readJSON<Record<string, unknown>>(await checkedPath(candidate, input.sessionId ? "session.json" : "notebook.json", true));
        if ((metadata?.remoteCatalogOperations as Record<string, string> | undefined)?.[input.operationId] === journal.requestHash) {
          await this.finish(journal); break;
        }
      }
    }
  }

  private async readTarget(target: CatalogTarget, overridePath?: string): Promise<CatalogTargetState> {
    validateReplicaId(target.notebookId); if (target.sessionId !== undefined) validateReplicaId(target.sessionId);
    const directory = overridePath ?? await checkedPath(this.rootDir, this.relativeTarget(target));
    if (target.sessionId) {
      const snapshot = await readReplicaSnapshotDirectory(directory, target.notebookId);
      if (snapshot.session.id !== target.sessionId) throw new WorkspaceSyncError("invalid_snapshot", 400);
      return { ...target, title: snapshot.session.title, revision: snapshot.revision,
        metadata: snapshot.session as unknown as Record<string, unknown>, snapshot };
    }
    const metadata = await readJSON<Record<string, unknown>>(await checkedPath(directory, "notebook.json", true)) ?? { id: target.notebookId, title: target.notebookId };
    if (!isRecord(metadata) || metadata.id !== target.notebookId || typeof metadata.title !== "string") throw new WorkspaceSyncError("invalid_notebook", 422);
    const sessionDir = await checkedPath(directory, "sessions", true);
    const entries = await readdir(sessionDir, { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error; });
    if (entries.some(item => item.isSymbolicLink())) throw new WorkspaceSyncError("unsafe_path", 400);
    const names = entries.filter(item => item.isDirectory()).map(item => item.name).sort();
    const sessions = [];
    for (const sessionId of names) {
      validateReplicaId(sessionId);
      const snapshot = await readReplicaSnapshotDirectory(await checkedPath(sessionDir, sessionId), target.notebookId);
      if (snapshot.session.id !== sessionId) throw new WorkspaceSyncError("invalid_snapshot", 400);
      sessions.push({ sessionId, title: snapshot.session.title, revision: snapshot.revision });
    }
    return { ...target, title: String(metadata.title), metadata, sessions, revision: notebookRevision(metadata, sessions) };
  }

  private async receipts(): Promise<Array<{ receipt: Receipt; directory: string }>> {
    const root = await checkedPath(this.rootDir, ".mathnotes-trash", true);
    const names = await readdir(root).catch(error => { if (missing(error)) return []; throw error; });
    const result = [];
    for (const id of names.filter(id => UUID.test(id))) {
      const directory = await checkedPath(root, id);
      const receipt = await readJSON<Receipt>(await checkedPath(directory, "receipt.json", true));
      if (receipt && receipt.id === id) {
        validateReplicaId(receipt.notebookId); if (receipt.sessionId) validateReplicaId(receipt.sessionId);
        result.push({ receipt, directory });
      }
    }
    return result;
  }
  private async existingPath(path: string): Promise<string | undefined> {
    const rel = relative(this.rootDir, path).split(/[\\/]/).join("/");
    try { const checked = await checkedPath(this.rootDir, rel); await lstat(checked); return checked; }
    catch (error) { if (error instanceof WorkspaceSyncError && error.code === "item_not_found") return undefined; throw error; }
  }
  private relativeTarget(target: CatalogTarget): string { return `notebooks/${target.notebookId}${target.sessionId ? `/sessions/${target.sessionId}` : ""}`; }
  private targetPath(target: CatalogTarget): string { return join(this.rootDir, ...this.relativeTarget(target).split("/")); }
  private journalPath(id: string): Promise<string> { return checkedPath(this.stateDir, `${this.journalDirectory}/${id}.json`, true); }
  private async parentDirectory(input: CatalogTarget): Promise<void> {
    const parent = await checkedPath(this.rootDir, input.sessionId ? `notebooks/${input.notebookId}` : "notebooks");
    if (!(await lstat(parent)).isDirectory()) throw new WorkspaceSyncError("item_not_found", 404);
    if (input.sessionId) {
      const sessions = await checkedPath(parent, "sessions", true);
      try { if (!(await lstat(sessions)).isDirectory()) throw new WorkspaceSyncError("unsafe_path", 400); }
      catch (error) { if (!missing(error)) throw error; }
    }
  }
  private title(value?: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new WorkspaceSyncError("invalid_title", 400);
    return value.trim();
  }
  private validateOperation(input: CatalogOperation): void {
    if (!isRecord(input) || typeof input.operationId !== "string" || !UUID.test(input.operationId) || !["create_notebook", "create_session", "rename", "trash", "restore"].includes(input.action)) throw new WorkspaceSyncError("invalid_operation", 400);
    validateReplicaId(input.notebookId); if (input.sessionId !== undefined) validateReplicaId(input.sessionId);
    if ((input.action === "create_session" && !input.sessionId) || (input.action === "create_notebook" && input.sessionId)) throw new WorkspaceSyncError("invalid_target", 400);
    if (input.action === "restore" && (typeof input.deletionId !== "string" || !UUID.test(input.deletionId))) throw new WorkspaceSyncError("invalid_receipt", 400);
    if (input.action === "create_notebook" || input.action === "create_session") {
      if (input.baseRevision !== null) throw new WorkspaceSyncError("invalid_revision", 400);
    } else if (typeof input.baseRevision !== "string" || !HASH.test(input.baseRevision)) throw new WorkspaceSyncError("invalid_revision", 400);
    if (input.action === "create_notebook" || input.action === "rename") this.title(input.title);
    if (input.action === "create_session") {
      validateReplicaSnapshot(input.snapshot!);
      if (input.snapshot!.notebookId !== input.notebookId || input.snapshot!.session.id !== input.sessionId) throw new WorkspaceSyncError("invalid_snapshot", 400);
      this.title(input.snapshot!.session.title);
    }
  }
}
function notebookRevision(metadata: Record<string, unknown>, sessions: Array<{ sessionId: string; revision: string }>): string {
  return hash(JSON.stringify([metadata, sessions.map(item => [item.sessionId, item.revision])]));
}
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function readJSON<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (missing(error)) return undefined; throw error; } }
async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWrite(path, Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8"));
}
async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (attempt >= 7 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 35 * (attempt + 1)));
    }
  }
}
async function checkedPath(root: string, path: string, allowMissing = false): Promise<string> {
  const result = await safeReplicaPath(root, path, allowMissing);
  // NTFS silently aliases spelling. Stable protocol IDs and storage paths must
  // use the actual directory-entry casing instead of creating another identity.
  if (process.platform === "win32") {
    let parent = root;
    for (const part of path.split("/")) {
      const names: string[] = await readdir(parent).catch(error => { if (missing(error) && allowMissing) return [] as string[]; throw error; });
      if (!names.includes(part) && names.some(name => name.toLowerCase() === part.toLowerCase())) throw new WorkspaceSyncError("noncanonical_id", 400);
      parent = join(parent, part);
    }
  }
  return result;
}
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function assertTreeHasNoLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new WorkspaceSyncError("unsafe_path", 400);
    if (entry.isDirectory()) await assertTreeHasNoLinks(await checkedPath(directory, entry.name));
  }
}

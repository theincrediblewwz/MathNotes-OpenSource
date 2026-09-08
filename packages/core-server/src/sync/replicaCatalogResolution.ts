import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceManagementService } from "../catalog/workspaceManagementService";
import { ReplicaCatalogOutbox, type ReplicaCatalogOperation } from "./replicaCatalogOutbox";
import { safeReplicaPath, WorkspaceSyncError } from "./workspaceSyncService";

export type CatalogResolutionResult = { notebookId: string; backupRelativePath: string };
type Resolution = CatalogResolutionResult & { version: 1; id: string; phase: "prepared" | "applied";
  createdAt: string; notebookPresent: boolean; trashIds: string[]; operations: ReplicaCatalogOperation[] };

/** Runs only under the replica workspace barrier, including startup recovery.
 * Choosing the host version archives the entire local notebook, its trash, and
 * its synchronization records before cancelling this notebook's queued actions. */
export class ReplicaCatalogResolution {
  constructor(private root: string, private state: string, private outbox: ReplicaCatalogOutbox) {}

  async recover(): Promise<void> {
    const names = await readdir(join(this.state, "catalog-resolutions")).catch(error => { if (missing(error)) return []; throw error; });
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const entry: Resolution = JSON.parse(await readFile(join(this.state, "catalog-resolutions", name), "utf8"));
      if (entry.phase === "prepared") await this.apply(entry);
    }
  }

  async useRemote(operationId: string): Promise<CatalogResolutionResult> {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new WorkspaceSyncError("invalid_operation", 400);
    await this.recover();
    const file = join(this.state, "catalog-resolutions", operationId + ".json");
    const previous = await readFile(file, "utf8").catch(error => { if (missing(error)) return undefined; throw error; });
    if (previous) return result(JSON.parse(previous));
    const entries = await this.outbox.entries();
    const conflict = entries.find(entry => entry.id === operationId && entry.status === "conflict");
    if (!conflict) throw new WorkspaceSyncError("conflict_not_found", 404);
    const notebookId = conflict.input.notebookId;
    const source = await safeReplicaPath(this.root, `notebooks/${notebookId}`, true);
    const trash = await new WorkspaceManagementService(this.root).listTrash();
    const resolution: Resolution = { version: 1, id: operationId, phase: "prepared", notebookId,
      createdAt: new Date().toISOString(), backupRelativePath: `.mathnotes-replica-backups/${operationId}`,
      notebookPresent: await exists(source), trashIds: trash.filter(item => item.notebookId === notebookId).map(item => item.id),
      operations: entries.filter(entry => entry.input.notebookId === notebookId && !["applied", "cancelled"].includes(entry.status)) };
    await atomicJSON(file, resolution);
    await this.apply(resolution);
    return result(resolution);
  }

  private async apply(resolution: Resolution): Promise<void> {
    const backup = await safeReplicaPath(this.root, resolution.backupRelativePath, true);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await atomicJSON(join(backup, "recovery.json"), resolution);
    if (resolution.notebookPresent) {
      await this.move(`notebooks/${resolution.notebookId}`, `${resolution.backupRelativePath}/notebook`);
    }
    for (const id of resolution.trashIds) {
      await this.move(`.mathnotes-trash/${id}`, `${resolution.backupRelativePath}/trash/${id}`);
    }
    // State can live on another volume. Copy each record durably before unlinking
    // its active index; the note directories above only use same-volume moves.
    const statesDirectory = join(this.state, "sessions");
    const names = await readdir(statesDirectory).catch(error => { if (missing(error)) return []; throw error; });
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const path = join(statesDirectory, name);
      const bytes = await readFile(path);
      if (JSON.parse(bytes.toString("utf8")).base?.notebookId !== resolution.notebookId) continue;
      const hash = createHash("sha256").update(bytes).digest("hex");
      const archived = join(backup, "sync-state", hash + ".json");
      await mkdir(dirname(archived), { recursive: true });
      await writeFile(archived, bytes, { mode: 0o600 });
      await unlink(path);
    }
    for (const entry of resolution.operations) {
      await this.outbox.save({ ...entry, status: "cancelled" });
    }
    await this.outbox.forgetNotebook(resolution.notebookId);
    const statusPath = join(this.state, "status.json");
    const statusText = await readFile(statusPath, "utf8").catch(error => { if (missing(error)) return undefined; throw error; });
    if (statusText) {
      const status = JSON.parse(statusText);
      status.sessions = status.sessions.filter((item: { notebookId: string }) => item.notebookId !== resolution.notebookId);
      await atomicJSON(statusPath, status);
    }
    resolution.phase = "applied";
    await atomicJSON(join(this.state, "catalog-resolutions", resolution.id + ".json"), resolution);
    await atomicJSON(join(backup, "recovery.json"), resolution);
  }

  private async move(sourcePath: string, destinationPath: string): Promise<void> {
    const source = await safeReplicaPath(this.root, sourcePath, true);
    const destination = await safeReplicaPath(this.root, destinationPath, true);
    const sourceExists = await exists(source), destinationExists = await exists(destination);
    if (sourceExists && destinationExists) throw new WorkspaceSyncError("backup_path_conflict", 409);
    if (!sourceExists && !destinationExists) throw new WorkspaceSyncError("backup_source_missing", 409);
    if (!sourceExists) return; // A previous attempt already committed this move.
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  }
}
function result(entry: Resolution): CatalogResolutionResult { return { notebookId: entry.notebookId, backupRelativePath: entry.backupRelativePath }; }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path);
}

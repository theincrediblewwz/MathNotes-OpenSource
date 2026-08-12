import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { applySyncOperation, createManifest, createReplicaState } from "./engine";
import type { ApplyResult, ConflictMaterial, JournalEntry, SyncManifest, SyncOperation, SyncReplicaState } from "./types";

export type ReconcileSummary = {
  accepted: number;
  replayed: number;
  conflicts: number;
  rejected: number;
};

export class FileSyncReplica {
  private state: SyncReplicaState;
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly rootDir: string, state: SyncReplicaState) {
    this.state = state;
  }

  static async open(rootDir: string, replicaId: string, sessionId: string): Promise<FileSyncReplica> {
    await mkdir(rootDir, { recursive: true });
    const target = join(rootDir, "sync-state.json");
    let state: SyncReplicaState;
    try {
      state = JSON.parse(await readFile(target, "utf8")) as SyncReplicaState;
      if (state.schemaVersion !== 3 || state.replicaId !== replicaId || state.sessionId !== sessionId) {
        throw new Error("SYNC_REPLICA_IDENTITY_MISMATCH");
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      state = createReplicaState(replicaId, sessionId);
      await writeJsonAtomic(target, state);
    }
    return new FileSyncReplica(rootDir, state);
  }

  async apply(operation: SyncOperation): Promise<ApplyResult> {
    let result: ApplyResult | undefined;
    await this.enqueue(async () => {
      const applied = applySyncOperation(this.state, operation);
      if (applied.conflictMaterial) await this.writeConflict(applied.conflictMaterial);
      this.state = applied.state;
      await writeJsonAtomic(join(this.rootDir, "sync-state.json"), this.state);
      result = applied.result;
    });
    if (!result) throw new Error("SYNC_OPERATION_DID_NOT_COMPLETE");
    return result;
  }

  getManifest(): SyncManifest {
    return createManifest(this.state);
  }

  getState(): SyncReplicaState {
    return structuredClone(this.state);
  }

  exportJournal(): JournalEntry[] {
    return structuredClone(this.state.journal);
  }

  async reconcileFrom(remote: FileSyncReplica): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { accepted: 0, replayed: 0, conflicts: 0, rejected: 0 };
    for (const entry of remote.exportJournal()) {
      const result = await this.apply(entry.operation);
      if (result.replayed) summary.replayed += 1;
      else if (result.status === "accepted") summary.accepted += 1;
      else if (result.status === "conflict") summary.conflicts += 1;
      else summary.rejected += 1;
    }
    return summary;
  }

  private async writeConflict(material: ConflictMaterial): Promise<void> {
    const currentPath = join(this.rootDir, material.record.currentContentPath);
    const incomingPath = join(this.rootDir, material.record.incomingContentPath);
    await mkdir(dirname(currentPath), { recursive: true });
    await writeFile(currentPath, material.currentContent, "utf8");
    await writeFile(incomingPath, material.incomingContent, "utf8");
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.operationQueue.then(work, work);
    this.operationQueue = next.catch(() => undefined);
    await next;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

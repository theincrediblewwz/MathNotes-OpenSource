import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";

export type WorkspaceTarget = { notebookId: string; sessionId?: string };
export type WorkspaceTrashEntry = WorkspaceTarget & { id: string; title: string; deletedAt: string };
export type WorkspaceManageInput = WorkspaceTarget & {
  action: "rename" | "trash" | "restore";
  title?: string;
  deletionId?: string;
};
export class WorkspaceManagementError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}

/** Moves complete directories on the same volume; never permanently deletes notes. */
export class WorkspaceManagementService {
  constructor(private rootDir: string, private writes = new SessionWriteCoordinator()) {}

  manage(input: WorkspaceManageInput): Promise<void> {
    return this.writes.runWorkspace(async () => {
      validateId(input.notebookId);
      if (input.sessionId !== undefined) validateId(input.sessionId);
      if (input.action === "restore") return this.restore(input);
      const parts = targetParts(input);
      await this.checkedPath(parts);
      if (input.action === "rename") {
        const title = input.title?.trim();
        if (!title || title.length > 120) throw new WorkspaceManagementError("invalid_title", 400);
        const fileParts = [...parts, input.sessionId ? "session.json" : "notebook.json"];
        let metadata: Record<string, unknown>;
        try { metadata = JSON.parse(await readFile(await this.checkedPath(fileParts), "utf8")); }
        catch (error) {
          if (!input.sessionId && error instanceof WorkspaceManagementError && error.statusCode === 404) {
            metadata = { id: input.notebookId, createdAt: new Date().toISOString() };
          } else throw error;
        }
        await atomicJSON(join(this.rootDir, ...fileParts), { ...metadata, title, updatedAt: new Date().toISOString() });
      } else if (input.action === "trash") {
        const titleFile = join(await this.checkedPath([...parts, input.sessionId ? "session.json" : "notebook.json"], !input.sessionId));
        let title = input.sessionId ?? input.notebookId;
        try { title = JSON.parse(await readFile(titleFile, "utf8")).title || title; }
        catch (error) { if (!isMissing(error)) throw error; }
        const entry: WorkspaceTrashEntry = { ...input, id: randomUUID(), title, deletedAt: new Date().toISOString() };
        const trashRoot = await this.checkedPath([".mathnotes-trash"], true);
        await mkdir(trashRoot, { recursive: true });
        const directory = join(trashRoot, entry.id);
        await mkdir(directory);
        // Persist the recovery receipt before the atomic move. Incomplete receipts are ignored.
        await atomicJSON(join(directory, "receipt.json"), entry);
        await rename(await this.checkedPath(parts), join(directory, "payload"));
      } else throw new WorkspaceManagementError("invalid_action", 400);
    });
  }

  async listTrash(): Promise<WorkspaceTrashEntry[]> {
    const root = await this.checkedPath([".mathnotes-trash"], true);
    const entries = await readdir(root, { withFileTypes: true }).catch(error => {
      if (isMissing(error)) return [];
      throw error;
    });
    const result: WorkspaceTrashEntry[] = [];
    for (const item of entries) {
      if (!item.isDirectory()) continue;
      try { result.push(await this.readReceipt(item.name)); }
      catch (error) {
        if (error instanceof WorkspaceManagementError || error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  private async readReceipt(id: string): Promise<WorkspaceTrashEntry> {
    validateId(id);
    const parts = [".mathnotes-trash", id];
    await this.checkedPath([...parts, "payload"]);
    const receipt = JSON.parse(await readFile(await this.checkedPath([...parts, "receipt.json"]), "utf8"));
    if (receipt.catalogOperationId && !receipt.committedAt) throw new WorkspaceManagementError("incomplete_receipt", 409);
    validateId(receipt.notebookId);
    if (receipt.sessionId !== undefined) validateId(receipt.sessionId);
    if (receipt.id !== id || typeof receipt.title !== "string" || typeof receipt.deletedAt !== "string") {
      throw new WorkspaceManagementError("invalid_receipt", 400);
    }
    return receipt;
  }

  private async restore(input: WorkspaceManageInput): Promise<void> {
    const receipt = await this.readReceipt(input.deletionId ?? "");
    if (receipt.notebookId !== input.notebookId || receipt.sessionId !== input.sessionId) {
      throw new WorkspaceManagementError("invalid_receipt", 400);
    }
    const parts = targetParts(receipt);
    await this.checkedPath(parts.slice(0, -1));
    const destination = await this.checkedPath(parts, true);
    try {
      await lstat(destination);
      throw new WorkspaceManagementError("restore_conflict", 409);
    } catch (error) { if (!isMissing(error)) throw error; }
    await rename(await this.checkedPath([".mathnotes-trash", receipt.id, "payload"]), destination);
    // Keep the receipt for diagnostics. No payload remains, so it is no longer listed.
  }

  private async checkedPath(parts: string[], allowMissingLast = false): Promise<string> {
    let path = this.rootDir;
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      try {
        if ((await lstat(path)).isSymbolicLink()) throw new WorkspaceManagementError("unsafe_path", 400);
      } catch (error) {
        if (isMissing(error)) {
          if (allowMissingLast && i === parts.length - 1) return path;
          throw new WorkspaceManagementError("workspace_item_not_found", 404);
        }
        throw error;
      }
    }
    return path;
  }
}
function targetParts(input: WorkspaceTarget): string[] {
  return ["notebooks", input.notebookId, ...(input.sessionId ? ["sessions", input.sessionId] : [])];
}
function validateId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new WorkspaceManagementError("invalid_id", 400);
  }
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
async function atomicJSON(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

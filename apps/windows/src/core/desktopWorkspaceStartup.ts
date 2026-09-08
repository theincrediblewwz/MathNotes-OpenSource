import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readNotesCatalog, readWorkspaceContext } from "@mathnotes/core-server";
import type { SessionDocument } from "../common/sessionDocument";
import type { BlockStore } from "./blockStore";

/** Welcome notes belong only to a new workspace. A deleted workspace stays empty. */
export async function initializeDesktopWorkspace(args: {
  store: BlockStore;
  recoverCatalog: () => Promise<void>;
  createWelcome: () => Promise<void>;
}): Promise<void> {
  const rootDir = args.store.getRootDir();
  await mkdir(rootDir, { recursive: true });
  await args.store.getWriteCoordinator().runWorkspace(async () => {
    // Recover a committed trash/restore before deciding whether this root is new.
    await args.recoverCatalog();
    const catalog = await readNotesCatalog({ rootDir });
    const marker = join(rootDir, ".mathnotes", "desktop-initialized.json");
    const evidence = await Promise.all([
      marker, join(rootDir, ".mathnotes", "active-context.json"),
      join(rootDir, ".mathnotes-trash"), join(rootDir, "notebooks")
    ].map(pathExists));
    if (!catalog.notebooks.length && !evidence.some(Boolean)) await args.createWelcome();
    await mkdir(join(rootDir, ".mathnotes"), { recursive: true });
    try { await writeFile(marker, '{"version":1}\n', { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  });
}

export async function selectDesktopWorkspace(store: BlockStore): Promise<{ notebookId: string; sessionId: string }> {
  const rootDir = store.getRootDir();
  const catalog = await readNotesCatalog({ rootDir });
  const saved = await readWorkspaceContext(rootDir);
  const sessions = catalog.notebooks.flatMap(notebook => notebook.sessions);
  const target = saved && sessions.find(session => session.notebookId === saved.notebookId && session.sessionId === saved.sessionId)
    || sessions[0];
  return target ? { notebookId: target.notebookId, sessionId: target.sessionId }
    : { notebookId: catalog.notebooks[0]?.notebookId ?? "", sessionId: "" };
}

export function emptyDesktopSessionDocument(notebookId = ""): SessionDocument {
  return { notebookId, sessionId: "", title: "尚未打开笔记", sourceLines: [], renderBlocks: [], editableBlocks: [],
    sourceDocument: { text: "", markdownBlocks: [] } };
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

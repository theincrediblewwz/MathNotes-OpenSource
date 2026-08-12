import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord } from "@mathnotes/shared";

export type NotebookSessionSummary = {
  notebookId: string;
  sessionId: string;
  title: string;
  status: SessionRecord["status"];
  createdAt: string;
  updatedAt: string;
};

export type NotebookSummary = {
  notebookId: string;
  title: string;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type NotebookCatalogEntry = NotebookSummary & {
  sessions: NotebookSessionSummary[];
};

export type NotesCatalog = {
  notebooks: NotebookCatalogEntry[];
};

type NotebookMetadata = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export async function readNotesCatalog(args: { rootDir: string }): Promise<NotesCatalog> {
  const notebooks = await listNotebooks(args);
  return {
    notebooks: await Promise.all(notebooks.map(async (notebook) => ({
      ...notebook,
      sessions: await listNotebookSessions({ rootDir: args.rootDir, notebookId: notebook.notebookId })
    })))
  };
}

export async function listNotebooks(args: { rootDir: string }): Promise<NotebookSummary[]> {
  const notebooksDir = join(args.rootDir, "notebooks");
  let entries;
  try {
    entries = await readdir(notebooksDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const notebooks: NotebookSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessions = await listNotebookSessions({ rootDir: args.rootDir, notebookId: entry.name });
    const metadata = await readNotebookMetadata(args.rootDir, entry.name);
    const newestSession = sessions[0];
    notebooks.push({
      notebookId: entry.name,
      title: metadata?.title || entry.name,
      sessionCount: sessions.length,
      createdAt: metadata?.createdAt || sessions.at(-1)?.createdAt || "",
      updatedAt: [metadata?.updatedAt, newestSession?.updatedAt].filter(Boolean).sort().at(-1) || ""
    });
  }

  return notebooks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createNotebook(args: {
  rootDir: string;
  notebookId: string;
  title: string;
  now: string;
}): Promise<NotebookSummary> {
  const notebookDir = join(args.rootDir, "notebooks", args.notebookId);
  await mkdir(join(notebookDir, "sessions"), { recursive: true });
  const metadata: NotebookMetadata = {
    id: args.notebookId,
    title: args.title.trim() || "未命名笔记本",
    createdAt: args.now,
    updatedAt: args.now
  };
  await writeJsonAtomically(join(notebookDir, "notebook.json"), metadata);
  return { notebookId: metadata.id, title: metadata.title, sessionCount: 0, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt };
}

export async function listNotebookSessions(args: {
  rootDir: string;
  notebookId: string;
}): Promise<NotebookSessionSummary[]> {
  const sessionsDir = join(args.rootDir, "notebooks", args.notebookId, "sessions");
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const sessions: NotebookSessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const session = JSON.parse(await readFile(join(sessionsDir, entry.name, "session.json"), "utf8")) as SessionRecord;
      sessions.push({
        notebookId: args.notebookId,
        sessionId: session.id,
        title: session.title,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      });
    } catch {
      continue;
    }
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function renameSessionTitle(args: {
  rootDir: string;
  notebookId: string;
  sessionId: string;
  title: string;
  now: string;
}): Promise<NotebookSessionSummary> {
  const target = join(args.rootDir, "notebooks", args.notebookId, "sessions", args.sessionId, "session.json");
  const session = JSON.parse(await readFile(target, "utf8")) as SessionRecord;
  session.title = args.title.trim() || "未命名";
  session.updatedAt = args.now;
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return {
    notebookId: args.notebookId,
    sessionId: session.id,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

export async function deleteNotebookSession(args: {
  rootDir: string;
  notebookId: string;
  sessionId: string;
}): Promise<NotebookSessionSummary[]> {
  await rm(join(args.rootDir, "notebooks", args.notebookId, "sessions", args.sessionId), {
    recursive: true,
    force: false
  });
  return listNotebookSessions({ rootDir: args.rootDir, notebookId: args.notebookId });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readNotebookMetadata(rootDir: string, notebookId: string): Promise<NotebookMetadata | null> {
  try {
    return JSON.parse(await readFile(join(rootDir, "notebooks", notebookId, "notebook.json"), "utf8")) as NotebookMetadata;
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

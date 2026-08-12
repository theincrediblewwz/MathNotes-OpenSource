import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBlockRef,
  createSessionRecord,
  type SessionRecord
} from "@mathnotes/shared";
import {
  createNotebook,
  type NotebookSessionSummary,
  type NotebookSummary
} from "./sessionCatalog";

const INITIAL_MARKDOWN = `## 新 Session

这里开始整理本次课堂、讨论或阅读笔记。
`;

export class WorkspaceCommandError extends Error {
  constructor(
    readonly code: "invalid_title" | "notebook_not_found" | "workspace_conflict",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

export async function createWorkspaceNotebook(args: {
  rootDir: string;
  title: string;
  now?: string;
}): Promise<NotebookSummary> {
  const title = requiredTitle(args.title);
  const now = args.now ?? new Date().toISOString();
  const notebookId = await uniqueId({
    parentDir: join(args.rootDir, "notebooks"),
    title,
    fallback: "notebook"
  });
  return createNotebook({ rootDir: args.rootDir, notebookId, title, now });
}

export async function createWorkspaceSession(args: {
  rootDir: string;
  notebookId: string;
  title: string;
  now?: string;
}): Promise<NotebookSessionSummary> {
  const title = requiredTitle(args.title);
  const now = args.now ?? new Date().toISOString();
  const notebookDir = join(args.rootDir, "notebooks", args.notebookId);
  if (!await exists(notebookDir)) {
    throw new WorkspaceCommandError("notebook_not_found", "Notebook does not exist");
  }

  const sessionsDir = join(notebookDir, "sessions");
  const sessionId = await uniqueId({
    parentDir: sessionsDir,
    title,
    fallback: "session"
  });
  const sessionDir = join(sessionsDir, sessionId);
  await Promise.all([
    mkdir(join(sessionDir, "blocks"), { recursive: true }),
    mkdir(join(sessionDir, "assets", "photos"), { recursive: true }),
    mkdir(join(sessionDir, "assets", "embedded"), { recursive: true }),
    mkdir(join(sessionDir, "assets", "pdfs"), { recursive: true }),
    mkdir(join(sessionDir, "assets", "pdf-pages"), { recursive: true }),
    mkdir(join(sessionDir, "exports"), { recursive: true }),
    mkdir(join(sessionDir, "logs"), { recursive: true })
  ]);

  const session = createSessionRecord({ id: sessionId, title, createdAt: now });
  const block = createBlockRef({
    id: "0001",
    type: "markdown",
    path: "blocks/0001_user_note.md",
    source: "user",
    createdAt: now
  });
  session.blocks.push(block);

  await writeFile(join(sessionDir, block.path), INITIAL_MARKDOWN, "utf8");
  await writeSessionAtomically(join(sessionDir, "session.json"), session);
  await touchNotebookMetadata(args.rootDir, args.notebookId, now);

  return {
    notebookId: args.notebookId,
    sessionId,
    title,
    status: session.status,
    createdAt: now,
    updatedAt: now
  };
}

function requiredTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new WorkspaceCommandError("invalid_title", "Title is required");
  if (title.length > 120) throw new WorkspaceCommandError("invalid_title", "Title is too long");
  return title;
}

async function uniqueId(args: {
  parentDir: string;
  title: string;
  fallback: string;
}): Promise<string> {
  await mkdir(args.parentDir, { recursive: true });
  const slug = args.title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || args.fallback;
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
    const candidate = `${timestamp}_${slug}_${suffix}`;
    if (!await exists(join(args.parentDir, candidate))) return candidate;
  }
  throw new WorkspaceCommandError("workspace_conflict", "Unable to allocate a unique workspace id");
}

async function touchNotebookMetadata(rootDir: string, notebookId: string, now: string): Promise<void> {
  const target = join(rootDir, "notebooks", notebookId, "notebook.json");
  try {
    const metadata = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    metadata.updatedAt = now;
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function writeSessionAtomically(target: string, session: SessionRecord): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

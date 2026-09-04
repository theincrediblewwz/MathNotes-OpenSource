import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readNotesCatalog, type NotebookSessionSummary } from "./sessionCatalog";

export const recentReadingHistoryLimit = 24;

export type RecentSessionSummary = NotebookSessionSummary & {
  notebookTitle: string;
  openedAt: string;
};

type RecentReadingEntry = {
  notebookId: string;
  sessionId: string;
  openedAt: string;
};

type RecentReadingFile = {
  version: 1;
  entries: RecentReadingEntry[];
};

export async function recordRecentSession(input: {
  userDataDir: string;
  notebookId: string;
  sessionId: string;
  openedAt?: string;
}): Promise<void> {
  const notebookId = input.notebookId.trim();
  const sessionId = input.sessionId.trim();
  if (!notebookId || !sessionId) return;
  const current = await readRecentReadingFile(input.userDataDir);
  const key = recentSessionKey(notebookId, sessionId);
  const next: RecentReadingFile = {
    version: 1,
    entries: [
      {
        notebookId,
        sessionId,
        openedAt: normalizeTimestamp(input.openedAt) ?? new Date().toISOString()
      },
      ...current.entries.filter((entry) => recentSessionKey(entry.notebookId, entry.sessionId) !== key)
    ].slice(0, recentReadingHistoryLimit)
  };
  await writeRecentReadingFile(input.userDataDir, next);
}

export async function listRecentSessions(input: {
  userDataDir: string;
  rootDir: string;
  limit?: number;
}): Promise<RecentSessionSummary[]> {
  const [stored, catalog] = await Promise.all([
    readRecentReadingFile(input.userDataDir),
    readNotesCatalog({ rootDir: input.rootDir })
  ]);
  const live = new Map<string, RecentSessionSummary>();
  for (const notebook of catalog.notebooks) {
    for (const session of notebook.sessions) {
      live.set(recentSessionKey(notebook.notebookId, session.sessionId), {
        ...session,
        notebookTitle: notebook.title,
        openedAt: ""
      });
    }
  }
  const cleaned = stored.entries.filter((entry) => live.has(recentSessionKey(entry.notebookId, entry.sessionId)));
  if (cleaned.length !== stored.entries.length) {
    await writeRecentReadingFile(input.userDataDir, { version: 1, entries: cleaned });
  }
  const limit = Math.max(1, Math.min(recentReadingHistoryLimit, Math.floor(input.limit ?? recentReadingHistoryLimit)));
  return cleaned.slice(0, limit).map((entry) => ({
    ...live.get(recentSessionKey(entry.notebookId, entry.sessionId))!,
    openedAt: entry.openedAt
  }));
}

function recentReadingPath(userDataDir: string): string {
  return join(userDataDir, "recent-reading.v1.json");
}

async function readRecentReadingFile(userDataDir: string): Promise<RecentReadingFile> {
  try {
    const parsed = JSON.parse(await readFile(recentReadingPath(userDataDir), "utf8")) as unknown;
    if (!isRecentReadingFile(parsed)) return emptyRecentReadingFile();
    const seen = new Set<string>();
    return {
      version: 1,
      entries: parsed.entries.filter((entry) => {
        const key = recentSessionKey(entry.notebookId, entry.sessionId);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, recentReadingHistoryLimit)
    };
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return emptyRecentReadingFile();
    throw error;
  }
}

async function writeRecentReadingFile(userDataDir: string, value: RecentReadingFile): Promise<void> {
  const target = recentReadingPath(userDataDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isRecentReadingFile(value: unknown): value is RecentReadingFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecentReadingFile>;
  return candidate.version === 1 && Array.isArray(candidate.entries) && candidate.entries.every((entry) => (
    Boolean(entry) &&
    typeof entry.notebookId === "string" && entry.notebookId.length > 0 && entry.notebookId.length <= 240 &&
    typeof entry.sessionId === "string" && entry.sessionId.length > 0 && entry.sessionId.length <= 240 &&
    typeof entry.openedAt === "string" && Boolean(normalizeTimestamp(entry.openedAt))
  ));
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function recentSessionKey(notebookId: string, sessionId: string): string {
  return `${notebookId}\u0000${sessionId}`;
}

function emptyRecentReadingFile(): RecentReadingFile {
  return { version: 1, entries: [] };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

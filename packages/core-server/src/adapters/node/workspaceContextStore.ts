import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type WorkspaceContext = {
  notebookId: string;
  sessionId: string;
};

export async function readWorkspaceContext(rootDir: string): Promise<WorkspaceContext | null> {
  try {
    const parsed = JSON.parse(await readFile(contextPath(rootDir), "utf8")) as Partial<WorkspaceContext>;
    if (!parsed.notebookId?.trim() || !parsed.sessionId?.trim()) return null;
    return { notebookId: parsed.notebookId, sessionId: parsed.sessionId };
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeWorkspaceContext(rootDir: string, context: WorkspaceContext): Promise<void> {
  const target = contextPath(rootDir);
  const temporary = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function contextPath(rootDir: string): string {
  return join(rootDir, ".mathnotes", "active-context.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

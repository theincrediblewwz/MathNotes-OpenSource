import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BlockStore } from "../apps/windows/src/core/blockStore";
import { buildCompanionSessionSnapshot } from "../apps/windows/src/core/companionReadService";

type SessionDiagnostic = {
  notebookId: string;
  sessionId: string;
  ok: boolean;
  durationMs: number;
  markdownBytes?: number;
  htmlBytes?: number;
  assetCount?: number;
  error?: string;
};

async function directoryNames(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function main(): Promise<void> {
  const rootDir = process.argv[2];
  if (!rootDir) throw new Error("Usage: companion_snapshot_diagnostic.ts <notes-root>");
  const store = new BlockStore(rootDir);
  const diagnostics: SessionDiagnostic[] = [];

  for (const notebookId of await directoryNames(join(rootDir, "notebooks"))) {
    const sessionsDir = join(rootDir, "notebooks", notebookId, "sessions");
    let sessionIds: string[];
    try {
      sessionIds = await directoryNames(sessionsDir);
    } catch {
      continue;
    }
    for (const sessionId of sessionIds) {
      const startedAt = performance.now();
      try {
        const snapshot = await buildCompanionSessionSnapshot({ store, notebookId, sessionId });
        diagnostics.push({
          notebookId,
          sessionId,
          ok: true,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          markdownBytes: Buffer.byteLength(snapshot.markdown, "utf8"),
          htmlBytes: Buffer.byteLength(snapshot.html, "utf8"),
          assetCount: snapshot.assets.length
        });
      } catch (error) {
        diagnostics.push({
          notebookId,
          sessionId,
          ok: false,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        });
      }
    }
  }

  process.stdout.write(`${JSON.stringify({ rootDir, diagnostics }, null, 2)}\n`);
  if (diagnostics.some((item) => !item.ok)) process.exitCode = 1;
}

void main();

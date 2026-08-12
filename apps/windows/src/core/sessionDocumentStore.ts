import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSessionDocument, type SessionDocument } from "../common/sessionDocument";
import type { BlockStore } from "./blockStore";

export async function loadSessionDocumentFromStore(args: {
  store: BlockStore;
  notebookId: string;
  sessionId: string;
  markdownReadConcurrency?: number;
  readMarkdownFile?: (path: string) => Promise<string>;
}): Promise<SessionDocument> {
  const session = await args.store.readSession(args.notebookId, args.sessionId);
  const sessionDir = args.store.getSessionDir(args.notebookId, args.sessionId);
  const markdownBlocks = session.blocks.filter((block) => block.type === "markdown");
  const readMarkdownFile = args.readMarkdownFile ?? ((path: string) => readFile(path, "utf8"));
  const markdownEntries = await mapConcurrent(
    markdownBlocks,
    args.markdownReadConcurrency ?? 8,
    async (block) => [block.path, await readMarkdownFile(join(sessionDir, block.path))] as const
  );
  const markdownByPath = Object.fromEntries(markdownEntries);

  return createSessionDocument({
    notebookId: args.notebookId,
    session,
    markdownByPath,
    sessionDir
  });
}

export function compactSessionDocumentForRenderer(document: SessionDocument): SessionDocument {
  return {
    ...document,
    sourceLines: [],
    renderBlocks: document.renderBlocks.filter((block) => Boolean(block.pdf)),
    editableBlocks: []
  };
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), values.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}

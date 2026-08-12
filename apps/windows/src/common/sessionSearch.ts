import type { SessionSourceDocument } from "./sessionSourceDocument";

export type SessionSearchResult = {
  id: string;
  sourceId: string;
  blockId: string;
  title: string;
  snippet: string;
};

export function searchSessionSource(args: {
  document: SessionSourceDocument;
  blockMarkdowns: Map<string, string>;
  query: string;
  limit?: number;
}): SessionSearchResult[] {
  const normalizedQuery = args.query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const results: SessionSearchResult[] = [];
  const limit = args.limit ?? 20;

  for (const block of args.document.markdownBlocks) {
    const markdown = args.blockMarkdowns.get(block.blockId) ?? "";
    const headerHaystack = [block.header, block.blockId, block.path, block.source].join(" ").toLocaleLowerCase();
    const bodyLine = markdown
      .split(/\r?\n/)
      .find((line) => line.toLocaleLowerCase().includes(normalizedQuery));

    if (!headerHaystack.includes(normalizedQuery) && !bodyLine) {
      continue;
    }

    results.push({
      id: `${block.blockId}:${results.length}`,
      sourceId: block.sourceId,
      blockId: block.blockId,
      title: block.header,
      snippet: bodyLine?.trim() || block.path
    });

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

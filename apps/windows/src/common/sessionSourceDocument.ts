import type { BlockSource, SessionRecord } from "@mathnotes/shared";

export type SessionSourceMarkdownBlock = {
  blockId: string;
  sourceId: string;
  path: string;
  source: BlockSource;
  header: string;
  sourceAssetPath?: string;
  sourcePageNumber?: number;
  sourcePageImagePath?: string;
  locked: boolean;
  originalMarkdown?: string;
  continuationGroup?: string;
  sessionOrder?: number;
  renderInNote?: boolean;
};

export type SessionSourceDocument = {
  text: string;
  markdownBlocks: SessionSourceMarkdownBlock[];
};

export type ParsedMarkdownBlockUpdate = {
  blockId: string;
  path: string;
  markdown: string;
};

const markdownHeaderPattern =
  /^-{3,}\s*source:\s*(?<header>.*?)\s*\|\s*block:\s*(?<blockId>[A-Za-z0-9_-]+)\s*(?:\|\s*path:\s*(?<path>.*?)\s*)?(?:\|\s*kind:\s*(?<source>[A-Za-z0-9_-]+)\s*)?-{3,}$/;
const generatedHeaderFragmentPattern =
  /\s*-{2,}\s*source:\s*.*?\s*\|\s*block:\s*[A-Za-z0-9_-]+\s*(?:\|\s*path:\s*.*?\s*)?(?:\|\s*kind:\s*[A-Za-z0-9_-]+\s*)?-{2,}\s*/i;
const generatedHeaderStartFragmentPattern = /\s*-{2,}\s*source:\s*.*?\s*\|\s*block:\s*[A-Za-z0-9_-]+/i;
const generatedHeaderStartLinePattern = /\s*-{2,}\s*source:\s*.*$/i;
const generatedHeaderEndFragmentPattern = /\|\s*kind:\s*[A-Za-z0-9_-]+\s*-{2,}\s*$/i;
const generatedHeaderBareEndPattern = /^[A-Za-z0-9_-]+\s*-{2,}\s*$/i;

export function buildSessionSourceDocument(args: {
  session: SessionRecord;
  markdownByPath: Record<string, string>;
}): SessionSourceDocument {
  const chunks: string[] = [];
  const markdownBlocks: SessionSourceMarkdownBlock[] = [];

  for (const [sessionOrder, block] of args.session.blocks.entries()) {
    if (block.type !== "markdown") {
      continue;
    }

    const header = block.fromAssets?.[0] ? baseName(block.fromAssets[0]) : block.source;
    chunks.push(`--- source: ${header} | block: ${block.id} ---`);
    chunks.push(block.continuationGroup ? (args.markdownByPath[block.path] ?? "") : stripGeneratedSourceMetadata(args.markdownByPath[block.path] ?? ""));
    chunks.push("");
    const markdownBlock: SessionSourceMarkdownBlock = {
      blockId: block.id,
      sourceId: `src-${block.id}`,
      path: block.path,
      source: block.source,
      header,
      sourcePageNumber: block.sourcePageNumber,
      sourcePageImagePath: block.sourcePageImagePath,
      locked: block.status === "locked",
      originalMarkdown: (block.status === "locked" || args.session.locks.some(lock => lock.blockId === block.id)) && !block.continuationGroup ? (args.markdownByPath[block.path] ?? "") : undefined,
      continuationGroup: block.continuationGroup,
      sessionOrder,
      renderInNote: block.renderInNote
    };
    if (block.fromAssets?.[0]) {
      markdownBlock.sourceAssetPath = block.fromAssets[0];
    }
    markdownBlocks.push(markdownBlock);
  }

  return {
    text: markdownBlocks.some(block => block.continuationGroup) ? chunks.join("\n") : trimTrailingNewlines(chunks.join("\n")),
    markdownBlocks
  };
}

export function parseSessionSourceText(text: string, blocks: readonly SessionSourceMarkdownBlock[] = []): ParsedMarkdownBlockUpdate[] {
  const rawUpdates = parseContinuationSourceText(text, blocks);
  const blockById = new Map(blocks.map(block => [block.blockId, block]));
  const lines = text.split(/\r?\n/);
  const updates: ParsedMarkdownBlockUpdate[] = [];
  let current: { blockId: string; path: string; lines: string[] } | undefined;

  for (const line of lines) {
    const header = markdownHeaderPattern.exec(line);

    if (header?.groups) {
      if (current) {
        updates.push(toUpdate(current));
      }
      current = {
        blockId: header.groups.blockId,
        path: header.groups.path ?? "",
        lines: []
      };
      continue;
    }

    if (/^-{3,}\s*asset:\s*/.test(line)) {
      if (current) {
        updates.push(toUpdate(current));
        current = undefined;
      }
      continue;
    }

    current?.lines.push(line);
  }

  if (current) {
    updates.push(toUpdate(current));
  }

  return updates.map(update => {
    if (rawUpdates.has(update.blockId)) return { ...update, markdown: rawUpdates.get(update.blockId)! };
    const original = blockById.get(update.blockId)?.originalMarkdown;
    return original !== undefined && stripGeneratedSourceMetadata(original) === update.markdown ? { ...update, markdown: original } : update;
  });
}

export function isProtectedSourceHeaderLine(line: string): boolean {
  return Boolean(markdownHeaderPattern.test(line) || /^-{3,}\s*asset:\s*/.test(line));
}

function toUpdate(block: { blockId: string; path: string; lines: string[] }): ParsedMarkdownBlockUpdate {
  return {
    blockId: block.blockId,
    path: block.path,
    markdown: stripGeneratedSourceMetadata(block.lines.join("\n"))
  };
}

export function stripGeneratedSourceMetadata(markdown: string): string {
  const cleanedLines: string[] = [];
  let droppingHeaderContinuation = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (droppingHeaderContinuation) {
      if (isGeneratedHeaderContinuationEnd(line)) {
        droppingHeaderContinuation = false;
      }
      continue;
    }

    const startsSplitHeader = isSplitGeneratedHeaderStart(line);
    const cleaned = cleanupGeneratedSourceMetadataLine(line);
    if (startsSplitHeader && !hasGeneratedHeaderEnd(line)) {
      droppingHeaderContinuation = true;
    }
    if (cleaned.trim() === "" && line.trim() !== "") {
      continue;
    }
    if (!isGeneratedSourceMetadataLine(cleaned)) {
      cleanedLines.push(cleaned);
    }
  }

  return trimOuterBlankLines(cleanedLines.join("\n"));
}

function isGeneratedSourceMetadataLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^source:\s*\S+/i.test(trimmed) ||
    /^-{2,}\s*source:\s*\S+/i.test(trimmed) ||
    /^\|\s*block:\s*[A-Za-z0-9_-]+\s*(?:\|\s*path:\s*.*?\s*)?(?:\|\s*kind:\s*[A-Za-z0-9_-]+\s*)?-{2,}$/i.test(trimmed)
  );
}

function cleanupGeneratedSourceMetadataLine(line: string): string {
  return line
    .replace(generatedHeaderFragmentPattern, (match) => (match.startsWith(" ") ? " " : ""))
    .replace(generatedHeaderStartLinePattern, (match) => (match.startsWith(" ") ? " " : ""))
    .replace(/^\s*-{2,}\s*(?=#{1,6}\s)/, "")
    .trimEnd();
}

function isSplitGeneratedHeaderStart(line: string): boolean {
  return generatedHeaderStartFragmentPattern.test(line) && !generatedHeaderFragmentPattern.test(line);
}

function hasGeneratedHeaderEnd(line: string): boolean {
  return generatedHeaderFragmentPattern.test(line) || generatedHeaderEndFragmentPattern.test(line);
}

function isGeneratedHeaderContinuationEnd(line: string): boolean {
  const trimmed = line.trim();
  return generatedHeaderEndFragmentPattern.test(trimmed) || generatedHeaderBareEndPattern.test(trimmed);
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/\n+$/g, "");
}

function trimOuterBlankLines(value: string): string {
  return value.replace(/^\n+/g, "").replace(/\n+$/g, "");
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

// Generated framing is removed exactly; user whitespace, CRLF and split delimiters are payload.
function parseContinuationSourceText(text: string, blocks: readonly SessionSourceMarkdownBlock[]): Map<string, string> {
  const ids = new Set(blocks.filter(block => block.continuationGroup).map(block => block.blockId));
  const result = new Map<string, string>();
  if (!ids.size) return result;
  const headers: { id: string; start: number; body: number }[] = [];
  const lines = /[^\n]*(?:\n|$)/g;
  for (const match of text.matchAll(lines)) {
    if (!match[0]) continue;
    const header = markdownHeaderPattern.exec(match[0].replace(/\r?\n$/, ""));
    if (header?.groups) headers.push({ id: header.groups.blockId, start: match.index!, body: match.index! + match[0].length });
  }
  headers.forEach((header, index) => {
    if (!ids.has(header.id)) return;
    const next = headers[index + 1];
    let raw = text.slice(header.body, next?.start ?? text.length);
    const framing = next ? "\n\n" : "\n";
    if (raw.endsWith(framing)) raw = raw.slice(0, -framing.length);
    result.set(header.id, raw);
  });
  return result;
}

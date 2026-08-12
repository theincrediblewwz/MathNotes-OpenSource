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

  for (const block of args.session.blocks) {
    if (block.type !== "markdown") {
      continue;
    }

    const header = block.fromAssets?.[0] ? baseName(block.fromAssets[0]) : block.source;
    chunks.push(`--- source: ${header} | block: ${block.id} ---`);
    chunks.push(stripGeneratedSourceMetadata(args.markdownByPath[block.path] ?? ""));
    chunks.push("");
    const markdownBlock: SessionSourceMarkdownBlock = {
      blockId: block.id,
      sourceId: `src-${block.id}`,
      path: block.path,
      source: block.source,
      header,
      sourcePageNumber: block.sourcePageNumber,
      sourcePageImagePath: block.sourcePageImagePath,
      locked: block.status === "locked"
    };
    if (block.fromAssets?.[0]) {
      markdownBlock.sourceAssetPath = block.fromAssets[0];
    }
    markdownBlocks.push(markdownBlock);
  }

  return {
    text: trimTrailingNewlines(chunks.join("\n")),
    markdownBlocks
  };
}

export function parseSessionSourceText(text: string): ParsedMarkdownBlockUpdate[] {
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

  return updates;
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

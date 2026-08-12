import type { SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";
import { parseSessionSourceText } from "../../common/sessionSourceDocument";

export type SourceHeaderReference = {
  kind: "source" | "asset";
  target: string;
  assetPath?: string;
  blockId: string;
  sourcePageNumber?: number;
};

export type SourceEditorBlockRange = SessionSourceMarkdownBlock & {
  headerStart: number;
  bodyStart: number;
  to: number;
};

export type SourceEditorBodyBlockRange = SessionSourceMarkdownBlock & {
  from: number;
  to: number;
};

export type SourceEditorBodyDocument = {
  text: string;
  ranges: SourceEditorBodyBlockRange[];
};

export function buildMarkdownProjection(
  text: string,
  blocks: SessionSourceMarkdownBlock[]
): Record<string, string> {
  const parsed = new Map(parseSessionSourceText(text).map((update) => [update.blockId, update.markdown]));
  return Object.fromEntries(blocks.map((block) => [block.blockId, parsed.get(block.blockId) ?? ""]));
}

export function computeSourceEditorBlockRanges(text: string, blocks: SessionSourceMarkdownBlock[]): SourceEditorBlockRange[] {
  const blocksById = new Map(blocks.map((block) => [block.blockId, block]));
  const ranges: SourceEditorBlockRange[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const lineEnd = findLineEnd(text, lineStart);
    const line = text.slice(lineStart, lineEnd);
    const reference = readSourceReferenceFromHeaderLine(line);
    const block = reference ? blocksById.get(reference.blockId) : undefined;
    if (block && (!line.includes("| path:") || line.includes(block.path))) {
      ranges.push({
        ...block,
        headerStart: lineStart,
        bodyStart: Math.min(text.length, lineEnd + 1),
        to: text.length
      });
    }
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }

  return ranges.map((range, index) => ({
    ...range,
    to: ranges[index + 1]?.headerStart ?? text.length
  }));
}

export function findActiveMarkdownBlockAtPosition(
  position: number,
  text: string,
  blocks: SessionSourceMarkdownBlock[]
): SessionSourceMarkdownBlock | null {
  const ranges = computeSourceEditorBlockRanges(text, blocks);
  return findActiveMarkdownBlockInRanges(position, ranges);
}

export function findActiveMarkdownBlockInRanges(
  position: number,
  ranges: SourceEditorBlockRange[]
): SessionSourceMarkdownBlock | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (position < range.bodyStart) {
      high = middle - 1;
    } else if (position >= range.to) {
      low = middle + 1;
    } else {
      return range;
    }
  }
  return null;
}

export function isLockableMarkdownSelection(args: {
  from: number;
  to: number;
  text: string;
  blocks: SessionSourceMarkdownBlock[];
}): boolean {
  const from = Math.min(args.from, args.to);
  const to = Math.max(args.from, args.to);

  if (from === to) {
    return false;
  }

  return computeSourceEditorBlockRanges(args.text, args.blocks).some(
    (range) => from >= range.bodyStart && to <= range.to
  );
}

export function buildEditorBodyFromSourceText(text: string, blocks: SessionSourceMarkdownBlock[]): SourceEditorBodyDocument {
  const updatesByBlockId = new Map(parseSessionSourceText(text).map((update) => [update.blockId, update.markdown]));
  const chunks: string[] = [];
  const ranges: SourceEditorBodyBlockRange[] = [];
  let position = 0;

  blocks.forEach((block, index) => {
    const markdown = updatesByBlockId.get(block.blockId) ?? "";
    const isLast = index === blocks.length - 1;
    const separator = isLast ? "" : "\n\n";
    const chunk = `${markdown}${separator}`;
    const from = position;
    const to = position + chunk.length;

    chunks.push(chunk);
    ranges.push({
      ...block,
      from,
      to
    });
    position = to;
  });

  return {
    text: chunks.join(""),
    ranges
  };
}

export function buildSourceTextFromEditorBody(text: string, ranges: SourceEditorBodyBlockRange[]): string {
  const chunks: string[] = [];

  for (const range of ranges) {
    const markdown = trimTrailingNewlines(text.slice(range.from, range.to));
    chunks.push(`--- source: ${range.header} | block: ${range.blockId} ---`);
    chunks.push(markdown);
    chunks.push("");
  }

  return trimTrailingNewlines(chunks.join("\n"));
}

export function buildSourceTextFromBlockMarkdowns(
  blocks: SessionSourceMarkdownBlock[],
  markdownByBlockId: Record<string, string>
): string {
  const chunks: string[] = [];

  for (const block of blocks) {
    chunks.push(`--- source: ${block.header} | block: ${block.blockId} ---`);
    chunks.push(trimTrailingNewlines(markdownByBlockId[block.blockId] ?? ""));
    chunks.push("");
  }

  return trimTrailingNewlines(chunks.join("\n"));
}

export function findBodyBlockAtPosition(position: number, ranges: SourceEditorBodyBlockRange[]): SessionSourceMarkdownBlock | null {
  const active = ranges.find((range) => position >= range.from && position < range.to);
  return active ?? ranges.find((range) => position === range.from) ?? null;
}

export function isLockableBodySelection(args: { from: number; to: number; ranges: SourceEditorBodyBlockRange[] }): boolean {
  const from = Math.min(args.from, args.to);
  const to = Math.max(args.from, args.to);

  if (from === to) {
    return false;
  }

  return args.ranges.some((range) => from >= range.from && to <= range.to);
}

export function readSourceReferenceFromHeaderLine(line: string): SourceHeaderReference | null {
  const source =
    /^-{3,}\s*source:\s*(?<target>.*?)\s*\|\s*block:\s*(?<blockId>[A-Za-z0-9_-]+)\s*(?:\|\s*path:\s*.*?\s*)?(?:\|\s*kind:\s*.*?\s*)?-{3,}$/.exec(
      line
    );
  if (source?.groups) {
    return {
      kind: "source",
      target: source.groups.target,
      blockId: source.groups.blockId
    };
  }

  const asset = /^-{3,}\s*asset:\s*(?<target>.*?)\s*\|\s*block:\s*(?<blockId>[A-Za-z0-9_-]+)\s*\|\s*type:\s*.*?\s*-{3,}$/.exec(line);
  if (asset?.groups) {
    return {
      kind: "asset",
      target: asset.groups.target,
      blockId: asset.groups.blockId
    };
  }

  return null;
}

function findLineEnd(text: string, lineStart: number): number {
  const nextBreak = text.indexOf("\n", lineStart);
  return nextBreak > -1 ? nextBreak : text.length;
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/\n+$/g, "");
}

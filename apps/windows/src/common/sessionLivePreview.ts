import { markdownToRenderBlock, type RenderBlock } from "./sessionDocument";
import { parseSessionSourceText, type SessionSourceMarkdownBlock } from "./sessionSourceDocument";

export type SessionMarkdownProjection = Readonly<Record<string, string>>;

export type SessionLivePreviewProjectionStats = {
  totalBlockCount: number;
  reusedBlockCount: number;
  reparsedBlockCount: number;
  relocatedBlockCount: number;
  omittedBlockCount: number;
};

export type SessionLivePreviewProjection = {
  blocks: RenderBlock[];
  stats: SessionLivePreviewProjectionStats;
};

type ProjectionCacheEntry = {
  markdown: string;
  metadataSignature: string;
  sourceLine: number;
  renderBlock?: RenderBlock;
};

export function renderBlocksFromSessionSourceText(args: {
  sourceText: string;
  markdownBlocks: SessionSourceMarkdownBlock[];
}): RenderBlock[] {
  const blockById = new Map(args.markdownBlocks.map((block) => [block.blockId, block]));
  const sourceLines = findMarkdownHeaderLineNumbers(args.sourceText);

  return parseSessionSourceText(args.sourceText)
    .map((update) => {
      const block = blockById.get(update.blockId);
      if (!block) {
        return undefined;
      }
      const markdownLineCount = Math.max(1, update.markdown.split(/\r?\n/).length);

      return markdownToRenderBlock({
        id: `preview-${block.blockId}`,
        sourceId: block.sourceId,
        sourceLine: sourceLines.get(block.blockId) ?? 1,
        sourceBlockId: block.blockId,
        sourceLabel: block.header,
        sourceBlockLine: 1,
        sourceBlockLineCount: markdownLineCount,
        markdown: update.markdown,
        className: block.source === "user_revision" ? "revision" : block.source === "ai_transcription" ? "compact" : undefined
      });
    })
    .filter(isRenderableBlock);
}

export function createSessionLivePreviewProjector() {
  let cache = new Map<string, ProjectionCacheEntry>();

  return {
    project(args: {
      sourceText: string;
      markdownBlocks: SessionSourceMarkdownBlock[];
      markdownByBlockId: SessionMarkdownProjection;
    }): SessionLivePreviewProjection {
      const sourceLines = findMarkdownHeaderLineNumbers(args.sourceText);
      const nextCache = new Map<string, ProjectionCacheEntry>();
      const blocks: RenderBlock[] = [];
      const stats: SessionLivePreviewProjectionStats = {
        totalBlockCount: args.markdownBlocks.length,
        reusedBlockCount: 0,
        reparsedBlockCount: 0,
        relocatedBlockCount: 0,
        omittedBlockCount: 0
      };

      for (const block of args.markdownBlocks) {
        const markdown = args.markdownByBlockId[block.blockId] ?? "";
        const sourceLine = sourceLines.get(block.blockId) ?? 1;
        const metadataSignature = projectionMetadataSignature(block);
        const previous = cache.get(block.blockId);

        if (previous?.markdown === markdown && previous.metadataSignature === metadataSignature) {
          if (previous.renderBlock && previous.sourceLine !== sourceLine) {
            const relocated = { ...previous.renderBlock, sourceLine };
            nextCache.set(block.blockId, { ...previous, sourceLine, renderBlock: relocated });
            blocks.push(relocated);
            stats.relocatedBlockCount += 1;
          } else {
            nextCache.set(block.blockId, previous);
            if (previous.renderBlock) blocks.push(previous.renderBlock);
            stats.reusedBlockCount += 1;
          }
          if (!previous.renderBlock) stats.omittedBlockCount += 1;
          continue;
        }

        const renderBlock = createRenderBlock(block, markdown, sourceLine);
        nextCache.set(block.blockId, {
          markdown,
          metadataSignature,
          sourceLine,
          renderBlock
        });
        stats.reparsedBlockCount += 1;
        if (renderBlock) blocks.push(renderBlock);
        else stats.omittedBlockCount += 1;
      }

      cache = nextCache;
      return { blocks, stats };
    },
    reset() {
      cache = new Map();
    }
  };
}

function createRenderBlock(
  block: SessionSourceMarkdownBlock,
  markdown: string,
  sourceLine: number
): RenderBlock | undefined {
  const markdownLineCount = Math.max(1, markdown.split(/\r?\n/).length);
  const renderBlock = markdownToRenderBlock({
    id: `preview-${block.blockId}`,
    sourceId: block.sourceId,
    sourceLine,
    sourceBlockId: block.blockId,
    sourceLabel: block.header,
    sourceBlockLine: 1,
    sourceBlockLineCount: markdownLineCount,
    markdown,
    className: block.source === "user_revision" ? "revision" : block.source === "ai_transcription" ? "compact" : undefined
  });
  return isRenderableBlock(renderBlock) ? renderBlock : undefined;
}

function projectionMetadataSignature(block: SessionSourceMarkdownBlock): string {
  return [
    block.sourceId,
    block.header,
    block.source,
    block.path,
    block.sourceAssetPath ?? "",
    block.sourcePageNumber ?? "",
    block.sourcePageImagePath ?? "",
    block.locked ? "locked" : "editable"
  ].join("\u0000");
}

function findMarkdownHeaderLineNumbers(sourceText: string): Map<string, number> {
  const lineNumbers = new Map<string, number>();
  const lines = sourceText.split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = /^-{3,}\s*source:.*?\|\s*block:\s*(?<blockId>[A-Za-z0-9_-]+)\s*(?:\|.*?)?-{3,}$/.exec(line);
    if (match?.groups) {
      lineNumbers.set(match.groups.blockId, index + 1);
    }
  });

  return lineNumbers;
}

function isRenderableBlock(block: RenderBlock | undefined): block is RenderBlock {
  return Boolean(block?.title || block?.subtitle || block?.items?.length || block?.paragraphs?.length || block?.formulas?.length || block?.unclear);
}

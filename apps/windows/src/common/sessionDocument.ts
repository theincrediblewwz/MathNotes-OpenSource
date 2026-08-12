import type { BlockSource, SessionRecord } from "@mathnotes/shared";
import { buildSessionSourceDocument, type SessionSourceDocument } from "./sessionSourceDocument";

export type SourceLine = {
  line: number;
  id?: string;
  kind?: "dim" | "key" | "md" | "quote" | "plain";
  text: string;
  linkTarget?: string;
  suffix?: string;
  editableBlockId?: string;
};

export type RenderBlock = {
  id: string;
  sourceId: string;
  sourceLine: number;
  sourceBlockId?: string;
  sourceLabel?: string;
  sourceBlockLine?: number;
  sourceBlockLineCount?: number;
  className?: string;
  markdown?: string;
  title?: string;
  subtitle?: string;
  items?: RenderBlockItem[];
  paragraphs?: string[];
  formulas?: string[];
  unclear?: string;
  pdf?: {
    assetPath: string;
    pageCount: number;
  };
};

export type RenderBlockItem =
  | {
      kind: "paragraph";
      text: string;
    }
  | {
      kind: "code";
      text: string;
      language?: string;
    }
  | {
      kind: "formula";
      text: string;
    }
  | {
      kind: "unclear";
      text: string;
    };

export type EditableMarkdownBlock = {
  id: string;
  sourceId: string;
  sourceLine: number;
  path: string;
  source: BlockSource;
  markdown: string;
};

export type SessionDocument = {
  notebookId: string;
  sessionId: string;
  title: string;
  sessionDir?: string;
  sourceLines: SourceLine[];
  renderBlocks: RenderBlock[];
  editableBlocks: EditableMarkdownBlock[];
  sourceDocument: SessionSourceDocument;
};

export function createSessionDocument(args: {
  notebookId: string;
  session: SessionRecord;
  markdownByPath: Record<string, string>;
  sessionDir?: string;
}): SessionDocument {
  const sourceLines: SourceLine[] = [];
  const renderBlocks: RenderBlock[] = [];
  const editableBlocks: EditableMarkdownBlock[] = [];

  for (const block of args.session.blocks) {
    pushSourceDivider(sourceLines);

    if (block.type === "pdf") {
      const sourceLine = sourceLines.length + 1;
      const sourceId = `src-${block.id}`;
      const sourceLabel = block.sourceName ?? baseName(block.path);
      sourceLines.push({
        line: sourceLine,
        id: sourceId,
        kind: "key",
        text: "source:",
        linkTarget: sourceLabel
      });
      if (block.renderInNote !== false) {
        renderBlocks.push({
          id: `preview-${block.id}`,
          sourceId,
          sourceLine,
          sourceBlockId: block.id,
          sourceLabel,
          sourceBlockLine: 1,
          sourceBlockLineCount: 1,
          className: "pdf",
          pdf: {
            assetPath: block.path,
            pageCount: Math.max(1, block.pageCount ?? 1)
          }
        });
      }
      continue;
    }

    if (block.type === "image") {
      sourceLines.push({
        line: sourceLines.length + 1,
        id: `src-${block.id}`,
        kind: "key",
        text: "source:",
        linkTarget: baseName(block.path)
      });
      continue;
    }

    if (block.type !== "markdown") {
      sourceLines.push({
        line: sourceLines.length + 1,
        id: `src-${block.id}`,
        kind: "key",
        text: `source: ${block.source}`
      });
      continue;
    }

    const markdown = args.markdownByPath[block.path] ?? "";
    const startLine = sourceLines.length + 1;
    const sourceId = `src-${block.id}`;
    const lines = markdown.split(/\r?\n/);
    const assetName = block.fromAssets?.[0] ? baseName(block.fromAssets[0]) : block.source;

    sourceLines.push({
      line: sourceLines.length + 1,
      id: sourceId,
      kind: "key",
      text: "source:",
      linkTarget: assetName,
      suffix: block.source === "ai_transcription" ? "(ocr_transcript)" : undefined,
      editableBlockId: block.id
    });
    editableBlocks.push({
      id: block.id,
      sourceId,
      sourceLine: startLine,
      path: block.path,
      source: block.source,
      markdown
    });

    for (const line of lines) {
      if (isSourceMetadata(line)) {
        continue;
      }

      sourceLines.push({
        line: sourceLines.length + 1,
        kind: sourceKind(line),
        text: line
      });
    }

    const renderBlock = markdownToRenderBlock({
      id: `preview-${block.id}`,
      sourceId,
      sourceLine: startLine,
      sourceBlockId: block.id,
      sourceLabel: assetName,
      sourceBlockLine: 1,
      sourceBlockLineCount: lines.length,
      markdown,
      className: block.source === "user_revision" ? "revision" : block.source === "ai_transcription" ? "compact" : undefined
    });

    if (renderBlock.title || renderBlock.subtitle || renderBlock.items?.length || renderBlock.paragraphs?.length || renderBlock.formulas?.length || renderBlock.unclear) {
      renderBlocks.push(renderBlock);
    }
  }

  pushSourceDivider(sourceLines);

  return {
    notebookId: args.notebookId,
    sessionId: args.session.id,
    title: args.session.title,
    sessionDir: args.sessionDir,
    sourceLines,
    renderBlocks,
    editableBlocks,
    sourceDocument: buildSessionSourceDocument({
      session: args.session,
      markdownByPath: args.markdownByPath
    })
  };
}

export function markdownToRenderBlock(args: {
  id: string;
  sourceId: string;
  sourceLine: number;
  sourceBlockId?: string;
  sourceLabel?: string;
  sourceBlockLine?: number;
  sourceBlockLineCount?: number;
  markdown: string;
  className?: string;
}): RenderBlock {
  const block: RenderBlock = {
    id: args.id,
    sourceId: args.sourceId,
    sourceLine: args.sourceLine,
    sourceBlockId: args.sourceBlockId,
    sourceLabel: args.sourceLabel,
    sourceBlockLine: args.sourceBlockLine,
    sourceBlockLineCount: args.sourceBlockLineCount,
    className: args.className,
    markdown: cleanMarkdownForPreview(args.markdown),
    items: [],
    paragraphs: [],
    formulas: []
  };

  let codeFence: { language?: string; lines: string[] } | null = null;

  for (const rawLine of args.markdown.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      if (codeFence) {
        pushCodeFence(block, codeFence);
        codeFence = null;
      } else {
        const language = line.slice(3).trim();
        codeFence = { language: language || undefined, lines: [] };
      }
      continue;
    }

    if (codeFence) {
      codeFence.lines.push(rawLine.replace(/\s+$/, ""));
      continue;
    }

    if (!line || isSourceMetadata(line) || isLockMetadata(line)) {
      continue;
    }

    if (line.startsWith("#### ")) {
      block.title ??= line.slice(5).trim();
      continue;
    }

    if (line.startsWith("### ")) {
      block.subtitle ??= line.slice(4).trim();
      continue;
    }

    if (line.startsWith("## ")) {
      if (!block.title) {
        block.title = line.slice(3).trim();
      } else {
        block.subtitle ??= line.slice(3).trim();
      }
      continue;
    }

    if (line.startsWith("# ")) {
      block.title ??= line.slice(2).trim();
      continue;
    }

    if (line.startsWith("[看不清") || line.includes("看不清")) {
      block.unclear = line;
      block.items?.push({ kind: "unclear", text: line });
      continue;
    }

    if (isFormulaLine(line)) {
      const formula = stripFormulaDelimiters(line);
      block.formulas?.push(formula);
      block.items?.push({ kind: "formula", text: formula });
      continue;
    }

    const paragraph = stripMarkdownEmphasis(line);
    block.paragraphs?.push(paragraph);
    block.items?.push({ kind: "paragraph", text: paragraph });
  }

  if (codeFence) {
    pushCodeFence(block, codeFence);
  }

  if (block.items?.length === 0) {
    delete block.items;
  }
  if (block.paragraphs?.length === 0) {
    delete block.paragraphs;
  }
  if (block.formulas?.length === 0) {
    delete block.formulas;
  }

  return block;
}

function pushCodeFence(block: RenderBlock, codeFence: { language?: string; lines: string[] }): void {
  const text = codeFence.lines.join("\n").replace(/\n+$/, "");
  if (!text.trim()) {
    return;
  }
  block.items?.push({ kind: "code", text, language: codeFence.language });
}

function cleanMarkdownForPreview(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !isSourceMetadata(line) && !isLockMetadata(line.trim()))
    .join("\n")
    .trim();
}

function pushSourceDivider(sourceLines: SourceLine[]): void {
  sourceLines.push({
    line: sourceLines.length + 1,
    kind: "dim",
    text: "---"
  });
}

function isSourceMetadata(line: string): boolean {
  return line.trim().toLowerCase().startsWith("source:");
}

function isLockMetadata(line: string): boolean {
  return line.startsWith("<!-- lock:start") || line.startsWith("<!-- lock:end");
}

function sourceKind(line: string): SourceLine["kind"] {
  const trimmed = line.trim();
  if (!trimmed) {
    return "plain";
  }
  if (trimmed === "---" || trimmed.startsWith("```")) {
    return "dim";
  }
  if (trimmed.startsWith("#")) {
    return "md";
  }
  if (trimmed.startsWith(">")) {
    return "quote";
  }
  if (isSourceMetadata(trimmed)) {
    return "key";
  }
  return "plain";
}

function isFormulaLine(line: string): boolean {
  return (
    line.startsWith("$$") ||
    line.endsWith("$$") ||
    line.includes("||") ||
    line.includes("\\|") ||
    line.includes("∥") ||
    line.includes("\\le") ||
    line.includes("<=")
  );
}

function stripFormulaDelimiters(line: string): string {
  return line.replace(/^\$\$\s*/, "").replace(/\s*\$\$$/, "").trim();
}

function stripMarkdownEmphasis(line: string): string {
  return line.replace(/\*\*/g, "");
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export const ASSISTANT_CONTEXT_LIMITS = {
  selectionCharacters: 12_000,
  focusedBlockCharacters: 24_000,
  namedBlockCharacters: 24_000,
  blockManifestCharacters: 20_000,
  backgroundCharacters: 60_000,
  totalCharacters: 104_000,
  imageCount: 8,
  manifestExcerptCharacters: 120
} as const;

export type AssistantContextBlock = Readonly<{
  id: string;
  source: string;
  markdown: string;
}>;

export type AssistantContextFocus = Readonly<{
  kind: "selection" | "block" | "session";
  blockId?: string;
  label: string;
  excerpt?: string;
}>;

export type AssistantContextUsage = Readonly<{
  version: 1;
  textCharacters: number;
  maximumTextCharacters: number;
  maximumImageCount: number;
  sessionBlockCount: number;
  sessionCharacterCount: number;
  includedBlockIds: readonly string[];
  namedBlockOrdinals: readonly number[];
  truncated: boolean;
  focusTruncated: boolean;
}>;

export type AssistantContextPacket = Readonly<{
  markdownContext: string;
  usage: AssistantContextUsage;
}>;

export function buildAssistantContextPacket(input: {
  focus: AssistantContextFocus;
  question?: string;
  blocks: readonly AssistantContextBlock[];
}): AssistantContextPacket {
  const ordinalByBlockId = new Map(input.blocks.map((block, index) => [block.id, index + 1]));
  const namedBlockOrdinals = extractAssistantBlockOrdinals(input.question, input.blocks.length);
  const namedBlocks = namedBlockOrdinals
    .map((ordinal) => input.blocks[ordinal - 1])
    .filter((block): block is AssistantContextBlock => Boolean(block));
  const focusLimit = input.focus.kind === "selection"
    ? ASSISTANT_CONTEXT_LIMITS.selectionCharacters
    : input.focus.kind === "block"
      ? ASSISTANT_CONTEXT_LIMITS.focusedBlockCharacters
      : 0;
  const originalFocus = input.focus.excerpt?.trim() ?? "";
  const boundedFocus = focusLimit > 0 ? takeCharacters(originalFocus, focusLimit) : "";
  const includedBlockIds = new Set<string>();

  const sections = [
    [
      "# 本轮焦点",
      "",
      `类型：${input.focus.kind}`,
      `来源：${input.focus.label}`,
      input.focus.blockId ? `稳定 block ID：${input.focus.blockId}` : "",
      input.focus.blockId ? `当前显示序号：第 ${ordinalByBlockId.get(input.focus.blockId) ?? "?"} 块` : ""
    ].filter(Boolean).join("\n"),
    boundedFocus || "请结合下面的当前笔记回答。",
    [
      "# 当前块索引（只读）",
      "",
      "“第 N 块”严格指下面索引中的当前显示序号；重排后序号变化，stable ID 不变。",
      "",
      buildBlockManifest(input.blocks)
    ].join("\n")
  ];

  if (input.focus.blockId) includedBlockIds.add(input.focus.blockId);

  if (namedBlocks.length > 0) {
    let remaining = ASSISTANT_CONTEXT_LIMITS.namedBlockCharacters;
    const chunks = ["# 问题中点名的块（优先）"];
    for (const block of namedBlocks) {
      if (remaining <= 0) break;
      const markdown = block.markdown.trim();
      const bounded = takeCharacters(markdown, remaining);
      chunks.push(`## 第 ${ordinalByBlockId.get(block.id)} 块 · stable ID ${block.id}\n${bounded}`);
      includedBlockIds.add(block.id);
      remaining -= characterCount(bounded);
    }
    sections.push(chunks.join("\n\n"));
  }

  const backgroundChunks = ["# 当前笔记背景（只读、有界）"];
  let backgroundRemaining = ASSISTANT_CONTEXT_LIMITS.backgroundCharacters;
  const skipBlockIds = new Set([
    ...(input.focus.blockId ? [input.focus.blockId] : []),
    ...namedBlocks.map((block) => block.id)
  ]);
  for (const block of input.blocks) {
    if (backgroundRemaining <= 0) break;
    if (skipBlockIds.has(block.id)) continue;
    const markdown = block.markdown.trim();
    const bounded = takeCharacters(markdown, backgroundRemaining);
    backgroundChunks.push(
      `<!-- source-block:${block.id} ordinal:${ordinalByBlockId.get(block.id)} source:${block.source} -->\n${bounded}`
    );
    includedBlockIds.add(block.id);
    backgroundRemaining -= characterCount(bounded);
  }
  sections.push(backgroundChunks.join("\n\n"));

  const unbounded = sections.join("\n\n");
  const markdownContext = takeCharacters(unbounded, ASSISTANT_CONTEXT_LIMITS.totalCharacters);
  const sessionCharacterCount = input.blocks.reduce(
    (total, block) => total + characterCount(block.markdown),
    0
  );
  return {
    markdownContext,
    usage: {
      version: 1,
      textCharacters: characterCount(markdownContext),
      maximumTextCharacters: ASSISTANT_CONTEXT_LIMITS.totalCharacters,
      maximumImageCount: ASSISTANT_CONTEXT_LIMITS.imageCount,
      sessionBlockCount: input.blocks.length,
      sessionCharacterCount,
      includedBlockIds: [...includedBlockIds],
      namedBlockOrdinals,
      truncated: characterCount(unbounded) > ASSISTANT_CONTEXT_LIMITS.totalCharacters,
      focusTruncated: characterCount(originalFocus) > focusLimit && focusLimit > 0
    }
  };
}

export function extractAssistantBlockOrdinals(question: string | undefined, blockCount: number): number[] {
  if (!question) return [];
  const ordinals = new Set<number>();
  for (const match of question.matchAll(/第\s*(\d{1,6})\s*块/g)) {
    const ordinal = Number.parseInt(match[1], 10);
    if (ordinal >= 1 && ordinal <= blockCount) ordinals.add(ordinal);
  }
  return [...ordinals];
}

function buildBlockManifest(blocks: readonly AssistantContextBlock[]): string {
  const lines: string[] = [];
  let remaining = ASSISTANT_CONTEXT_LIMITS.blockManifestCharacters;
  for (const [index, block] of blocks.entries()) {
    if (remaining <= 0) break;
    const excerpt = takeCharacters(
      block.markdown.replace(/\s+/g, " ").trim(),
      ASSISTANT_CONTEXT_LIMITS.manifestExcerptCharacters
    );
    const line = `${index + 1}. stable ID=${block.id}; source=${block.source}; 摘要=${excerpt || "（空）"}`;
    const bounded = takeCharacters(line, remaining);
    lines.push(bounded);
    remaining -= characterCount(bounded);
  }
  return lines.join("\n");
}

function takeCharacters(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  const characters = Array.from(value);
  return characters.length <= maximum ? value : characters.slice(0, maximum).join("");
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

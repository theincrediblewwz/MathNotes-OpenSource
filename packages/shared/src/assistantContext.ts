export const ASSISTANT_CONTEXT_LIMITS = {
  selectionCharacters: 12_000,
  focusedBlockCharacters: 24_000,
  namedBlockCharacters: 24_000,
  blockManifestCharacters: 20_000,
  backgroundCharacters: 60_000,
  totalCharacters: 104_000,
  imageCount: 8,
  manifestExcerptCharacters: 120,
  relatedKnowledgeCharacters: 24_000
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

export type AssistantRelatedSource = Readonly<{
  refId: string;
  notebookId: string;
  notebookTitle: string;
  sessionId: string;
  sessionTitle: string;
  blockId: string;
  markdown: string;
  locked: boolean;
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
  relatedSourceRefs: readonly string[];
}>;

export type AssistantContextPacket = Readonly<{
  markdownContext: string;
  usage: AssistantContextUsage;
}>;

export type AssistantBlockEditIntent = Readonly<{
  ordinal: number;
  instruction: string;
}>;

export function buildAssistantContextPacket(input: {
  focus: AssistantContextFocus;
  question?: string;
  blocks: readonly AssistantContextBlock[];
  relatedSources?: readonly AssistantRelatedSource[];
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
      input.focus.blockId ? `当前显示序号：第 ${ordinalByBlockId.get(input.focus.blockId) ?? "?"} 块` : ""
    ].filter(Boolean).join("\n"),
    boundedFocus || "请结合下面的当前笔记回答。",
    [
      "# 当前块索引",
      "",
      "“第 N 块”严格指下面索引中的当前显示序号。需要修改时给出明确候选，应用会在用户确认、锁定检查和版本复核后决定是否写入。",
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
      chunks.push(`## 第 ${ordinalByBlockId.get(block.id)} 块\n${bounded}`);
      includedBlockIds.add(block.id);
      remaining -= characterCount(bounded);
    }
    sections.push(chunks.join("\n\n"));
  }

  const relatedSourceRefs: string[] = [];
  if (input.relatedSources?.length) {
    let remaining = ASSISTANT_CONTEXT_LIMITS.relatedKnowledgeCharacters;
    const chunks = [
      "# 相关笔记（只读、有界）",
      "以下内容只用于回答和提出候选，不授予任何写入权限。"
    ];
    for (const source of input.relatedSources) {
      if (remaining <= 0) break;
      const header = [
        `## Notebook：${source.notebookTitle} / Session：${source.sessionTitle}`,
        `权限：只读；${source.locked ? "内容已锁定" : "本轮未向模型开放写入接口"}`
      ].join("\n");
      const availableForMarkdown = Math.max(0, remaining - characterCount(header) - 2);
      const markdown = takeCharacters(source.markdown.trim(), availableForMarkdown);
      chunks.push(`${header}\n\n${markdown}`);
      relatedSourceRefs.push(source.refId);
      remaining -= characterCount(header) + characterCount(markdown) + 2;
    }
    sections.push(chunks.join("\n\n"));
  }

  const backgroundChunks = ["# 当前笔记背景（有界）"];
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
      `<!-- ordinal:${ordinalByBlockId.get(block.id)} source:${block.source} -->\n${bounded}`
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
      focusTruncated: characterCount(originalFocus) > focusLimit && focusLimit > 0,
      relatedSourceRefs
    }
  };
}

export function extractAssistantBlockOrdinals(question: string | undefined, blockCount: number): number[] {
  if (!question) return [];
  const ordinals = new Set<number>();
  for (const match of question.matchAll(/第\s*([零〇一二两三四五六七八九十百千万\d]{1,12})\s*(?:个)?\s*(?:块|block)/gi)) {
    const ordinal = parseAssistantOrdinal(match[1]);
    if (ordinal >= 1 && ordinal <= blockCount) ordinals.add(ordinal);
  }
  for (const match of question.matchAll(/\bblock\s*[:#]?\s*0*(\d{1,6})\b/gi)) {
    const ordinal = Number.parseInt(match[1], 10);
    if (ordinal >= 1 && ordinal <= blockCount) ordinals.add(ordinal);
  }
  return [...ordinals];
}

export function resolveAssistantBlockEditIntent(input: {
  question?: string;
  blockCount: number;
  focusedOrdinal?: number;
}): AssistantBlockEditIntent | null {
  const instruction = input.question?.trim() ?? "";
  if (!instruction || !/(?:修改|改写|重写|润色|优化|修订|替换|删(?:除|掉)|扩写|扩展|补充|压缩|精简|整理)/.test(instruction)) {
    return null;
  }
  const named = extractAssistantBlockOrdinals(instruction, input.blockCount);
  if (named.length > 1) return null;
  const ordinal = named[0] ?? input.focusedOrdinal;
  if (!ordinal || ordinal < 1 || ordinal > input.blockCount) return null;
  return { ordinal, instruction };
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
    const line = `${index + 1}. source=${block.source}; 摘要=${excerpt || "（空）"}`;
    const bounded = takeCharacters(line, remaining);
    lines.push(bounded);
    remaining -= characterCount(bounded);
  }
  return lines.join("\n");
}

function parseAssistantOrdinal(value: string): number {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const character of value) {
    if (character in digits) {
      number = digits[character];
    } else if (character in units) {
      section += (number || 1) * units[character];
      number = 0;
    } else if (character === "万") {
      total += (section + number || 1) * 10_000;
      section = 0;
      number = 0;
    }
  }
  return total + section + number;
}

function takeCharacters(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  const characters = Array.from(value);
  return characters.length <= maximum ? value : characters.slice(0, maximum).join("");
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

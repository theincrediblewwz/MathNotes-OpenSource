import { access } from "node:fs/promises";
import path from "node:path";
import {
  ASSISTANT_CONTEXT_LIMITS,
  buildAssistantContextPacket,
  extractAssistantBlockOrdinals,
  type AssistantContextUsage,
  type AssistantMode,
  type AssistantProvider,
  type AssistantProviderEvent,
  type BlockRef
} from "@mathnotes/shared";
import type { BlockStore } from "./blockStore";
import { AssistantRemarkStore, type AssistantRemark, type AssistantRemarkFocus } from "./assistantRemarkStore";

export type AssistantTaskInput = {
  taskId: string;
  notebookId: string;
  sessionId: string;
  scope: "selection" | "block" | "session";
  activeBlockId?: string;
  selectedText?: string;
  focusLabel?: string;
  mode: AssistantMode;
  question?: string;
  abortSignal?: AbortSignal;
};

export type AssistantTaskSummary = {
  taskId: string;
  status: "succeeded" | "failed" | "cancelled";
  mode: AssistantMode;
  scope: AssistantTaskInput["scope"];
  sourceBlockIds: string[];
  remarkId?: string;
  providerName: string;
  contextUsage: AssistantContextUsage;
  imageCount: number;
  error?: string;
};

export type AssistantTaskRuntimeEvent = {
  taskId: string;
  level: "info" | "stdout" | "stderr" | "error";
  message: string;
  at: string;
  previewChanged?: boolean;
};

const supportedRasterExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export async function runAssistantTask(args: {
  store: BlockStore;
  provider: AssistantProvider;
  input: AssistantTaskInput;
  now?: () => string;
  onRuntimeEvent?: (event: AssistantTaskRuntimeEvent) => void;
}): Promise<AssistantTaskSummary> {
  const now = args.now ?? (() => new Date().toISOString());
  const session = await args.store.readSession(args.input.notebookId, args.input.sessionId);
  const readableBlocks = session.blocks.filter(
    (block) => block.type === "markdown" && block.source !== "ai_explanation"
  );
  const focusBlocks = selectFocusBlocks(readableBlocks, args.input);
  if (focusBlocks.length === 0) {
    throw new Error("没有可供学习助手读取的 Markdown block。");
  }

  const markdownByBlockId = new Map(
    await Promise.all(
      readableBlocks.map(async (block) => [
        block.id,
        await args.store.readMarkdownBlock(args.input.notebookId, args.input.sessionId, block.id)
      ] as const)
    )
  );
  const focus = buildFocus(args.input, focusBlocks, markdownByBlockId);
  const contextPacket = buildAssistantContextPacket({
    focus,
    question: args.input.question,
    blocks: readableBlocks.map((block) => ({
      id: block.id,
      source: block.source,
      markdown: markdownByBlockId.get(block.id) ?? ""
    }))
  });
  const imagePaths = await collectImagePaths({
    store: args.store,
    notebookId: args.input.notebookId,
    sessionId: args.input.sessionId,
    selectedMarkdownBlocks: focusBlocks,
    allBlocks: session.blocks,
    includeSessionImages: args.input.scope === "session"
  });

  const taskId = args.input.taskId;
  const emitProviderEvent = (event: AssistantProviderEvent) => {
    args.onRuntimeEvent?.({
      taskId,
      level: event.type === "stdout" ? "stdout" : event.type === "stderr" ? "stderr" : "info",
      message: event.type === "stdout" || event.type === "stderr" ? event.text : event.message,
      at: now()
    });
  };

  try {
    args.onRuntimeEvent?.({
      taskId,
      level: "info",
      message: `学习助手已启动：${args.provider.name} · ${modeTitle(args.input.mode)} · ${focus.label}。`,
      at: now()
    });
    const providerInput = {
      mode: args.input.mode,
      markdownContext: contextPacket.markdownContext,
      imagePaths,
      question: args.input.question,
      sessionId: args.input.sessionId,
      abortSignal: args.input.abortSignal
    };
    const result = args.provider.assistWithEvents
      ? await args.provider.assistWithEvents({ ...providerInput, onEvent: emitProviderEvent })
      : await args.provider.assist(providerInput);
    const createdAt = now();
    const remark: AssistantRemark = {
      id: `remark_${taskId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      mode: args.input.mode,
      focus,
      question: args.input.question?.trim() || undefined,
      markdown: result.markdown.trim(),
      providerName: args.provider.name,
      sourceBlockIds: focusBlocks.map((block) => block.id),
      createdAt,
      updatedAt: createdAt
    };
    await new AssistantRemarkStore(args.store).append({
      notebookId: args.input.notebookId,
      sessionId: args.input.sessionId,
      remark
    });
    args.onRuntimeEvent?.({
      taskId,
      level: "info",
      message: "学习助手已完成，结果保存在旁注中；主笔记未修改。",
      at: now(),
      previewChanged: true
    });
    return {
      taskId,
      status: "succeeded",
      mode: args.input.mode,
      scope: args.input.scope,
      sourceBlockIds: focusBlocks.map((block) => block.id),
      remarkId: remark.id,
      providerName: args.provider.name,
      contextUsage: contextPacket.usage,
      imageCount: imagePaths.length
    };
  } catch (error) {
    const cancelled = args.input.abortSignal?.aborted ?? false;
    const message = error instanceof Error ? error.message : String(error);
    args.onRuntimeEvent?.({
      taskId,
      level: cancelled ? "info" : "error",
      message: cancelled ? "学习助手已由用户中断，主笔记未修改。" : `学习助手失败：${message}`,
      at: now()
    });
    return {
      taskId,
      status: cancelled ? "cancelled" : "failed",
      mode: args.input.mode,
      scope: args.input.scope,
      sourceBlockIds: focusBlocks.map((block) => block.id),
      providerName: args.provider.name,
      contextUsage: contextPacket.usage,
      imageCount: imagePaths.length,
      error: message
    };
  }
}

function selectFocusBlocks(blocks: BlockRef[], input: AssistantTaskInput): BlockRef[] {
  if (input.scope === "session") return blocks;
  return blocks.filter((block) => block.id === input.activeBlockId);
}

function buildFocus(
  input: AssistantTaskInput,
  focusBlocks: BlockRef[],
  markdownByBlockId: Map<string, string>
): AssistantRemarkFocus {
  if (input.scope === "selection") {
    const excerpt = input.selectedText?.trim();
    if (!excerpt) throw new Error("请先选择一段文字，再拖入或发送给学习助手。");
    return {
      kind: "selection",
      blockId: input.activeBlockId,
      label: input.focusLabel?.trim() || `选区 · block ${input.activeBlockId}`,
      excerpt: excerpt.slice(0, ASSISTANT_CONTEXT_LIMITS.selectionCharacters)
    };
  }
  if (input.scope === "block") {
    const block = focusBlocks[0];
    return {
      kind: "block",
      blockId: block.id,
      label: input.focusLabel?.trim() || `block ${block.id}`,
      excerpt: (markdownByBlockId.get(block.id) ?? "").slice(0, ASSISTANT_CONTEXT_LIMITS.focusedBlockCharacters)
    };
  }
  return { kind: "session", label: input.focusLabel?.trim() || "当前 Session" };
}

export function buildMarkdownContext(args: {
  focus: AssistantRemarkFocus;
  question?: string;
  readableBlocks: BlockRef[];
  markdownByBlockId: Map<string, string>;
}): string {
  return buildAssistantContextPacket({
    focus: args.focus,
    question: args.question,
    blocks: args.readableBlocks.map((block) => ({
      id: block.id,
      source: block.source,
      markdown: args.markdownByBlockId.get(block.id) ?? ""
    }))
  }).markdownContext;
}

export function extractBlockOrdinals(question: string | undefined, blockCount: number): number[] {
  return extractAssistantBlockOrdinals(question, blockCount);
}

export async function collectImagePaths(args: {
  store: BlockStore;
  notebookId: string;
  sessionId: string;
  selectedMarkdownBlocks: BlockRef[];
  allBlocks: BlockRef[];
  includeSessionImages: boolean;
}): Promise<string[]> {
  const relativePaths = new Set<string>();
  for (const block of args.selectedMarkdownBlocks) {
    if (block.sourcePageImagePath) relativePaths.add(block.sourcePageImagePath);
    for (const asset of block.fromAssets ?? []) relativePaths.add(asset);
  }
  if (args.includeSessionImages) {
    for (const block of args.allBlocks) {
      if (block.type === "image") relativePaths.add(block.path);
    }
  }
  const sessionDir = args.store.getSessionDir(args.notebookId, args.sessionId);
  const resolved: string[] = [];
  for (const relative of relativePaths) {
    if (!supportedRasterExtensions.has(path.extname(relative).toLowerCase())) continue;
    const absolute = path.resolve(sessionDir, relative);
    const inside = path.relative(sessionDir, absolute);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) continue;
    try {
      await access(absolute);
      resolved.push(absolute);
      if (resolved.length >= ASSISTANT_CONTEXT_LIMITS.imageCount) break;
    } catch {
      // Missing evidence is omitted; the Markdown uncertainty marker remains in context.
    }
  }
  return resolved;
}

function modeTitle(mode: AssistantMode): string {
  if (mode === "teach") return "教学";
  if (mode === "summarize") return "总结";
  return "解读";
}

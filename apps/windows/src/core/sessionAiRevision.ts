import { continuationContexts, continuationInstructions } from "./continuationContext";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantProvider } from "@mathnotes/shared";
import { validateReplicaId } from "@mathnotes/core-server";
import { sha256Text } from "../common/lockSpan";
import { validateAiMarkdownUpdate } from "../common/lockValidation";
import { BlockStore } from "./blockStore";
import { AssistantRemarkStore } from "./assistantRemarkStore";

export type SessionAiRevision = {
  id: string;
  notebookId: string;
  sessionId: string;
  instruction: string;
  summary: string;
  status: "proposed" | "applied" | "cancelled";
  changes: Array<{ blockId: string; title: string; before: string; markdown: string; summary: string }>;
  lockedSuggestions: Array<{ blockId: string; title: string; suggestion: string }>;
  createdAt: string;
  reportWarning?: string;
};
type StoredRevision = SessionAiRevision & { baseSessionHash: string; baseMarkdownHashes: Record<string, string> };
type Target = { notebookId: string; sessionId: string };

export class SessionAiRevisionService {
  constructor(private readonly store: BlockStore, private readonly createProvider: () => Promise<AssistantProvider>) {}

  async propose(input: Target & { instruction: string; abortSignal?: AbortSignal }): Promise<SessionAiRevision> {
    this.path({ ...input, proposalId: `session_${randomUUID()}` });
    const instruction = input.instruction.trim();
    if (!instruction || instruction.length > 8_000) throw new Error("请输入不超过 8000 字的修改要求。");
    const { session, baseSessionHash, baseMarkdownHashes, blocks } = await this.store.getWriteCoordinator().run(input.notebookId, input.sessionId, async () => {
      const session = await this.store.readSession(input.notebookId, input.sessionId);
      const baseSessionHash = await sha256Text(JSON.stringify(session));
      const baseMarkdownHashes: Record<string, string> = {};
      const blocks = await Promise.all(session.blocks.filter((block) => block.type === "markdown").map(async (block, index) => {
        const markdown = await this.store.readMarkdownBlock(input.notebookId, input.sessionId, block.id);
        baseMarkdownHashes[block.id] = await sha256Text(markdown);
        const locks = session.locks.filter((lock) => lock.blockId === block.id);
        return {
          blockId: block.id,
          continuationGroup: block.continuationGroup,
          title: `块 ${index + 1} · ${/^#{1,6}\s+(.+)$/m.exec(markdown)?.[1] ?? block.sourceName ?? block.id}`,
          markdown,
          locked: block.status === "locked" || locks.some((lock) => lock.kind === "block") || block.readonly === true ||
            !["user", "user_revision", "mixed", "ai_transcription"].includes(block.source),
          protected: locks.some((lock) => lock.kind === "span")
        };
      }));
      return { session, baseSessionHash, baseMarkdownHashes, blocks };
    });
    if (!blocks.length) throw new Error("当前笔记没有可修改的文本块。");
    const continuations = continuationContexts(session.blocks, new Map(blocks.map(block => [block.blockId, block.markdown])));
    const markdownContext = JSON.stringify({ title: session.title, blocks, ...(continuations.length ? { continuationInstructions, continuations } : {}) });
    if (markdownContext.length > 240_000) throw new Error("整篇内容超过当前修改上限，请分块修改；未截断笔记发送。");
    const provider = await this.createProvider();
    const result = await provider.assist({ intent: "session_edit", mode: "explain", markdownContext, imagePaths: [],
      question: instruction, sessionId: input.sessionId, abortSignal: input.abortSignal });
    input.abortSignal?.throwIfAborted();
    const candidate = parseSessionRevisionResponse(result.markdown);
    const changes: SessionAiRevision["changes"] = [];
    const skipped = new Map<string, SessionAiRevision["lockedSuggestions"][number]>();
    for (const update of candidate.changes) {
      const block = blocks.find((item) => item.blockId === update.blockId);
      if (!block) throw new Error("AI 返回了不存在的块，未应用任何内容。");
      if (update.markdown === block.markdown) continue;
      const validation = await validateAiMarkdownUpdate({ blockId: block.blockId, beforeMarkdown: block.markdown,
        afterMarkdown: update.markdown, locks: session.locks });
      if (block.locked || !validation.ok) {
        skipped.set(block.blockId, { blockId: block.blockId, title: block.title, suggestion: update.summary });
      } else {
        changes.push({ ...update, title: block.title, before: block.markdown });
      }
    }
    for (const suggestion of candidate.lockedSuggestions) {
      const block = blocks.find((item) => item.blockId === suggestion.blockId);
      if (!block || (!block.locked && !block.protected)) throw new Error("AI 的锁定说明与笔记不符，请重新生成。");
      skipped.set(block.blockId, { ...suggestion, title: block.title });
    }
    const proposal: StoredRevision = { id: `session_${randomUUID()}`, notebookId: input.notebookId, sessionId: input.sessionId, instruction, baseSessionHash,
      baseMarkdownHashes, summary: candidate.summary, status: "proposed", changes,
      lockedSuggestions: [...skipped.values()], createdAt: new Date().toISOString() };
    await this.write(proposal);
    return publicProposal(proposal);
  }

  apply(input: Target & { proposalId: string }): Promise<SessionAiRevision> {
    // A short root transaction lets the existing block and remark writers reuse
    // the barrier while keeping catalog moves out of the entire final commit.
    return this.store.getWriteCoordinator().runWorkspace(async () => {
      this.path(input);
      await this.store.readSession(input.notebookId, input.sessionId);
      const proposal = await this.read(input);
      if (proposal.status !== "proposed") throw new Error("这份修改候选已经处理过。");
      await this.store.applySessionAiRevision({ ...input, baseSessionHash: proposal.baseSessionHash,
        baseMarkdownHashes: proposal.baseMarkdownHashes,
        updates: proposal.changes.map(({ blockId, markdown }) => ({ blockId, markdown })), now: new Date().toISOString() });
      proposal.status = "applied";
      try { await this.write(proposal); }
      catch { proposal.reportWarning = "正文修改已保存，但修改记录状态暂未写入；不会重复应用同一份候选。"; }
      try {
        const now = new Date().toISOString();
        await new AssistantRemarkStore(this.store).append({ ...input, remark: {
          id: proposal.id, mode: "summarize", focus: { kind: "session", label: "整篇修改记录" },
          question: proposal.instruction, providerName: "AI 全文修改", sourceBlockIds: proposal.changes.map((item) => item.blockId),
          createdAt: now, updatedAt: now,
          markdown: [`已应用 ${proposal.changes.length} 个块的修改。`, "", ...proposal.changes.map((item) => `- **${item.title}**：${item.summary}`),
            ...(proposal.lockedSuggestions.length ? ["", "### 因为以下块已被锁定，未能进行更改", "", ...proposal.lockedSuggestions.map((item) => `- **${item.title}**：${item.suggestion}`)] : [])].join("\n")
        } });
      } catch {
        proposal.reportWarning = "正文修改已保存，但对话记录暂未写入；当前修改总结仍可查看。";
      }
      return publicProposal(proposal);
    });
  }

  cancel(input: Target & { proposalId: string }): Promise<SessionAiRevision> {
    return this.store.getWriteCoordinator().runWorkspace(async () => {
      this.path(input);
      await this.store.readSession(input.notebookId, input.sessionId);
      const proposal = await this.read(input);
      if (proposal.status === "proposed") { proposal.status = "cancelled"; await this.write(proposal); }
      return publicProposal(proposal);
    });
  }

  private path(input: Target & { proposalId: string }): string {
    validateReplicaId(input.notebookId); validateReplicaId(input.sessionId);
    if (!/^session_[0-9a-f-]{36}$/.test(input.proposalId)) throw new Error("invalid_proposal");
    return join(this.store.getSessionDir(input.notebookId, input.sessionId), ".mathnotes", "session-revisions", `${input.proposalId}.json`);
  }
  private async read(input: Target & { proposalId: string }): Promise<StoredRevision> {
    const proposal = JSON.parse(await readFile(this.path(input), "utf8")) as StoredRevision;
    if (proposal.id !== input.proposalId || proposal.notebookId !== input.notebookId || proposal.sessionId !== input.sessionId) throw new Error("invalid_proposal");
    return proposal;
  }
  private async write(proposal: StoredRevision): Promise<void> {
    const path = this.path({ ...proposal, proposalId: proposal.id });
    await this.store.getWriteCoordinator().run(proposal.notebookId, proposal.sessionId, async () => {
      // The model can finish after this Session was moved to trash. Never let a
      // late proposal, cancellation or summary recreate its former directory.
      await this.store.readSession(proposal.notebookId, proposal.sessionId);
      await mkdir(join(this.store.getSessionDir(proposal.notebookId, proposal.sessionId), ".mathnotes", "session-revisions"), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(proposal, null, 2), "utf8");
      await rename(temporary, path);
    });
  }
}

function publicProposal({ baseSessionHash: _hash, baseMarkdownHashes: _hashes, ...proposal }: StoredRevision): SessionAiRevision {
  return proposal;
}

export function parseSessionRevisionResponse(markdown: string): Pick<SessionAiRevision, "summary" | "lockedSuggestions"> & {
  changes: Array<{ blockId: string; markdown: string; summary: string }>;
} {
  if (markdown.length > 1_000_000) throw new Error("AI 返回内容过长，未应用任何修改。");
  let value: unknown;
  try { value = JSON.parse(markdown.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/i, "$1")); }
  catch { throw new Error("AI 没有返回有效的逐块修改，请重新生成。原文未变。"); }
  const data = value as Record<string, unknown>;
  if (!data || typeof data.summary !== "string" || !Array.isArray(data.changes) || !Array.isArray(data.lockedSuggestions)) throw new Error("AI 修改格式不完整。");
  const ids = new Set<string>();
  for (const change of data.changes) {
    if (!change || typeof change.blockId !== "string" || typeof change.markdown !== "string" || !change.markdown.trim() ||
      typeof change.summary !== "string" || !change.summary.trim() || ids.has(change.blockId)) throw new Error("AI 修改包含重复或无效的块。");
    ids.add(change.blockId);
  }
  for (const item of data.lockedSuggestions) {
    if (!item || typeof item.blockId !== "string" || typeof item.suggestion !== "string" || !item.suggestion.trim()) throw new Error("AI 锁定说明格式无效。");
  }
  return data as ReturnType<typeof parseSessionRevisionResponse>;
}

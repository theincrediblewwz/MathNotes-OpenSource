import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantProvider, SessionRecord } from "@mathnotes/shared";
import { readReadonlySessionBlock, readReadonlySessionManifest } from "./sessionReadService";
import { validateLockedContent } from "./sessionEditService";
import { markdownBlockRevision, sessionManifestRevision } from "./sessionRevision";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { safeReplicaPath } from "../sync/workspaceSyncService";

export type RewriteScope = { notebookId: string; sessionId: string };
export type RewriteChange = { blockId: string; title: string; beforeMarkdown: string; markdown: string; reason: string };
export type RewriteSuggestion = { blockId: string; title: string; reason: string };
export type SessionRewriteProposal = RewriteScope & {
  version: 1; id: string; instruction: string; blockId?: string;
  status: "proposed" | "applied" | "cancelled";
  summary: string; changes: RewriteChange[]; lockedSuggestions: RewriteSuggestion[];
  baseManifestRevision: string; baseRevisions: Record<string, string>;
  providerName: string; createdAt: string; updatedAt: string;
};
export class SessionRewriteError extends Error {
  constructor(readonly code: "instruction_required" | "assistant_unavailable" | "invalid_rewrite_response" |
    "rewrite_too_large" | "proposal_not_found" | "proposal_not_pending" | "revision_conflict" | "block_not_found",
    readonly statusCode: number) { super(code); }
}

export class SessionRewriteService {
  constructor(private readonly rootDir: string, private readonly createProvider: () => Promise<AssistantProvider>,
    private readonly writes: SessionWriteCoordinator, private readonly now = () => new Date().toISOString()) {}

  async propose(input: RewriteScope & { instruction: string; blockId?: string; abortSignal?: AbortSignal }): Promise<SessionRewriteProposal> {
    if (!input.instruction.trim()) throw new SessionRewriteError("instruction_required", 400);
    const snapshot = await this.writes.run(input.notebookId, input.sessionId, async () => {
      const sessionPath = await this.sessionPath(input);
      const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
      for (const block of session.blocks) await safeReplicaPath(dirname(sessionPath), block.path, false);
      const manifest = await readReadonlySessionManifest({ rootDir: this.rootDir, ...input });
      const blocks = await Promise.all(manifest.blocks.filter(block => block.type === "markdown").map(block =>
        readReadonlySessionBlock({ rootDir: this.rootDir, ...input, blockId: block.id })));
      return { manifest, blocks, storedBlocks: session.blocks, locks: session.locks };
    });
    if (input.blockId && !snapshot.blocks.some(block => block.block.id === input.blockId)) {
      throw new SessionRewriteError("block_not_found", 404);
    }
    const context = snapshot.blocks.map(block => {
      if (block.content.kind !== "markdown") throw new SessionRewriteError("invalid_rewrite_response", 422);
      return { blockId: block.block.id, title: `${block.block.order + 1}. ${block.block.sourceName}`,
        locked: block.content.blockLocked || block.block.status === "locked" ||
          snapshot.storedBlocks.find(candidate => candidate.id === block.block.id)?.readonly === true,
        target: !input.blockId || block.block.id === input.blockId,
        continuationGroup: block.block.continuationGroup, markdown: block.content.markdown };
    });
    const markdownContext = JSON.stringify({ title: snapshot.manifest.title, blocks: context });
    // No silent truncation: a whole-session rewrite must consider the whole session.
    if (Buffer.byteLength(markdownContext) > 2 * 1024 * 1024) throw new SessionRewriteError("rewrite_too_large", 413);
    let provider: AssistantProvider;
    try { provider = await this.createProvider(); } catch { throw new SessionRewriteError("assistant_unavailable", 503); }
    const result = await provider.assist({ intent: "session_rewrite", mode: "explain", markdownContext,
      imagePaths: [], question: input.instruction.trim(), sessionId: input.sessionId, abortSignal: input.abortSignal });
    input.abortSignal?.throwIfAborted();
    const answer = parseAnswer(result.markdown);
    const changes: RewriteChange[] = []; const suggestions = new Map<string, RewriteSuggestion>();
    const seen = new Set<string>();
    for (const candidate of answer.changes) {
      const before = context.find(block => block.blockId === candidate.blockId);
      if (!before || !before.target || seen.has(candidate.blockId)) throw new SessionRewriteError("invalid_rewrite_response", 422);
      seen.add(candidate.blockId);
      if (candidate.markdown === before.markdown) continue;
      if (before.locked) { suggestions.set(before.blockId, { blockId: before.blockId, title: before.title, reason: candidate.reason }); continue; }
      // Old inline span locks are protected too. New full-block locks never reach this branch.
      try {
        await validateLockedContent({ beforeMarkdown: before.markdown, afterMarkdown: candidate.markdown,
          locks: snapshot.locks.filter(lock => lock.blockId === before.blockId && lock.kind === "span") });
      } catch {
        suggestions.set(before.blockId, { blockId: before.blockId, title: before.title,
          reason: `此块包含固定选区，未执行：${candidate.reason}` });
        continue;
      }
      changes.push({ ...candidate, title: before.title, beforeMarkdown: before.markdown });
    }
    for (const suggestion of answer.lockedSuggestions) {
      const before = context.find(block => block.blockId === suggestion.blockId);
      if (!before || !before.target || !before.locked) throw new SessionRewriteError("invalid_rewrite_response", 422);
      suggestions.set(before.blockId, { ...suggestion, title: before.title });
    }
    const timestamp = this.now();
    const proposal: SessionRewriteProposal = { version: 1, id: `rewrite_${randomUUID()}`,
      notebookId: input.notebookId, sessionId: input.sessionId, blockId: input.blockId,
      instruction: input.instruction.trim(), status: "proposed", summary: answer.summary,
      changes, lockedSuggestions: [...suggestions.values()], baseManifestRevision: snapshot.manifest.revision,
      baseRevisions: Object.fromEntries(snapshot.blocks.map(block => [block.block.id,
        block.content.kind === "markdown" ? block.content.baseRevision : ""])),
      providerName: provider.name, createdAt: timestamp, updatedAt: timestamp };
    await this.writeProposal(proposal);
    return proposal;
  }

  async apply(input: RewriteScope & { proposalId: string }): Promise<SessionRewriteProposal> {
    return this.writes.run(input.notebookId, input.sessionId, async () => {
      const proposal = await this.readProposal(input);
      if (proposal.status === "applied") return proposal;
      if (proposal.status !== "proposed") throw new SessionRewriteError("proposal_not_pending", 409);
      const sessionPath = await this.sessionPath(input); const sessionDir = dirname(sessionPath);
      const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord & { rewriteOperations?: Record<string, string> };
      const committedAt = session.rewriteOperations?.[proposal.id];
      if (committedAt) {
        const recovered = { ...proposal, status: "applied" as const, updatedAt: committedAt };
        await this.writeProposal(recovered); return recovered;
      }
      if (sessionManifestRevision(session) !== proposal.baseManifestRevision) throw new SessionRewriteError("revision_conflict", 409);
      // Validate every context block, including skipped fixed blocks, before writing any candidate.
      for (const [blockId, expected] of Object.entries(proposal.baseRevisions)) {
        const block = session.blocks.find(block => block.id === blockId);
        if (!block || block.type !== "markdown") throw new SessionRewriteError("revision_conflict", 409);
        const markdown = await readFile(await safeReplicaPath(sessionDir, block.path, false), "utf8");
        const locks = session.locks.filter(lock => lock.blockId === blockId);
        if (markdownBlockRevision({ block, markdown, locks }) !== expected) throw new SessionRewriteError("revision_conflict", 409);
      }
      for (const change of proposal.changes) {
        const block = session.blocks.find(block => block.id === change.blockId)!;
        if (block.readonly || block.status === "locked") throw new SessionRewriteError("revision_conflict", 409);
        await validateLockedContent({ beforeMarkdown: change.beforeMarkdown, afterMarkdown: change.markdown,
          locks: session.locks.filter(lock => lock.blockId === block.id) });
      }
      const timestamp = this.now();
      for (const [index, change] of proposal.changes.entries()) {
        const block = session.blocks.find(block => block.id === change.blockId)!;
        const path = `blocks/${proposal.id}_${index}.md`;
        await writeAtomic(await safeReplicaPath(sessionDir, path, true), change.markdown);
        block.path = path; block.updatedAt = timestamp;
      }
      session.updatedAt = timestamp;
      session.rewriteOperations = Object.fromEntries([...Object.entries(session.rewriteOperations ?? {}).slice(-1023), [proposal.id, timestamp]]);
      await writeAtomic(sessionPath, JSON.stringify(session, null, 2) + "\n");
      const applied: SessionRewriteProposal = { ...proposal, status: "applied", updatedAt: timestamp };
      await this.writeProposal(applied);
      return applied;
    });
  }

  async cancel(input: RewriteScope & { proposalId: string }): Promise<SessionRewriteProposal> {
    return this.writes.run(input.notebookId, input.sessionId, async () => {
      const proposal = await this.readProposal(input);
      if (proposal.status !== "proposed") throw new SessionRewriteError("proposal_not_pending", 409);
      const session = JSON.parse(await readFile(await this.sessionPath(input), "utf8"));
      if (session.rewriteOperations?.[proposal.id]) throw new SessionRewriteError("proposal_not_pending", 409);
      const cancelled = { ...proposal, status: "cancelled" as const, updatedAt: this.now() };
      await this.writeProposal(cancelled); return cancelled;
    });
  }

  async list(input: RewriteScope): Promise<SessionRewriteProposal[]> {
    const directory = await safeReplicaPath(dirname(await this.sessionPath(input)), ".mathnotes/rewrites", true);
    let names: string[];
    try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: SessionRewriteProposal[] = [];
    for (const name of names.filter(name => /^rewrite_[0-9a-f-]{36}\.json$/.test(name))) {
      records.push(await this.readProposal({ ...input, proposalId: name.slice(0, -5) }));
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async sessionPath(input: RewriteScope): Promise<string> {
    if (![input.notebookId, input.sessionId].every(id => typeof id === "string" && id.length > 0 && id.length <= 200 && id !== "." && id !== ".." && !/[\\/\x00-\x1f]/.test(id))) throw new SessionRewriteError("proposal_not_found", 404);
    return safeReplicaPath(this.rootDir, `notebooks/${input.notebookId}/sessions/${input.sessionId}/session.json`, false);
  }
  private async proposalPath(input: RewriteScope & { proposalId: string }): Promise<string> {
    if (!/^rewrite_[0-9a-f-]{36}$/.test(input.proposalId)) throw new SessionRewriteError("proposal_not_found", 404);
    return safeReplicaPath(dirname(await this.sessionPath(input)), `.mathnotes/rewrites/${input.proposalId}.json`, true);
  }
  private async readProposal(input: RewriteScope & { proposalId: string }): Promise<SessionRewriteProposal> {
    try {
      const proposal = JSON.parse(await readFile(await this.proposalPath(input), "utf8")) as SessionRewriteProposal;
      if (proposal.id !== input.proposalId || proposal.notebookId !== input.notebookId || proposal.sessionId !== input.sessionId ||
        proposal.version !== 1 || !["proposed", "applied", "cancelled"].includes(proposal.status)) throw new Error("invalid proposal");
      return proposal;
    } catch { throw new SessionRewriteError("proposal_not_found", 404); }
  }
  private async writeProposal(proposal: SessionRewriteProposal) {
    await writeAtomic(await this.proposalPath({ ...proposal, proposalId: proposal.id }), JSON.stringify(proposal, null, 2) + "\n");
  }
}

function parseAnswer(markdown: string): { summary: string; changes: Array<{ blockId: string; markdown: string; reason: string }>; lockedSuggestions: Array<{ blockId: string; reason: string }> } {
  if (Buffer.byteLength(markdown) > 4 * 1024 * 1024) throw new SessionRewriteError("rewrite_too_large", 413);
  try {
    const data = JSON.parse(markdown.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"));
    if (!data || typeof data.summary !== "string" || !Array.isArray(data.changes) || !Array.isArray(data.lockedSuggestions)) throw new Error();
    if (data.summary.length > 8000 || data.changes.length > 10000 || data.lockedSuggestions.length > 10000) throw new Error();
    for (const entry of [...data.changes, ...data.lockedSuggestions]) {
      if (!entry || typeof entry.blockId !== "string" || typeof entry.reason !== "string" || !entry.reason.trim() || entry.reason.length > 8000) throw new Error();
    }
    if (data.changes.some((entry: { markdown?: unknown }) => typeof entry.markdown !== "string")) throw new Error();
    return data;
  } catch { throw new SessionRewriteError("invalid_rewrite_response", 422); }
}
async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

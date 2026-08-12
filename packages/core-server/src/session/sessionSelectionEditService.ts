import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  applySelectionEdit,
  type AssistantProvider,
  type AssistantProviderEvent,
  type TextSelection
} from "@mathnotes/shared";
import { SessionEditService, type SaveMarkdownBlockResult } from "./sessionEditService";
import { readReadonlySessionBlock } from "./sessionReadService";

export type SelectionEditProposalStatus = "proposed" | "applied" | "cancelled";

export type SelectionEditProposal = Readonly<{
  version: 1;
  id: string;
  notebookId: string;
  sessionId: string;
  blockId: string;
  baseRevision: string;
  selection: TextSelection;
  instruction: string;
  replacementMarkdown: string;
  providerName: string;
  status: SelectionEditProposalStatus;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}>;

export type ProposeSelectionEditInput = Readonly<{
  notebookId: string;
  sessionId: string;
  blockId: string;
  selection: TextSelection;
  instruction: string;
  abortSignal?: AbortSignal;
  onProviderEvent?: (event: AssistantProviderEvent) => void;
}>;

export class SessionSelectionEditError extends Error {
  constructor(
    readonly code:
      | "not_markdown_block"
      | "block_not_editable"
      | "block_locked"
      | "invalid_selection"
      | "selection_stale"
      | "protected_selection"
      | "instruction_required"
      | "assistant_unavailable"
      | "empty_replacement"
      | "proposal_not_found"
      | "proposal_not_pending",
    readonly statusCode: number
  ) {
    super(code);
    this.name = "SessionSelectionEditError";
  }
}

export class SessionSelectionEditService {
  constructor(
    private readonly rootDir: string,
    private readonly createProvider: () => Promise<AssistantProvider>,
    private readonly editor: SessionEditService,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async propose(input: ProposeSelectionEditInput): Promise<SelectionEditProposal> {
    const instruction = input.instruction.trim();
    if (!instruction) throw new SessionSelectionEditError("instruction_required", 400);
    const block = await readReadonlySessionBlock({ rootDir: this.rootDir, ...input });
    if (block.content.kind !== "markdown") throw new SessionSelectionEditError("not_markdown_block", 422);
    if (!block.block.editable) {
      throw new SessionSelectionEditError(
        block.content.blockLocked || block.block.status === "locked" ? "block_locked" : "block_not_editable",
        423
      );
    }
    const validation = applySelectionEdit({
      markdown: block.content.markdown,
      selection: input.selection,
      replacement: input.selection.selectedText
    });
    if (!validation.ok) throw selectionValidationError(validation.reason);

    let provider: AssistantProvider;
    try {
      provider = await this.createProvider();
    } catch {
      throw new SessionSelectionEditError("assistant_unavailable", 503);
    }
    const markdownContext = [
      `block: ${input.blockId}`,
      `selection_utf16: ${input.selection.from}..${input.selection.to}`,
      "",
      "--- 完整块开始 ---",
      block.content.markdown,
      "--- 完整块结束 ---",
      "",
      "--- 精确选区开始 ---",
      input.selection.selectedText,
      "--- 精确选区结束 ---"
    ].join("\n");
    const providerInput = {
      intent: "selection_edit" as const,
      mode: "explain" as const,
      markdownContext,
      imagePaths: [],
      question: instruction,
      sessionId: input.sessionId,
      abortSignal: input.abortSignal
    };
    const result = provider.assistWithEvents
      ? await provider.assistWithEvents({ ...providerInput, onEvent: input.onProviderEvent ?? (() => undefined) })
      : await provider.assist(providerInput);
    input.abortSignal?.throwIfAborted();
    const replacementMarkdown = normalizeReplacement(result.markdown);
    if (!replacementMarkdown) throw new SessionSelectionEditError("empty_replacement", 422);

    const timestamp = this.now();
    const proposal: SelectionEditProposal = {
      version: 1,
      id: `selection_${randomUUID()}`,
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      blockId: input.blockId,
      baseRevision: block.content.baseRevision,
      selection: input.selection,
      instruction,
      replacementMarkdown,
      providerName: provider.name,
      status: "proposed",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await writeAtomic(this.proposalPath(proposal), `${JSON.stringify(proposal, null, 2)}\n`);
    return proposal;
  }

  async apply(input: {
    notebookId: string;
    sessionId: string;
    proposalId: string;
  }): Promise<Readonly<{ version: 1; applied: true; proposal: SelectionEditProposal; result: SaveMarkdownBlockResult }>> {
    const proposal = await this.read(input);
    if (proposal.status !== "proposed") throw new SessionSelectionEditError("proposal_not_pending", 409);
    const result = await this.editor.applySelectionEdit({
      notebookId: proposal.notebookId,
      sessionId: proposal.sessionId,
      blockId: proposal.blockId,
      baseRevision: proposal.baseRevision,
      selection: proposal.selection,
      replacement: proposal.replacementMarkdown
    });
    const appliedAt = this.now();
    const applied: SelectionEditProposal = {
      ...proposal,
      status: "applied",
      appliedAt,
      updatedAt: appliedAt
    };
    await writeAtomic(this.proposalPath(applied), `${JSON.stringify(applied, null, 2)}\n`);
    return { version: 1, applied: true, proposal: applied, result };
  }

  async cancel(input: {
    notebookId: string;
    sessionId: string;
    proposalId: string;
  }): Promise<SelectionEditProposal> {
    const proposal = await this.read(input);
    if (proposal.status !== "proposed") throw new SessionSelectionEditError("proposal_not_pending", 409);
    const timestamp = this.now();
    const cancelled: SelectionEditProposal = { ...proposal, status: "cancelled", updatedAt: timestamp };
    await writeAtomic(this.proposalPath(cancelled), `${JSON.stringify(cancelled, null, 2)}\n`);
    return cancelled;
  }

  private async read(input: { notebookId: string; sessionId: string; proposalId: string }): Promise<SelectionEditProposal> {
    if (!/^selection_[0-9a-f-]{36}$/.test(input.proposalId)) {
      throw new SessionSelectionEditError("proposal_not_found", 404);
    }
    const stub = { notebookId: input.notebookId, sessionId: input.sessionId, id: input.proposalId };
    const path = this.proposalPath(stub);
    try {
      const proposal = JSON.parse(await readFile(path, "utf8")) as SelectionEditProposal;
      if (!isProposal(proposal, input)) throw new SessionSelectionEditError("proposal_not_found", 404);
      return proposal;
    } catch (error) {
      if (error instanceof SessionSelectionEditError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionSelectionEditError("proposal_not_found", 404);
      }
      throw error;
    }
  }

  private proposalPath(input: { notebookId: string; sessionId: string; id: string }): string {
    const sessionsRoot = resolve(this.rootDir, "notebooks");
    const path = resolve(
      sessionsRoot,
      input.notebookId,
      "sessions",
      input.sessionId,
      ".mathnotes",
      "selection-edits",
      `${input.id}.json`
    );
    if (!path.startsWith(`${sessionsRoot}${sep}`)) throw new SessionSelectionEditError("proposal_not_found", 404);
    return path;
  }
}

function selectionValidationError(reason: "invalid_range" | "selection_stale" | "protected_selection") {
  if (reason === "invalid_range") return new SessionSelectionEditError("invalid_selection", 422);
  if (reason === "selection_stale") return new SessionSelectionEditError("selection_stale", 409);
  return new SessionSelectionEditError("protected_selection", 423);
}

function normalizeReplacement(markdown: string): string {
  const trimmed = markdown.trim();
  const fenced = /^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function isProposal(
  proposal: SelectionEditProposal,
  expected: { notebookId: string; sessionId: string; proposalId: string }
): boolean {
  return proposal?.version === 1 && proposal.id === expected.proposalId &&
    proposal.notebookId === expected.notebookId && proposal.sessionId === expected.sessionId &&
    typeof proposal.blockId === "string" && /^[a-f0-9]{64}$/.test(proposal.baseRevision) &&
    ["proposed", "applied", "cancelled"].includes(proposal.status);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

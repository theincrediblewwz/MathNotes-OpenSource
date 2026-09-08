import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceNotebook, createWorkspaceSession } from "../catalog/workspaceCommandService";
import { SessionEditService } from "./sessionEditService";
import { readReadonlySessionBlock, readReadonlySessionManifest } from "./sessionReadService";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";
import { SessionRewriteService } from "./sessionRewriteService";

describe("reviewable full-session rewrites", () => {
  let root: string; let scope: { notebookId: string; sessionId: string }; let writes: SessionWriteCoordinator;
  let editor: SessionEditService; let response: unknown; let captured: any;
  const service = () => new SessionRewriteService(root, async () => ({ name: "synthetic-no-paid-ai", async assist(input) {
    captured = input; return { markdown: typeof response === "string" ? response : JSON.stringify(response) };
  } }), writes);
  const read = async (blockId: string) => {
    const block = await readReadonlySessionBlock({ rootDir: root, ...scope, blockId });
    if (block.content.kind !== "markdown") throw new Error("fixture"); return block.content;
  };
  const edit = async (blockId: string, markdown: string) => editor.saveMarkdownBlock({ ...scope, blockId, markdown, baseRevision: (await read(blockId)).baseRevision });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-rewrite-")); writes = new SessionWriteCoordinator();
    const notebook = await createWorkspaceNotebook({ rootDir: root, title: "中文验收 Notebook" });
    const session = await createWorkspaceSession({ rootDir: root, notebookId: notebook.notebookId, title: "中文验收 Session" });
    scope = { notebookId: notebook.notebookId, sessionId: session.sessionId };
    editor = new SessionEditService(root, undefined, writes);
    await edit("0001", "Original A");
    await editor.appendMarkdownBlock({ ...scope, markdown: "Original fixed", sourceName: "Fixed theorem" });
    await editor.appendMarkdownBlock({ ...scope, markdown: "Original C" });
    await editor.setMarkdownBlockLock({ ...scope, blockId: "0002", locked: true });
    response = { summary: "Clarify two paragraphs", changes: [
      { blockId: "0001", markdown: "Revised A", reason: "Clarify definition" },
      { blockId: "0003", markdown: "Revised C", reason: "Clarify conclusion" }
    ], lockedSuggestions: [{ blockId: "0002", reason: "Would clarify theorem assumptions" }] };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("reviews all blocks, persists candidates, applies only unlocked changes, and retains originals", async () => {
    const proposal = await service().propose({ ...scope, instruction: "Clarify the whole session" });
    expect(captured.intent).toBe("session_rewrite");
    expect(JSON.parse(captured.markdownContext).blocks).toHaveLength(3);
    expect(proposal.changes).toHaveLength(2); expect(proposal.lockedSuggestions[0].blockId).toBe("0002");
    expect((await read("0001")).markdown).toBe("Original A");
    const before = JSON.parse(await readFile(join(root, `notebooks/${scope.notebookId}/sessions/${scope.sessionId}/session.json`), "utf8"));
    const applied = await service().apply({ ...scope, proposalId: proposal.id });
    expect(applied.status).toBe("applied");
    expect((await read("0001")).markdown).toBe("Revised A");
    expect((await read("0002")).markdown).toBe("Original fixed");
    expect((await read("0003")).markdown).toBe("Revised C");
    expect(await readFile(join(root, `notebooks/${scope.notebookId}/sessions/${scope.sessionId}`, before.blocks[0].path), "utf8")).toBe("Original A");
    expect((await service().list(scope))[0].changes[0].reason).toBe("Clarify definition");
    expect(await service().apply({ ...scope, proposalId: proposal.id })).toEqual(applied);
  });
  it("allows explicit rewriting of an unlocked AI explanation block", async () => {
    const path = join(root, `notebooks/${scope.notebookId}/sessions/${scope.sessionId}/session.json`);
    const session = JSON.parse(await readFile(path, "utf8"));
    session.blocks[0].source = "ai_explanation";
    await writeFile(path, JSON.stringify(session));
    const proposal = await service().propose({ ...scope, instruction: "Revise explanations too" });
    expect(proposal.changes.some(change => change.blockId === "0001")).toBe(true);
    await service().apply({ ...scope, proposalId: proposal.id });
    expect((await read("0001")).markdown).toBe("Revised A");
  });

  it("protects a fixed block even when the model incorrectly puts it in changes", async () => {
    response = { summary: "Incorrectly attempts fixed text", changes: [
      { blockId: "0002", markdown: "Must not write", reason: "Wanted to rewrite fixed theorem" }
    ], lockedSuggestions: [] };
    const proposal = await service().propose({ ...scope, instruction: "Revise" });
    expect(proposal.changes).toEqual([]);
    expect(proposal.lockedSuggestions).toMatchObject([{ blockId: "0002", reason: "Wanted to rewrite fixed theorem" }]);
    await service().apply({ ...scope, proposalId: proposal.id });
    expect((await read("0002")).markdown).toBe("Original fixed");
  });
  it("rejects a stale late block before writing any earlier candidate", async () => {
    const proposal = await service().propose({ ...scope, instruction: "Revise" });
    await edit("0003", "Concurrent user edit");
    await expect(service().apply({ ...scope, proposalId: proposal.id })).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await read("0001")).markdown).toBe("Original A");
    expect((await read("0003")).markdown).toBe("Concurrent user edit");
  });
  it("rejects a newly fixed target and preserves every block", async () => {
    const proposal = await service().propose({ ...scope, instruction: "Revise" });
    await editor.setMarkdownBlockLock({ ...scope, blockId: "0003", locked: true });
    await expect(service().apply({ ...scope, proposalId: proposal.id })).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await read("0001")).markdown).toBe("Original A");
  });
  it("recovers after the atomic content commit but before the proposal status was saved", async () => {
    const proposal = await service().propose({ ...scope, instruction: "Revise" });
    await service().apply({ ...scope, proposalId: proposal.id });
    const revision = (await readReadonlySessionManifest({ rootDir: root, ...scope })).revision;
    await writeFile(join(root, `notebooks/${scope.notebookId}/sessions/${scope.sessionId}/.mathnotes/rewrites/${proposal.id}.json`), JSON.stringify(proposal));
    expect((await service().apply({ ...scope, proposalId: proposal.id })).status).toBe("applied");
    expect((await readReadonlySessionManifest({ rootDir: root, ...scope })).revision).toBe(revision);
  });
  it("does not apply a cancelled proposal", async () => {
    const proposal = await service().propose({ ...scope, instruction: "Revise" });
    await service().cancel({ ...scope, proposalId: proposal.id });
    await expect(service().apply({ ...scope, proposalId: proposal.id })).rejects.toMatchObject({ code: "proposal_not_pending" });
    expect((await read("0001")).markdown).toBe("Original A");
  });
  it("rejects fabricated block IDs, malformed responses and changes outside the requested block", async () => {
    response = "not JSON";
    await expect(service().propose({ ...scope, instruction: "Revise" })).rejects.toMatchObject({ code: "invalid_rewrite_response" });
    response = { summary: "invalid", changes: [{ blockId: "missing", markdown: "X", reason: "bad" }], lockedSuggestions: [] };
    await expect(service().propose({ ...scope, instruction: "Revise" })).rejects.toMatchObject({ code: "invalid_rewrite_response" });
    response = { summary: "invalid target", changes: [{ blockId: "0003", markdown: "X", reason: "wrong scope" }], lockedSuggestions: [] };
    await expect(service().propose({ ...scope, blockId: "0001", instruction: "Only this block" })).rejects.toMatchObject({ code: "invalid_rewrite_response" });
  });
});

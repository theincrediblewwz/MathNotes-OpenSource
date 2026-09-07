import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockStore } from "./blockStore";
import { SessionAiRevisionService, parseSessionRevisionResponse } from "./sessionAiRevision";
import { wrapProtectedSpan } from "../common/lockSpan";
import { SessionBlockOrganizeService, SessionEditService } from "@mathnotes/core-server";

describe("whole Session AI revision", () => {
  let root: string;
  let store: BlockStore;
  const target = { notebookId: "book", sessionId: "lesson" };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-session-revision-"));
    store = new BlockStore(root);
    await store.createSession({ ...target, title: "中文课程", now: "2026-09-07T00:00:00Z" });
    for (const markdown of ["# 第一块\n原句", "# 第二块\n保留", "# 第三块\n说明"]) {
      await store.appendMarkdownBlock({ ...target, source: "user", markdown, now: "2026-09-07T00:00:00Z" });
    }
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  function service(changes: Array<{ blockId: string; markdown: string; summary: string }>, lockedSuggestions: Array<{ blockId: string; suggestion: string }> = []) {
    return new SessionAiRevisionService(store, async () => ({ name: "fixture", async assist(input) {
      expect(input.intent).toBe("session_edit");
      expect(JSON.parse(input.markdownContext).blocks).toHaveLength(3);
      expect(input.imagePaths).toEqual([]);
      return { markdown: JSON.stringify({ summary: "整理语言", changes, lockedSuggestions }) };
    } }));
  }
  it("previews all changes then applies only unlocked blocks and lists blocked intentions", async () => {
    await store.setMarkdownBlockLock({ ...target, blockId: "0002", locked: true, now: "2026-09-07T00:00:01Z" });
    const runtime = service([
      { blockId: "0001", markdown: "# 第一块\n更清楚", summary: "澄清句意" },
      { blockId: "0002", markdown: "禁止替换", summary: "想补充前提" },
      { blockId: "0003", markdown: "# 第三块\n补充理由", summary: "补充推导" }
    ]);
    const before = await store.readSession(target.notebookId, target.sessionId);
    const proposal = await runtime.propose({ ...target, instruction: "统一表述" });
    expect(proposal.changes.map((item) => item.blockId)).toEqual(["0001", "0003"]);
    expect(proposal.lockedSuggestions[0]).toMatchObject({ blockId: "0002", suggestion: "想补充前提" });
    expect(await store.readMarkdownBlock("book", "lesson", "0001")).toContain("原句");
    const applied = await runtime.apply({ ...target, proposalId: proposal.id });
    expect(applied.status).toBe("applied");
    expect(await store.readMarkdownBlock("book", "lesson", "0001")).toContain("更清楚");
    expect(await store.readMarkdownBlock("book", "lesson", "0002")).toBe("# 第二块\n保留");
    expect(await readFile(join(store.getSessionDir("book", "lesson"), before.blocks[0].path), "utf8")).toContain("原句");
    await expect(runtime.apply({ ...target, proposalId: proposal.id })).rejects.toThrow("已经处理过");
  });
  it.each(["edit", "lock", "append"])("rejects an intervening %s before writing any block", async (action) => {
    const runtime = service([{ blockId: "0001", markdown: "更改", summary: "改写" }, { blockId: "0003", markdown: "更改3", summary: "改写3" }]);
    const proposal = await runtime.propose({ ...target, instruction: "改写" });
    if (action === "edit") await store.updateMarkdownBlock({ revisionBaseline: await store.readRevisionBaseline("book", "lesson"), ...target, blockId: "0003", markdown: "用户的新内容", now: "2026-09-07T00:00:02Z" });
    if (action === "lock") await store.setMarkdownBlockLock({ ...target, blockId: "0003", locked: true, now: "2026-09-07T00:00:02Z" });
    if (action === "append") await store.appendMarkdownBlock({ ...target, source: "user", markdown: "新增", now: "2026-09-07T00:00:02Z" });
    await expect(runtime.apply({ ...target, proposalId: proposal.id })).rejects.toThrow("revision_conflict");
    expect(await store.readMarkdownBlock("book", "lesson", "0001")).toContain("原句");
  });
  it("rejects forged protected text even when AI leaves the old declared hash in place", async () => {
    const locked = await wrapProtectedSpan({ id: "span1", markdown: "不可改的定理" });
    await store.updateMarkdownBlock({ revisionBaseline: await store.readRevisionBaseline("book", "lesson"), ...target, blockId: "0001", markdown: `${locked}\n补充`, now: "2026-09-07T00:00:01Z" });
    const runtime = service([{ blockId: "0001", markdown: `${locked.replace("不可改的定理", "篡改定理")}\n补充`, summary: "想改定理" }]);
    const proposal = await runtime.propose({ ...target, instruction: "改写" });
    expect(proposal.changes).toEqual([]);
    expect(proposal.lockedSuggestions).toHaveLength(1);
    expect(await store.readMarkdownBlock("book", "lesson", "0001")).toContain("不可改的定理");
  });
  it("leaves the whole Session untouched if final manifest publication fails", async () => {
    const runtime = service([{ blockId: "0001", markdown: "更改1", summary: "改写1" }, { blockId: "0003", markdown: "更改3", summary: "改写3" }]);
    const proposal = await runtime.propose({ ...target, instruction: "改写" });
    vi.spyOn(store as unknown as { writeSession: () => Promise<void> }, "writeSession").mockRejectedValueOnce(new Error("disk failure"));
    await expect(runtime.apply({ ...target, proposalId: proposal.id })).rejects.toThrow("disk failure");
    expect(await store.readMarkdownBlock("book", "lesson", "0001")).toContain("原句");
    expect(await store.readMarkdownBlock("book", "lesson", "0003")).toContain("说明");
    await expect(runtime.apply({ ...target, proposalId: proposal.id })).resolves.toMatchObject({ status: "applied" });
  });
  it("cancels without changing notes and rejects unknown blocks or malformed responses", async () => {
    const runtime = service([{ blockId: "0001", markdown: "更改", summary: "改写" }]);
    const proposal = await runtime.propose({ ...target, instruction: "改写" });
    await runtime.cancel({ ...target, proposalId: proposal.id });
    await expect(runtime.apply({ ...target, proposalId: proposal.id })).rejects.toThrow("已经处理过");
    await expect(service([{ blockId: "missing", markdown: "更改", summary: "改写" }]).propose({ ...target, instruction: "改写" })).rejects.toThrow("不存在的块");
    expect(() => parseSessionRevisionResponse("not json")).toThrow();
    expect(() => parseSessionRevisionResponse(JSON.stringify({ summary: "x", changes: [{ blockId: "1", markdown: "x", summary: "x" }, { blockId: "1", markdown: "y", summary: "y" }], lockedSuggestions: [] }))).toThrow();
  });

  it("reports applied content honestly when saving proposal status fails and allows an idempotent retry", async () => {
    const runtime = service([{ blockId: "0001", markdown: "更改1", summary: "改写1" }]);
    const proposal = await runtime.propose({ ...target, instruction: "改写" });
    vi.spyOn(runtime as unknown as { write: () => Promise<void> }, "write").mockRejectedValueOnce(new Error("status disk failure"));
    const applied = await runtime.apply({ ...target, proposalId: proposal.id });
    expect(applied).toMatchObject({ status: "applied", reportWarning: expect.stringContaining("正文修改已保存") });
    const firstManifest = await store.readSession("book", "lesson");
    await expect(runtime.apply({ ...target, proposalId: proposal.id })).resolves.toMatchObject({ status: "applied" });
    expect(await store.readSession("book", "lesson")).toEqual(firstManifest);
  });

  it("serializes Core reordering and lock changes arriving during the AI manifest commit", async () => {
    const runtime = service([{ blockId: "0001", markdown: "更改1", summary: "改写1" }]);
    const proposal = await runtime.propose({ ...target, instruction: "改写" });
    type PrivateStore = { writeSession: (...args: unknown[]) => Promise<void> };
    const privateStore = store as unknown as PrivateStore;
    const originalWrite = privateStore.writeSession.bind(store);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(privateStore, "writeSession").mockImplementationOnce(async (...args) => { enter(); await paused; return originalWrite(...args); });
    const applying = runtime.apply({ ...target, proposalId: proposal.id });
    await entered;
    const coordinator = new BlockStore(root).getWriteCoordinator();
    const organizing = new SessionBlockOrganizeService(root, undefined, coordinator).reorder({ ...target, blockIds: ["0003"], direction: "up", targetBlockId: "0001" });
    const locking = new SessionEditService(root, undefined, coordinator).setMarkdownBlockLock({ ...target, blockId: "0001", locked: true });
    let completed = false;
    void Promise.all([organizing, locking]).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    release();
    await Promise.all([applying, organizing, locking]);
    const session = await store.readSession("book", "lesson");
    expect(session.blocks[0].id).toBe("0003");
    expect(session.blocks.find((block) => block.id === "0001")?.status).toBe("locked");
    expect(await store.readMarkdownBlock("book", "lesson", "0001")).toBe("更改1");
  });
});

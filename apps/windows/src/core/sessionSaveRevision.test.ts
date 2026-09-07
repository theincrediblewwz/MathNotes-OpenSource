import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockStore } from "./blockStore";
import { loadSessionDocumentFromStore, compactSessionDocumentForRenderer } from "./sessionDocumentStore";
import { sha256Text, wrapProtectedSpan } from "../common/lockSpan";

describe("manual save revision and transaction", () => {
  let root: string;
  let store: BlockStore;
  const target = { notebookId: "中文笔记", sessionId: "lesson" };
  const now = "2026-09-08T00:00:00Z";
  const baseline = () => store.readRevisionBaseline(target.notebookId, target.sessionId);
  const text = (id: string) => store.readMarkdownBlock(target.notebookId, target.sessionId, id);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-save-revision-"));
    store = new BlockStore(root);
    await store.createSession({ ...target, title: "合成笔记", now });
    for (const markdown of ["A\r\n\n原文🙂\n", "second"]) await store.appendMarkdownBlock({ ...target, source: "user", markdown, now });
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  it("returns a locked consistent baseline and preserves it in compact renderer responses", async () => {
    const doc = await loadSessionDocumentFromStore({ store, ...target });
    expect(doc.revisionBaseline).toBe(await baseline());
    expect(compactSessionDocumentForRenderer(doc).revisionBaseline).toBe(doc.revisionBaseline);
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const loading = loadSessionDocumentFromStore({ store, ...target, readMarkdownFile: async path => {
      entered(); await barrier; return readFile(path, "utf8");
    } });
    await enteredPromise;
    let wrote = false;
    const writing = store.getWriteCoordinator().run(target.notebookId, target.sessionId, async () => { wrote = true; });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(wrote).toBe(false);
    release(); await loading; await writing;
  });
  it("does not let a stale Windows A draft replace the committed B or accept a missing baseline", async () => {
    const a = await baseline();
    await store.updateMarkdownBlock({ ...target, revisionBaseline: a, blockId: "0001", markdown: "B from Mac", now });
    const b = await baseline();
    for (const revisionBaseline of [a, ""]) {
      await expect(store.updateMarkdownBlock({ ...target, revisionBaseline, blockId: "0001", markdown: "Windows A draft", now })).rejects.toThrow("revision_conflict");
      expect(await text("0001")).toBe("B from Mac");
      expect(await baseline()).toBe(b);
    }
  });
  it("detects metadata, locks, paths and raw line ending changes independently of updatedAt", async () => {
    const first = await baseline();
    const session = await store.readSession(target.notebookId, target.sessionId);
    await writeFile(join(store.getSessionDir(target.notebookId, target.sessionId), session.blocks[0].path), "A\n\n原文🙂\n");
    expect(await baseline()).not.toBe(first);
    const second = await baseline();
    await store.setMarkdownBlockLock({ ...target, blockId: "0002", locked: true, now });
    expect(await baseline()).not.toBe(second);
  });
  it.each(["unknown", "duplicate", "locked", "span"])("rejects %s in the second batch item without modifying the first", async kind => {
    if (kind === "locked") await store.setMarkdownBlockLock({ ...target, blockId: "0002", locked: true, now });
    if (kind === "span") await store.updateMarkdownBlock({ ...target, revisionBaseline: await baseline(), blockId: "0002", markdown: await wrapProtectedSpan({ id: "span", markdown: "must remain" }), now });
    const before = await baseline();
    await expect(store.updateMarkdownBlocks({ ...target, revisionBaseline: before, updates: [
      { blockId: "0001", markdown: "must not publish" },
      { blockId: kind === "unknown" ? "missing" : kind === "duplicate" ? "0001" : "0002", markdown: "illegal" }
    ], now })).rejects.toThrow();
    expect(await baseline()).toBe(before);
    expect(await text("0001")).toBe("A\r\n\n原文🙂\n");
  });
  it("keeps old files and one complete manifest when publication fails, then retries safely", async () => {
    const revisionBaseline = await baseline();
    const original = await store.readSession(target.notebookId, target.sessionId);
    const args = { ...target, revisionBaseline, updates: [{ blockId: "0001", markdown: "new1" }, { blockId: "0002", markdown: "new2" }], now };
    vi.spyOn(store as unknown as { writeSession: () => Promise<void> }, "writeSession").mockRejectedValueOnce(new Error("synthetic manifest failure"));
    await expect(store.updateMarkdownBlocks(args)).rejects.toThrow("synthetic manifest failure");
    expect(await baseline()).toBe(revisionBaseline);
    await store.updateMarkdownBlocks(args);
    expect(await text("0001")).toBe("new1");
    expect(await text("0002")).toBe("new2");
    expect(await readFile(join(store.getSessionDir(target.notebookId, target.sessionId), original.blocks[0].path), "utf8")).toBe("A\r\n\n原文🙂\n");
  });
  it("serializes two stores sharing the same root so only one writer wins the same baseline", async () => {
    const other = new BlockStore(root);
    const revisionBaseline = await baseline();
    const results = await Promise.allSettled([store, other].map((writer, i) => writer.updateMarkdownBlock({ ...target, revisionBaseline, blockId: "0001", markdown: `writer ${i}`, now })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it.skipIf(process.platform !== "win32")("serializes Windows case aliases across runMany and normal saves", async () => {
    const revisionBaseline = await baseline();
    const mixedTarget = { notebookId: target.notebookId, sessionId: "LESSON" };
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const held = new BlockStore(root.toUpperCase()).getWriteCoordinator().runMany([mixedTarget], async () => { entered(); await barrier; });
    await enteredPromise;
    let settled = false;
    const saving = store.updateMarkdownBlock({ ...target, revisionBaseline, blockId: "0001", markdown: "after barrier", now }).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(settled).toBe(false);
    release(); await held; await saving;
    expect(await text("0001")).toBe("after barrier");
  });
  it("allows only a separate explicit span unlock and keeps its original protected text", async () => {
    const protectedText = await wrapProtectedSpan({ id: "legacy", markdown: "公式 $x+y$ 🙂" });
    const marked = `before\n${protectedText}\nafter`;
    await store.updateMarkdownBlock({ ...target, revisionBaseline: await baseline(), blockId: "0001", markdown: marked, now });
    const revisionBaseline = await baseline();
    await expect(store.updateMarkdownBlock({ ...target, revisionBaseline, blockId: "0001", markdown: "before\n公式 $x+y$ 🙂\nafter", now })).rejects.toThrow("protected_span_changed");
    await store.unlockProtectedSpan({ ...target, revisionBaseline, blockId: "0001", spanId: "legacy", now });
    expect(await text("0001")).toBe("before\n公式 $x+y$ 🙂\nafter");
    expect((await store.readSession(target.notebookId, target.sessionId)).locks).toEqual([]);
    await expect(store.unlockProtectedSpan({ ...target, revisionBaseline, blockId: "0001", spanId: "legacy", now })).rejects.toThrow("revision_conflict");
  });
  it("protects legacy span markers even if their manifest lock entry was never recorded", async () => {
    const marked = await wrapProtectedSpan({ id: "legacy", markdown: "untouched" });
    const block = await store.appendMarkdownBlock({ ...target, source: "user", markdown: marked, now });
    await expect(store.updateMarkdownBlock({ ...target, revisionBaseline: await baseline(), blockId: block.id, markdown: "forged", now })).rejects.toThrow("protected_span_changed");
    expect(await text(block.id)).toBe(marked);
  });
  async function applyAiBatch(updates: Array<{ blockId: string; markdown: string }>) {
    const session = await store.readSession(target.notebookId, target.sessionId);
    const baseMarkdownHashes = Object.fromEntries(await Promise.all(session.blocks.filter(block => block.type === "markdown")
      .map(async block => [block.id, await sha256Text(await text(block.id))])));
    return store.applySessionAiRevision({ ...target, proposalId: "session_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      baseSessionHash: await sha256Text(JSON.stringify(session)), baseMarkdownHashes, updates, now });
  }
  it.each(["single", "batch"])("rejects %s AI deletion or forgery of legacy wrappers before publishing any content", async mode => {
    const marked = await wrapProtectedSpan({ id: "legacy-ai", markdown: "protected 中文🙂 $x+y$" });
    const block = await store.appendMarkdownBlock({ ...target, source: "user", markdown: marked, now });
    expect((await store.readSession(target.notebookId, target.sessionId)).locks).toEqual([]);
    const before = await baseline();
    for (const markdown of ["wrapper removed", marked.replace("protected", "forged")]) {
      const operation = mode === "single"
        ? store.updateMarkdownBlockFromAi({ ...target, blockId: block.id, markdown, now })
        : applyAiBatch([{ blockId: "0001", markdown: "must not publish" }, { blockId: block.id, markdown }]);
      await expect(operation).rejects.toThrow("AI update rejected: locked_span_");
      expect(await baseline()).toBe(before);
      expect(await text(block.id)).toBe(marked);
      expect(await text("0001")).toBe("A\r\n\n原文🙂\n");
    }
  });
  it.each(["single", "batch"])("allows %s AI editing around intact legacy wrappers", async mode => {
    const marked = await wrapProtectedSpan({ id: "legacy-keep", markdown: "protected 中文🙂" });
    const block = await store.appendMarkdownBlock({ ...target, source: "user", markdown: `before\n${marked}\nafter`, now });
    const markdown = `revised before\n${marked}\nrevised after`;
    if (mode === "single") await store.updateMarkdownBlockFromAi({ ...target, blockId: block.id, markdown, now });
    else await applyAiBatch([{ blockId: block.id, markdown }]);
    expect(await text(block.id)).toBe(markdown);
    expect((await store.readSession(target.notebookId, target.sessionId)).locks).toEqual([
      expect.objectContaining({ blockId: block.id, id: "legacy-keep", kind: "span" })
    ]);
  });
  it.each(["single-locked", "single-readonly", "batch-locked", "batch-readonly"])("protects %s blocks without relying on manifest locks", async mode => {
    const session = await store.readSession(target.notebookId, target.sessionId);
    if (mode.endsWith("readonly")) session.blocks[1].readonly = true;
    else session.blocks[1].status = "locked";
    expect(session.locks).toEqual([]);
    await writeFile(join(store.getSessionDir(target.notebookId, target.sessionId), "session.json"), JSON.stringify(session));
    const before = await baseline();
    const operation = mode.startsWith("single")
      ? store.updateMarkdownBlockFromAi({ ...target, blockId: "0002", markdown: "forbidden", now })
      : applyAiBatch([{ blockId: "0001", markdown: "must not publish" }, { blockId: "0002", markdown: "forbidden" }]);
    await expect(operation).rejects.toThrow("block_locked");
    expect(await baseline()).toBe(before);
    expect(await text("0002")).toBe("second");
  });
});

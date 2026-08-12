import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantProvider, BlockRef } from "@mathnotes/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { AssistantRemarkStore } from "./assistantRemarkStore";
import { buildMarkdownContext, extractBlockOrdinals, runAssistantTask } from "./assistantTask";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runAssistantTask", () => {
  it("maps a question about the 42nd visible block to its stable id and prioritized content", () => {
    const blocks = Array.from({ length: 50 }, (_, index) => ({
      id: String(index + 1).padStart(4, "0"),
      type: "markdown",
      source: "user"
    })) as BlockRef[];
    const markdownByBlockId = new Map(blocks.map((block, index) => [
      block.id,
      index === 41 ? "第 42 块的精确内容：一致有界原理" : `普通内容 ${index + 1}`
    ]));

    expect(extractBlockOrdinals("请告诉我第 42 块和第2块是什么", blocks.length)).toEqual([42, 2]);
    const context = buildMarkdownContext({
      focus: { kind: "session", label: "当前 Session" },
      question: "第 42 块的内容是什么？",
      readableBlocks: blocks,
      markdownByBlockId
    });

    expect(context).toContain("42. stable ID=0042");
    expect(context).toContain("## 第 42 块 · stable ID 0042");
    expect(context).toContain("第 42 块的精确内容：一致有界原理");
    expect(context).toContain("重排后序号变化，stable ID 不变");
  });

  it("stores an independent remark without changing or unlocking source content", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "mathnotes-assistant-"));
    roots.push(rootDir);
    const store = new BlockStore(rootDir);
    await store.createSession({ notebookId: "book", sessionId: "lesson", title: "Lesson", now: "2026-07-15T00:00:00.000Z" });
    const source = await store.appendMarkdownBlock({
      notebookId: "book",
      sessionId: "lesson",
      source: "ai_transcription",
      markdown: "$$T_n \\to T$$\n\n[图片：交换图]",
      now: "2026-07-15T00:00:01.000Z"
    });
    await store.setMarkdownBlockLock({
      notebookId: "book",
      sessionId: "lesson",
      blockId: source.id,
      locked: true,
      now: "2026-07-15T00:00:02.000Z"
    });
    const before = await store.readSession("book", "lesson");
    const provider: AssistantProvider = {
      name: "test-assistant",
      async assist(input) {
        expect(input.markdownContext).toContain("[图片：交换图]");
        return { markdown: "## 解读\n\n这里说明 $T_n$ 的收敛关系。" };
      }
    };

    const result = await runAssistantTask({
      store,
      provider,
      input: {
        taskId: "assistant_test",
        notebookId: "book",
        sessionId: "lesson",
        scope: "block",
        activeBlockId: source.id,
        mode: "explain"
      }
    });

    expect(result.status).toBe("succeeded");
    const after = await store.readSession("book", "lesson");
    expect(after.blocks.map((block) => block.source)).toEqual(["ai_transcription"]);
    expect(after.blocks[0]).toMatchObject({ id: source.id, status: "locked", editableByAi: false });
    expect(after.locks).toEqual(before.locks);
    expect(await store.readMarkdownBlock("book", "lesson", source.id)).toBe("$$T_n \\to T$$\n\n[图片：交换图]");
    const remarks = await new AssistantRemarkStore(store).list("book", "lesson");
    expect(remarks).toHaveLength(1);
    expect(remarks[0]).toMatchObject({ id: result.remarkId, focus: { kind: "block", blockId: source.id } });
    expect(remarks[0].markdown).toContain("这里说明");
    const assistantDir = path.join(store.getSessionDir("book", "lesson"), "assistant");
    const index = JSON.parse(await readFile(path.join(assistantDir, "index.json"), "utf8"));
    expect(index).toMatchObject({ version: 1, remarks: [{ id: result.remarkId }] });
    expect(await readFile(path.join(assistantDir, index.remarks[0].file), "utf8")).toContain("这里说明");
  });

  it("does not persist a remark when the user cancels", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "mathnotes-assistant-cancel-"));
    roots.push(rootDir);
    const store = new BlockStore(rootDir);
    await store.createSession({ notebookId: "book", sessionId: "lesson", title: "Lesson", now: "2026-07-15T00:00:00.000Z" });
    const source = await store.appendMarkdownBlock({ notebookId: "book", sessionId: "lesson", source: "user", markdown: "content", now: "2026-07-15T00:00:01.000Z" });
    const controller = new AbortController();
    const provider: AssistantProvider = {
      name: "slow",
      async assist(input) {
        controller.abort();
        input.abortSignal?.throwIfAborted();
        return { markdown: "never" };
      }
    };
    const result = await runAssistantTask({
      store,
      provider,
      input: { taskId: "assistant_cancel", notebookId: "book", sessionId: "lesson", scope: "block", activeBlockId: source.id, mode: "teach", abortSignal: controller.signal }
    });
    expect(result.status).toBe("cancelled");
    expect((await store.readSession("book", "lesson")).blocks).toHaveLength(1);
    expect(await new AssistantRemarkStore(store).list("book", "lesson")).toEqual([]);
  });

  it("migrates legacy JSON remarks into independent Markdown files and archives removals", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "mathnotes-assistant-legacy-"));
    roots.push(rootDir);
    const store = new BlockStore(rootDir);
    await store.createSession({ notebookId: "book", sessionId: "lesson", title: "Lesson", now: "2026-07-15T00:00:00.000Z" });
    const assistantDir = path.join(store.getSessionDir("book", "lesson"), "assistant");
    await mkdir(assistantDir, { recursive: true });
    await writeFile(path.join(assistantDir, "remarks.json"), JSON.stringify([{
      id: "remark_legacy",
      mode: "summarize",
      focus: { kind: "session", label: "当前 Session" },
      markdown: "# 旧旁注",
      providerName: "legacy",
      sourceBlockIds: [],
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    }]), "utf8");

    const remarkStore = new AssistantRemarkStore(store);
    expect((await remarkStore.list("book", "lesson"))[0].markdown).toContain("旧旁注");
    const index = JSON.parse(await readFile(path.join(assistantDir, "index.json"), "utf8"));
    const markdownPath = path.join(assistantDir, index.remarks[0].file);
    await access(markdownPath);

    expect(await remarkStore.remove({ notebookId: "book", sessionId: "lesson", remarkId: "remark_legacy" })).toBe(true);
    expect(await remarkStore.list("book", "lesson")).toEqual([]);
    await expect(access(markdownPath)).rejects.toMatchObject({ code: "ENOENT" });
    const archiveNames = await readdir(path.join(assistantDir, "archive"));
    expect(archiveNames.some((name) => name.startsWith("remark_legacy-") && name.endsWith(".md"))).toBe(true);
  });
});

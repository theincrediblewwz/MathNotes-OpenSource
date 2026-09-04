import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { searchAssistantKnowledge } from "./assistantKnowledgeGateway";

describe("searchAssistantKnowledge", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-knowledge-gateway-"));
    await createNotebook("current", "当前课程");
    await createNotebook("analysis", "泛函分析");
    await createNotebook("papers", "论文阅读");
    await createSession("current", "active", "正在阅读", [{ id: "0001", markdown: "一致有界原理只是当前笔记中的提问。" }]);
    await createSession("analysis", "lecture", "一致有界原理", [{
      id: "0007",
      markdown: "一致有界原理说明：逐点有界的连续线性算子族是一致有界的。",
      locked: true
    }]);
    await createSession("papers", "compact", "紧算子论文札记", [{
      id: "0003",
      markdown: "本文对一致有界原理只作背景引用，核心讨论紧算子。"
    }]);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("returns deterministic stable note references without exposing filesystem paths or write capability", async () => {
    const result = await searchAssistantKnowledge({
      rootDir: root,
      query: "一致有界原理",
      currentNotebookId: "current",
      currentSessionId: "active"
    });

    expect(result.references[0]).toMatchObject({
      refId: "R1",
      notebookId: "analysis",
      notebookTitle: "泛函分析",
      sessionId: "lecture",
      sessionTitle: "一致有界原理",
      blockId: "0007",
      locked: true,
      writePermission: "none"
    });
    expect(result.references.every((reference) => reference.sessionId !== "active")).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("blocks/");
    expect(serialized).not.toContain(".md");
  });

  it("keeps result count and context content bounded", async () => {
    const result = await searchAssistantKnowledge({
      rootDir: root,
      query: "一致有界原理",
      currentNotebookId: "current",
      currentSessionId: "active",
      maximumResults: 1
    });

    expect(result.references).toHaveLength(1);
    expect(Array.from(result.references[0].markdown).length).toBeLessThanOrEqual(4_000);
    expect(Array.from(result.references[0].excerpt).length).toBeLessThanOrEqual(282);
  });

  it("does not scan the knowledge base for an empty question", async () => {
    const result = await searchAssistantKnowledge({
      rootDir: root,
      query: "   ",
      currentNotebookId: "current",
      currentSessionId: "active"
    });
    expect(result).toMatchObject({ references: [], scannedSessionCount: 0, scannedBlockCount: 0 });
  });

  async function createNotebook(notebookId: string, title: string) {
    const notebookDir = join(root, "notebooks", notebookId);
    await mkdir(join(notebookDir, "sessions"), { recursive: true });
    await writeFile(join(notebookDir, "notebook.json"), JSON.stringify({
      id: notebookId,
      title,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z"
    }));
  }

  async function createSession(
    notebookId: string,
    sessionId: string,
    title: string,
    blocks: Array<{ id: string; markdown: string; locked?: boolean }>
  ) {
    const sessionDir = join(root, "notebooks", notebookId, "sessions", sessionId);
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    const session = createSessionRecord({ id: sessionId, title, createdAt: "2026-08-30T00:00:00.000Z" });
    session.blocks = blocks.map((entry) => {
      const block = createBlockRef({
        id: entry.id,
        type: "markdown",
        path: `blocks/${entry.id}.md`,
        source: "user",
        createdAt: session.createdAt
      });
      if (entry.locked) block.status = "locked";
      return block;
    });
    session.locks = blocks.filter((entry) => entry.locked).map((entry) => ({
      id: `lock-${entry.id}`,
      blockId: entry.id,
      kind: "block" as const,
      contentHash: "a".repeat(64),
      createdAt: session.createdAt,
      createdBy: "user" as const,
      aiEditable: false
    }));
    for (const entry of blocks) {
      await writeFile(join(sessionDir, "blocks", `${entry.id}.md`), entry.markdown);
    }
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(session));
  }
});

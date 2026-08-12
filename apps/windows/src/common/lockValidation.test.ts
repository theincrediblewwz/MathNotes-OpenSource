import { describe, expect, it } from "vitest";
import type { LockMeta } from "@mathnotes/shared";
import { sha256Text, wrapProtectedSpan } from "./lockSpan";
import { validateAiMarkdownUpdate } from "./lockValidation";

describe("lockValidation", () => {
  it("allows AI updates when the block has no locks", async () => {
    await expect(
      validateAiMarkdownUpdate({
        blockId: "0001",
        beforeMarkdown: "old",
        afterMarkdown: "new",
        locks: []
      })
    ).resolves.toEqual({ ok: true });
  });

  it("rejects AI changes to a block-level locked block", async () => {
    const locks: LockMeta[] = [
      {
        id: "lock_block_0001",
        blockId: "0001",
        kind: "block",
        contentHash: await sha256Text("old locked markdown"),
        createdAt: "2026-06-26T10:00:00.000Z",
        createdBy: "user",
        aiEditable: false
      }
    ];

    await expect(
      validateAiMarkdownUpdate({
        blockId: "0001",
        beforeMarkdown: "old locked markdown",
        afterMarkdown: "changed markdown",
        locks
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "locked_block_changed",
      lockId: "lock_block_0001"
    });
  });

  it("allows a no-op AI write to a block-level locked block", async () => {
    const markdown = "old locked markdown";
    const locks: LockMeta[] = [
      {
        id: "lock_block_0001",
        blockId: "0001",
        kind: "block",
        contentHash: await sha256Text(markdown),
        createdAt: "2026-06-26T10:00:00.000Z",
        createdBy: "user",
        aiEditable: false
      }
    ];

    await expect(
      validateAiMarkdownUpdate({
        blockId: "0001",
        beforeMarkdown: markdown,
        afterMarkdown: markdown,
        locks
      })
    ).resolves.toEqual({ ok: true });
  });

  it("rejects AI updates that remove a protected span", async () => {
    const locked = await wrapProtectedSpan({
      id: "lock_span_001",
      markdown: "人工确认定义"
    });
    const spanHash = (await validateSpanHash("人工确认定义"));

    await expect(
      validateAiMarkdownUpdate({
        blockId: "0001",
        beforeMarkdown: locked,
        afterMarkdown: "人工确认定义",
        locks: [spanLock("lock_span_001", spanHash)]
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "locked_span_missing",
      lockId: "lock_span_001"
    });
  });

  it("rejects AI updates that change protected span content", async () => {
    const before = await wrapProtectedSpan({
      id: "lock_span_001",
      markdown: "人工确认定义"
    });
    const after = await wrapProtectedSpan({
      id: "lock_span_001",
      markdown: "AI 改过的定义"
    });
    const spanHash = await validateSpanHash("人工确认定义");

    await expect(
      validateAiMarkdownUpdate({
        blockId: "0001",
        beforeMarkdown: before,
        afterMarkdown: after,
        locks: [spanLock("lock_span_001", spanHash)]
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "locked_span_changed",
      lockId: "lock_span_001"
    });
  });

  it("allows AI updates around an unchanged protected span", async () => {
    const locked = await wrapProtectedSpan({
      id: "lock_span_001",
      markdown: "人工确认定义"
    });
    const spanHash = await validateSpanHash("人工确认定义");

    await expect(
      validateAiMarkdownUpdate({
        blockId: "0001",
        beforeMarkdown: `前文\n\n${locked}\n\n旧尾部`,
        afterMarkdown: `AI 新前文\n\n${locked}\n\nAI 新尾部`,
        locks: [spanLock("lock_span_001", spanHash)]
      })
    ).resolves.toEqual({ ok: true });
  });
});

async function validateSpanHash(markdown: string): Promise<string> {
  return sha256Text(markdown);
}

function spanLock(id: string, contentHash: string): LockMeta {
  return {
    id,
    blockId: "0001",
    kind: "span",
    contentHash,
    createdAt: "2026-06-26T10:00:00.000Z",
    createdBy: "user",
    aiEditable: false
  };
}

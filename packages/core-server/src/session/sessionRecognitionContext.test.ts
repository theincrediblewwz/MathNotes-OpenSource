import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockRef, SessionRecord } from "@mathnotes/shared";
import {
  buildSessionRecognitionContext,
  MAX_SESSION_RECOGNITION_CONTEXT_BLOCKS,
  MAX_SESSION_RECOGNITION_CONTEXT_CHARS
} from "./sessionRecognitionContext";

describe("buildSessionRecognitionContext", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("rebuilds a versioned bounded snapshot from only the recent preceding Markdown blocks", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "mathnotes-recognition-context-"));
    roots.push(sessionDir);
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    const blocks: BlockRef[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const id = String(index).padStart(4, "0");
      const path = `blocks/${id}.md`;
      await writeFile(join(sessionDir, path), `# 第 ${index} 节\n\n${"连续性内容".repeat(80)}\n`, "utf8");
      blocks.push(markdownBlock(id, path));
    }
    blocks.push({
      id: "0013", type: "image", path: "assets/current.png", source: "user", status: "draft",
      readonly: false, editableByAi: false, renderInNote: true,
      createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z"
    });
    const session = sessionRecord(blocks);

    const snapshot = await buildSessionRecognitionContext({
      sessionDir,
      session,
      beforeBlockId: "0013",
      now: "2026-07-28T01:02:03.000Z"
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.sourceBlockIds).toHaveLength(MAX_SESSION_RECOGNITION_CONTEXT_BLOCKS);
    expect(snapshot.sourceBlockIds[0]).toBe("0005");
    expect(Array.from(snapshot.summary).length).toBeLessThanOrEqual(MAX_SESSION_RECOGNITION_CONTEXT_CHARS);
    expect(snapshot.summary).not.toContain("第 1 节");
    expect(snapshot.summary).toContain("第 12 节");
    const persisted = JSON.parse(
      await readFile(join(sessionDir, ".mathnotes", "recognition-context-v1.json"), "utf8")
    );
    expect(persisted).toMatchObject({
      version: 1,
      sessionId: "lecture",
      beforeBlockId: "0013",
      fingerprint: snapshot.fingerprint
    });
  });

  it("omits transient failed or waiting recognition drafts instead of feeding them back", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "mathnotes-recognition-context-draft-"));
    roots.push(sessionDir);
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "> 识别任务已创建，正在准备识别。\n", "utf8");
    await writeFile(join(sessionDir, "blocks", "0002.md"), "## 极限\n\n函数在此处连续。\n", "utf8");
    const session = sessionRecord([
      markdownBlock("0001", "blocks/0001.md"),
      markdownBlock("0002", "blocks/0002.md"),
      {
        id: "0003", type: "image", path: "assets/current.png", source: "user", status: "draft",
        readonly: false, editableByAi: false, renderInNote: true,
        createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z"
      }
    ]);

    const snapshot = await buildSessionRecognitionContext({ sessionDir, session, beforeBlockId: "0003" });
    expect(snapshot.sourceBlockIds).toEqual(["0002"]);
    expect(snapshot.summary).toContain("函数在此处连续");
    expect(snapshot.summary).not.toContain("正在准备识别");
  });
});

function markdownBlock(id: string, path: string): BlockRef {
  return {
    id, type: "markdown", path, source: "ai_transcription", status: "draft",
    readonly: false, editableByAi: true, renderInNote: true,
    createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z"
  };
}

function sessionRecord(blocks: BlockRef[]): SessionRecord {
  return {
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z",
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks
  };
}

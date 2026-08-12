import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LockMeta, SessionRecord } from "@mathnotes/shared";
import { readReadonlySessionBlock } from "./sessionReadService";
import { SessionEditError, SessionEditService } from "./sessionEditService";
import { sha256Text } from "./sessionRevision";

describe("SessionEditService", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-session-edit-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "## 原文\n\n可编辑内容\n");
    await writeSession([]);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("saves an editable user block and rotates its revision", async () => {
    const before = await readBlock();
    if (before.content.kind !== "markdown") throw new Error("expected markdown");
    const service = new SessionEditService(root, () => "2026-07-23T03:00:00.000Z");
    const result = await service.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: "## 已编辑\n\n新内容\n", baseRevision: before.content.baseRevision
    });
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toContain("新内容");
    expect(result.block.content.kind).toBe("markdown");
    if (result.block.content.kind !== "markdown") throw new Error("expected markdown");
    expect(result.block.content.baseRevision).not.toBe(before.content.baseRevision);
    expect(result.block.content.html).toContain("已编辑");
  });

  it("appends one named user Markdown block without changing the existing block", async () => {
    const service = new SessionEditService(root, () => "2026-08-12T12:00:00.000Z");
    const appended = await service.appendMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", markdown: "# Imported\n", sourceName: "chapter.md"
    });
    expect(appended.block).toMatchObject({ id: "0002", source: "user", sourceName: "chapter.md", order: 1 });
    expect(appended.content).toMatchObject({ kind: "markdown", markdown: "# Imported\n" });
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toContain("原文");
    const stored = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
    expect(stored.blocks.map((block) => block.id)).toEqual(["0001", "0002"]);
  });

  it("allows the user to correct an AI transcription draft", async () => {
    const sessionPath = join(sessionDir, "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    session.blocks[0] = { ...session.blocks[0], source: "ai_transcription", readonly: false };
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    const before = await readBlock();
    if (before.content.kind !== "markdown") throw new Error("expected markdown");

    await new SessionEditService(root).saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: "## 人工校订\n\n正确内容\n", baseRevision: before.content.baseRevision
    });

    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toContain("正确内容");
  });

  it("rejects stale and concurrent writes without overwriting the accepted content", async () => {
    const before = await readBlock();
    if (before.content.kind !== "markdown") throw new Error("expected markdown");
    const service = new SessionEditService(root);
    const input = {
      notebookId: "analysis", sessionId: "lecture", blockId: "0001", baseRevision: before.content.baseRevision
    };
    const outcomes = await Promise.allSettled([
      service.saveMarkdownBlock({ ...input, markdown: "first" }),
      service.saveMarkdownBlock({ ...input, markdown: "second" })
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.objectContaining({ code: "revision_conflict", statusCode: 409 }) });
    expect(["first", "second"]).toContain(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8"));
  });

  it("persists an idempotent conflict copy and resolves an explicit merge without hiding either side", async () => {
    const before = await readBlock();
    if (before.content.kind !== "markdown") throw new Error("expected markdown");
    let tick = 0;
    const service = new SessionEditService(root, () => `2026-07-23T03:00:0${tick++}.000Z`);
    const accepted = await service.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: "current edition", baseRevision: before.content.baseRevision
    });
    if (accepted.block.content.kind !== "markdown") throw new Error("expected markdown");

    const staleInput = {
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: "offline draft", baseRevision: before.content.baseRevision,
      writerId: "mac-test", operationId: "draft-1"
    };
    let firstConflictId = "";
    await expect(service.saveMarkdownBlock(staleInput)).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof SessionEditError)) return false;
      firstConflictId = error.details?.conflictId ?? "";
      return error.code === "revision_conflict" && /^[a-f0-9]{64}$/.test(firstConflictId);
    });
    await expect(service.saveMarkdownBlock(staleInput)).rejects.toMatchObject({
      code: "revision_conflict", details: { conflictId: firstConflictId }
    });
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe("current edition");

    const conflicts = await service.listMarkdownConflicts({ notebookId: "analysis", sessionId: "lecture" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ id: firstConflictId, blockId: "0001", status: "unresolved" });
    const detail = await service.readMarkdownConflict({
      notebookId: "analysis", sessionId: "lecture", conflictId: firstConflictId
    });
    expect(detail).toMatchObject({ currentMarkdown: "current edition", incomingMarkdown: "offline draft" });

    const resolved = await service.resolveMarkdownConflict({
      notebookId: "analysis", sessionId: "lecture", conflictId: firstConflictId,
      resolution: "merged", markdown: "current edition\n\noffline draft", baseRevision: accepted.block.content.baseRevision
    });
    expect(resolved.conflict.status).toBe("resolved_merged");
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe("current edition\n\noffline draft");
    expect(await readFile(join(sessionDir, ".mathnotes", "conflicts", firstConflictId, "current.md"), "utf8"))
      .toBe("current edition");
    expect(await readFile(join(sessionDir, ".mathnotes", "conflicts", firstConflictId, "incoming.md"), "utf8"))
      .toBe("offline draft");
  });

  it("rejects a locked block", async () => {
    const markdown = await readFile(join(sessionDir, "blocks", "0001.md"), "utf8");
    await writeSession([lock("block-lock", "block", sha256Text(markdown))], "locked");
    const before = await readBlock();
    if (before.content.kind !== "markdown") throw new Error("expected markdown");
    await expect(new SessionEditService(root).saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: `${markdown}\nchange`, baseRevision: before.content.baseRevision
    })).rejects.toEqual(expect.objectContaining<Partial<SessionEditError>>({ code: "block_locked", statusCode: 423 }));
  });

  it("locks and unlocks a markdown block through the shared edit service", async () => {
    const service = new SessionEditService(root, () => "2026-07-29T07:30:00.000Z");
    const locked = await service.setMarkdownBlockLock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001", locked: true
    });
    expect(locked.locked).toBe(true);
    expect(locked.block.block.status).toBe("locked");
    expect(locked.block.content).toMatchObject({ kind: "markdown", blockLocked: true });
    await expect(service.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: "blocked", baseRevision: "a".repeat(64)
    })).rejects.toMatchObject({ code: "block_locked", statusCode: 423 });

    const unlocked = await service.setMarkdownBlockLock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001", locked: false
    });
    expect(unlocked.locked).toBe(false);
    expect(unlocked.block.block.status).toBe("draft");
    expect(unlocked.block.content).toMatchObject({ kind: "markdown", blockLocked: false });
  });

  it("allows edits around a protected span but rejects changing or removing it", async () => {
    const protectedText = "已确认公式 $x=1$";
    const hash = sha256Text(protectedText);
    const markdown = `前文\n\n<!-- lock:start id="span-1" hash="${hash}" -->\n${protectedText}\n<!-- lock:end id="span-1" -->\n\n后文`;
    await writeFile(join(sessionDir, "blocks", "0001.md"), markdown);
    await writeSession([lock("span-1", "span", hash)]);
    const before = await readBlock();
    if (before.content.kind !== "markdown") throw new Error("expected markdown");
    const service = new SessionEditService(root);
    const saved = await service.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: `新增开头\n\n${markdown}`, baseRevision: before.content.baseRevision
    });
    if (saved.block.content.kind !== "markdown") throw new Error("expected markdown");
    await expect(service.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: saved.block.content.markdown.replace("$x=1$", "$x=2$"),
      baseRevision: saved.block.content.baseRevision
    })).rejects.toEqual(expect.objectContaining<Partial<SessionEditError>>({ code: "protected_span_changed" }));
  });

  it("preserves a stale draft as evidence but refuses to resolve it across a protected span", async () => {
    const protectedText = "已确认公式 $x=1$";
    const hash = sha256Text(protectedText);
    const markdown = `前文\n\n<!-- lock:start id="span-1" hash="${hash}" -->\n${protectedText}\n<!-- lock:end id="span-1" -->\n\n后文`;
    await writeFile(join(sessionDir, "blocks", "0001.md"), markdown);
    await writeSession([lock("span-1", "span", hash)]);
    const before = await readBlock();
    if (before.content.kind !== "markdown") throw new Error("expected markdown");
    const service = new SessionEditService(root);
    const current = await service.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: `新增说明\n\n${markdown}`, baseRevision: before.content.baseRevision
    });
    if (current.block.content.kind !== "markdown") throw new Error("expected markdown");

    let conflictId = "";
    await expect(service.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: markdown.replace("$x=1$", "$x=2$"), baseRevision: before.content.baseRevision
    })).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof SessionEditError)) return false;
      conflictId = error.details?.conflictId ?? "";
      return error.code === "revision_conflict" && conflictId.length === 64;
    });
    await expect(service.resolveMarkdownConflict({
      notebookId: "analysis", sessionId: "lecture", conflictId,
      resolution: "incoming", baseRevision: current.block.content.baseRevision
    })).rejects.toMatchObject({ code: "protected_span_changed", statusCode: 423 });
    await expect(service.readMarkdownConflict({
      notebookId: "analysis", sessionId: "lecture", conflictId
    })).resolves.toMatchObject({ status: "unresolved" });
  });

  it("rejects paths outside the notebook root before reading data", async () => {
    await expect(new SessionEditService(root).saveMarkdownBlock({
      notebookId: "../../outside", sessionId: "lecture", blockId: "0001",
      markdown: "x", baseRevision: "a".repeat(64)
    })).rejects.toEqual(expect.objectContaining<Partial<SessionEditError>>({ code: "path_outside_session", statusCode: 400 }));
  });

  it("rejects non-Markdown blocks before touching their asset", async () => {
    const sessionPath = join(sessionDir, "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
    session.blocks[0] = { ...session.blocks[0], type: "image", path: "assets/missing.png" };
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    await expect(new SessionEditService(root).saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: "x", baseRevision: "a".repeat(64)
    })).rejects.toEqual(expect.objectContaining<Partial<SessionEditError>>({ code: "not_markdown_block", statusCode: 422 }));
  });

  async function readBlock() {
    return readReadonlySessionBlock({ rootDir: root, notebookId: "analysis", sessionId: "lecture", blockId: "0001" });
  }

  async function writeSession(locks: LockMeta[], status: SessionRecord["blocks"][number]["status"] = "draft") {
    const session: SessionRecord = {
      id: "lecture", title: "第三讲", status: "draft",
      createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z",
      currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
      locks,
      blocks: [{
        id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status,
        readonly: false, editableByAi: false,
        createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z"
      }]
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  }
});

function lock(id: string, kind: "block" | "span", contentHash: string): LockMeta {
  return {
    id, blockId: "0001", kind, contentHash,
    createdAt: "2026-07-23T01:00:00.000Z", createdBy: "user", aiEditable: false
  };
}

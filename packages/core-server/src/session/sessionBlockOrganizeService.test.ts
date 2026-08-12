import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BlockRef, SessionRecord } from "@mathnotes/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBlockOrganizeService } from "./sessionBlockOrganizeService";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionBlockOrganizeService", () => {
  it("reorders selected blocks while keeping stable ids", async () => {
    const root = await fixture();
    const service = new SessionBlockOrganizeService(root, () => "2026-07-28T10:00:00.000Z");
    const result = await service.reorder({
      notebookId: "notes",
      sessionId: "source",
      blockIds: ["0003"],
      direction: "up"
    });
    expect(result.blocks.map((block) => block.id)).toEqual(["0001", "0003", "0002"]);
    expect(await markdown(root, "notes", "source", "0003_c.md")).toBe("C");
  });

  it("copies selected markdown and dependent source assets with new ids", async () => {
    const root = await fixture();
    const service = new SessionBlockOrganizeService(root, () => "2026-07-28T10:00:00.000Z");
    const result = await service.transfer({
      sourceNotebookId: "notes",
      sourceSessionId: "source",
      targetNotebookId: "notes",
      targetSessionId: "target",
      blockIds: ["0002"],
      mode: "copy"
    });
    expect(result).toMatchObject({ copiedBlockIds: ["0002"], sourceCleanupPending: false });
    const target = await session(root, "notes", "target");
    expect(target.blocks.map((block) => block.id)).toEqual(["0001", "0002"]);
    expect(target.blocks[1].fromAssets).toEqual(["assets/photos/0002-board.jpg"]);
    expect(await markdown(root, "notes", "target", "0002_copied.md")).toBe("B");
    expect(await readFile(join(root, "notebooks/notes/sessions/target/assets/photos/0002-board.jpg"), "utf8")).toBe("photo");
    expect((await session(root, "notes", "source")).blocks).toHaveLength(3);
  });

  it("moves copy-first and removes the source manifest entry only after target success", async () => {
    const root = await fixture();
    const service = new SessionBlockOrganizeService(root, () => "2026-07-28T10:00:00.000Z");
    const result = await service.transfer({
      sourceNotebookId: "notes",
      sourceSessionId: "source",
      targetNotebookId: "notes",
      targetSessionId: "target",
      blockIds: ["0001", "0003"],
      mode: "move"
    });
    expect(result.sourceCleanupPending).toBe(false);
    expect((await session(root, "notes", "source")).blocks.map((block) => block.id)).toEqual(["0002"]);
    expect((await session(root, "notes", "target")).blocks.map((block) => block.id)).toEqual(["0001", "0002", "0003"]);
  });

  it("deletes into recoverable trash and leaves remaining display order contiguous", async () => {
    const root = await fixture();
    const service = new SessionBlockOrganizeService(root, () => "2026-07-28T10:00:00.000Z");
    const result = await service.delete({
      notebookId: "notes",
      sessionId: "source",
      blockIds: ["0002"]
    });
    expect(result.blocks.map((block) => block.id)).toEqual(["0001", "0003"]);
    const stored = await session(root, "notes", "source");
    expect(stored.blocks.map((block) => block.id)).toEqual(["0001", "0003"]);
    await expect(markdown(root, "notes", "source", "0002_b.md")).rejects.toMatchObject({ code: "ENOENT" });
    const trash = join(root, "notebooks/notes/sessions/source/.mathnotes/trash");
    const deleteIds = await readdir(trash);
    expect(deleteIds).toHaveLength(1);
    expect(await readFile(join(trash, deleteIds[0], "blocks/0002_b.md"), "utf8")).toBe("B");
  });

  it("keeps fixed blocks immutable while still allowing a non-destructive copy", async () => {
    const root = await fixture();
    await setBlockLock(root, "notes", "source", "0002");
    const service = new SessionBlockOrganizeService(root, () => "2026-07-28T10:00:00.000Z");

    await expect(service.reorder({
      notebookId: "notes",
      sessionId: "source",
      blockIds: ["0002"],
      direction: "up"
    })).rejects.toMatchObject({ code: "block_locked", statusCode: 423 });

    await expect(service.transfer({
      sourceNotebookId: "notes",
      sourceSessionId: "source",
      targetNotebookId: "notes",
      targetSessionId: "target",
      blockIds: ["0002"],
      mode: "move"
    })).rejects.toMatchObject({ code: "block_locked", statusCode: 423 });

    const copied = await service.transfer({
      sourceNotebookId: "notes",
      sourceSessionId: "source",
      targetNotebookId: "notes",
      targetSessionId: "target",
      blockIds: ["0002"],
      mode: "copy"
    });
    expect(copied.copiedBlockIds).toEqual(["0002"]);
    expect((await session(root, "notes", "source")).blocks).toHaveLength(3);
    expect((await session(root, "notes", "target")).locks).toEqual([
      expect.objectContaining({ id: "lock_block_0002", blockId: "0002", kind: "block" })
    ]);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-organize-"));
  roots.push(root);
  await writeSession(root, "notes", "source", [
    block("0001", "blocks/0001_a.md"),
    { ...block("0002", "blocks/0002_b.md"), fromAssets: ["assets/photos/board.jpg"] },
    block("0003", "blocks/0003_c.md")
  ]);
  await writeSession(root, "notes", "target", [block("0001", "blocks/0001_target.md")]);
  await Promise.all([
    writeText(root, "notes", "source", "blocks/0001_a.md", "A"),
    writeText(root, "notes", "source", "blocks/0002_b.md", "B"),
    writeText(root, "notes", "source", "blocks/0003_c.md", "C"),
    writeText(root, "notes", "source", "assets/photos/board.jpg", "photo"),
    writeText(root, "notes", "target", "blocks/0001_target.md", "target")
  ]);
  return root;
}

function block(id: string, path: string): BlockRef {
  return {
    id,
    type: "markdown",
    path,
    source: "user",
    status: "draft",
    readonly: false,
    editableByAi: false,
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:00:00.000Z"
  };
}

async function writeSession(root: string, notebookId: string, sessionId: string, blocks: BlockRef[]) {
  const value: SessionRecord = {
    id: sessionId,
    title: sessionId,
    status: "draft",
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:00:00.000Z",
    blocks,
    locks: [],
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
  };
  const directory = join(root, "notebooks", notebookId, "sessions", sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(root: string, notebookId: string, sessionId: string, path: string, value: string) {
  const absolute = join(root, "notebooks", notebookId, "sessions", sessionId, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, value, "utf8");
}

async function session(root: string, notebookId: string, sessionId: string): Promise<SessionRecord> {
  return JSON.parse(await readFile(join(root, "notebooks", notebookId, "sessions", sessionId, "session.json"), "utf8"));
}

async function setBlockLock(root: string, notebookId: string, sessionId: string, blockId: string) {
  const value = await session(root, notebookId, sessionId);
  value.locks = [{
    id: `lock_block_${blockId}`,
    blockId,
    kind: "block",
    contentHash: "0".repeat(64),
    createdAt: "2026-07-28T09:30:00.000Z",
    createdBy: "user",
    aiEditable: false
  }];
  const path = join(root, "notebooks", notebookId, "sessions", sessionId, "session.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function markdown(root: string, notebookId: string, sessionId: string, fileName: string) {
  return readFile(join(root, "notebooks", notebookId, "sessions", sessionId, "blocks", fileName), "utf8");
}

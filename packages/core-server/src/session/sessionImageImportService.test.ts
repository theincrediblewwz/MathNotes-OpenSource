import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "@mathnotes/shared";
import { SessionEditService } from "./sessionEditService";
import {
  MAX_LOCAL_IMAGE_BYTES,
  SessionImageImportError,
  SessionImageImportService
} from "./sessionImageImportService";
import { readReadonlySessionBlock, readReadonlySessionManifest } from "./sessionReadService";
import { SessionWriteCoordinator } from "./sessionWriteCoordinator";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBPdata", "binary");

describe("SessionImageImportService", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-session-image-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "## 原文\n\n可编辑内容\n");
    await writeSession();
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it.each([
    ["PNG", "课堂 截图.png", PNG, ".png"],
    ["JPEG", "board.fake.png", JPEG, ".jpg"],
    ["WebP", "diagram.webp", WEBP, ".webp"]
  ])("imports %s by file signature and appends a visible image block", async (_label, fileName, bytes, extension) => {
    const before = await manifest();
    const result = await new SessionImageImportService(root, () => "2026-07-23T04:00:00.000Z").importImage({
      notebookId: "analysis", sessionId: "lecture", fileName, bytes, baseRevision: before.revision
    });

    expect(result.blockId).toBe("0002");
    expect(result.manifest.revision).not.toBe(before.revision);
    const imported = result.manifest.blocks[1];
    expect(imported).toMatchObject({ id: "0002", type: "image", source: "user", renderInNote: true });
    const block = await readReadonlySessionBlock({
      rootDir: root, notebookId: "analysis", sessionId: "lecture", blockId: "0002"
    });
    if (block.content.kind !== "image") throw new Error("expected image");
    expect(block.content.assetPath.endsWith(extension)).toBe(true);
    expect(await readFile(join(sessionDir, block.content.assetPath))).toEqual(bytes);
  });

  it("rejects invalid, empty, oversized and outside-session input without residue", async () => {
    const before = await manifest();
    const service = new SessionImageImportService(root);
    const common = { notebookId: "analysis", sessionId: "lecture", fileName: "bad.png", baseRevision: before.revision };

    await expect(service.importImage({ ...common, bytes: Buffer.alloc(0) }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionImageImportError>>({ code: "empty_image", statusCode: 400 }));
    await expect(service.importImage({ ...common, bytes: Buffer.from("not an image") }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionImageImportError>>({ code: "unsupported_image", statusCode: 415 }));
    await expect(service.importImage({ ...common, bytes: Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1) }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionImageImportError>>({ code: "image_too_large", statusCode: 413 }));
    await expect(service.importImage({ ...common, notebookId: "../../outside", bytes: PNG }))
      .rejects.toEqual(expect.objectContaining<Partial<SessionImageImportError>>({ code: "path_outside_session", statusCode: 400 }));

    expect((await manifest()).blocks).toHaveLength(1);
    await expect(readdir(join(sessionDir, "assets", "photos"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale manifest revision before writing an asset", async () => {
    await expect(new SessionImageImportService(root).importImage({
      notebookId: "analysis", sessionId: "lecture", fileName: "board.png", bytes: PNG, baseRevision: "a".repeat(64)
    })).rejects.toEqual(expect.objectContaining<Partial<SessionImageImportError>>({ code: "revision_conflict", statusCode: 409 }));
    expect((await manifest()).blocks).toHaveLength(1);
    await expect(readdir(join(sessionDir, "assets", "photos"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes Markdown edits and image imports through the same session coordinator", async () => {
    const coordinator = new SessionWriteCoordinator();
    const editService = new SessionEditService(root, () => "2026-07-23T04:01:00.000Z", coordinator);
    const imageService = new SessionImageImportService(root, () => "2026-07-23T04:02:00.000Z", coordinator);
    const block = await readReadonlySessionBlock({
      rootDir: root, notebookId: "analysis", sessionId: "lecture", blockId: "0001"
    });
    if (block.content.kind !== "markdown") throw new Error("expected markdown");
    const before = await manifest();

    const edit = editService.saveMarkdownBlock({
      notebookId: "analysis", sessionId: "lecture", blockId: "0001",
      markdown: "## 已编辑\n", baseRevision: block.content.baseRevision
    });
    const staleImport = imageService.importImage({
      notebookId: "analysis", sessionId: "lecture", fileName: "board.png", bytes: PNG,
      baseRevision: before.revision
    });
    await expect(edit).resolves.toMatchObject({ saved: true });
    await expect(staleImport).rejects.toEqual(expect.objectContaining({ code: "revision_conflict" }));

    const afterEdit = await manifest();
    const imported = await imageService.importImage({
      notebookId: "analysis", sessionId: "lecture", fileName: "board.png", bytes: PNG,
      baseRevision: afterEdit.revision
    });
    expect(imported.manifest.blocks.map((item) => item.id)).toEqual(["0001", "0002"]);
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe("## 已编辑\n");
  });

  async function manifest() {
    return readReadonlySessionManifest({ rootDir: root, notebookId: "analysis", sessionId: "lecture" });
  }

  async function writeSession() {
    const session: SessionRecord = {
      id: "lecture", title: "第三讲", status: "draft",
      createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z",
      currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
      locks: [],
      blocks: [{
        id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
        readonly: false, editableByAi: false,
        createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z"
      }]
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  }
});

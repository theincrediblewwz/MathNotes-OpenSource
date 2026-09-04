import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertValidImageTransformSidecar, type ImageTransformSidecar, type SessionRecord } from "@mathnotes/shared";
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

  it("preserves the original and atomically imports an edited PNG with an auditable sidecar", async () => {
    const before = await manifest();
    const output = Buffer.from([...PNG, 4, 5, 6]);
    const result = await new SessionImageImportService(root, () => "2026-07-23T05:00:00.000Z").importEditedImage({
      notebookId: "analysis",
      sessionId: "lecture",
      fileName: "课堂 黑板.jpg",
      sourceBytes: JPEG,
      outputPngBytes: output,
      baseRevision: before.revision,
      operations: [
        { type: "crop", rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } },
        { type: "rotate", quarterTurns: 1 }
      ],
      annotations: [{
        id: "arrow-1",
        type: "arrow",
        start: { x: 0.2, y: 0.2 },
        end: { x: 0.8, y: 0.7 },
        color: "#187857",
        width: 0.006
      }]
    });

    expect(result).toMatchObject({ imported: true, edited: true, blockId: "0002" });
    expect(result.sourceAssetPath).toMatch(/^assets\/photos\/.+\.jpg$/);
    expect(result.assetPath).toMatch(/^assets\/embedded\/.+\.png$/);
    expect(result.metadataPath).toMatch(/^assets\/embedded\/.+\.annotation\.json$/);
    expect(await readFile(join(sessionDir, result.sourceAssetPath))).toEqual(JPEG);
    expect(await readFile(join(sessionDir, result.assetPath))).toEqual(output);
    const sidecar = JSON.parse(await readFile(join(sessionDir, result.metadataPath), "utf8")) as ImageTransformSidecar;
    expect(() => assertValidImageTransformSidecar(sidecar)).not.toThrow();
    expect(sidecar).toMatchObject({
      sourceAsset: result.sourceAssetPath,
      sourceSha256: result.sourceSha256,
      outputAsset: result.assetPath,
      outputMimeType: "image/png",
      operations: [
        { type: "rotate", quarterTurns: 1 },
        { type: "crop", rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } }
      ]
    });
    const stored = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
    expect(stored.blocks[1]).toMatchObject({
      id: "0002",
      type: "image",
      path: result.assetPath,
      fromAssets: [result.sourceAssetPath],
      renderInNote: true
    });
  });

  it("does not touch locked Markdown while adding an edited image block", async () => {
    const lockedMarkdown = await readFile(join(sessionDir, "blocks", "0001.md"), "utf8");
    const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
    session.blocks[0] = { ...session.blocks[0], status: "locked" };
    session.locks = [{
      id: "lock-0001",
      blockId: "0001",
      kind: "block",
      contentHash: "a".repeat(64),
      createdAt: "2026-07-23T04:30:00.000Z",
      createdBy: "user",
      aiEditable: false
    }];
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
    const before = await manifest();

    const result = await new SessionImageImportService(root).importEditedImage({
      notebookId: "analysis", sessionId: "lecture", fileName: "board.jpg",
      sourceBytes: JPEG, outputPngBytes: PNG, baseRevision: before.revision,
      operations: [], annotations: []
    });

    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe(lockedMarkdown);
    const after = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
    expect(after.blocks[0].status).toBe("locked");
    expect(after.locks).toEqual(session.locks);
    expect(result.manifest.blocks.map((block) => block.id)).toEqual(["0001", "0002"]);
  });

  it("rejects stale, malformed, non-PNG and oversized edited image input without residue", async () => {
    const before = await manifest();
    const service = new SessionImageImportService(root);
    const common = {
      notebookId: "analysis", sessionId: "lecture", fileName: "board.jpg",
      sourceBytes: JPEG, outputPngBytes: PNG, baseRevision: before.revision,
      operations: [], annotations: []
    };

    await expect(service.importEditedImage({ ...common, baseRevision: "f".repeat(64) }))
      .rejects.toMatchObject({ code: "revision_conflict", statusCode: 409 });
    await expect(service.importEditedImage({ ...common, outputPngBytes: JPEG }))
      .rejects.toMatchObject({ code: "invalid_image_edit", statusCode: 400 });
    await expect(service.importEditedImage({
      ...common,
      operations: [{ type: "rotate", quarterTurns: 4 } as never]
    })).rejects.toMatchObject({ code: "invalid_image_edit", statusCode: 400 });
    await expect(service.importEditedImage({ ...common, outputPngBytes: Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1) }))
      .rejects.toMatchObject({ code: "image_too_large", statusCode: 413 });

    expect((await manifest()).blocks).toHaveLength(1);
    await expect(readdir(join(sessionDir, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
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

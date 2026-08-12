import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "@mathnotes/shared";
import {
  countPdfPages,
  MAX_LOCAL_PDF_BYTES,
  SessionPdfImportService
} from "./sessionPdfImportService";
import { readReadonlySessionBlock, readReadonlySessionManifest } from "./sessionReadService";

const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj<</Type /Catalog>>endobj\n2 0 obj<</Type /Page>>endobj\n3 0 obj<</Type/Page>>endobj\n%%EOF",
  "latin1"
);

describe("SessionPdfImportService", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-session-pdf-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "# 原文\n");
    const session: SessionRecord = {
      id: "lecture",
      title: "第三讲",
      status: "draft",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      currentDraftPolicy: "append_only",
      exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
      locks: [],
      blocks: [{
        id: "0001",
        type: "markdown",
        path: "blocks/0001.md",
        source: "user",
        status: "draft",
        readonly: false,
        editableByAi: false,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z"
      }]
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("stores a PDF inside the target Session and appends a readonly PDF block", async () => {
    const before = await readReadonlySessionManifest({
      rootDir: root,
      notebookId: "analysis",
      sessionId: "lecture"
    });
    const result = await new SessionPdfImportService(
      root,
      () => "2026-07-28T01:00:00.000Z"
    ).importPdf({
      notebookId: "analysis",
      sessionId: "lecture",
      fileName: "泛函分析 讲义.pdf",
      bytes: PDF,
      baseRevision: before.revision
    });

    expect(result).toMatchObject({ blockId: "0002", pageCount: 2 });
    const block = await readReadonlySessionBlock({
      rootDir: root,
      notebookId: "analysis",
      sessionId: "lecture",
      blockId: result.blockId
    });
    expect(block.block).toMatchObject({
      type: "pdf",
      source: "pdf_import",
      sourceName: "泛函分析 讲义.pdf",
      pageCount: 2,
      editable: false
    });
    if (block.content.kind !== "pdf") throw new Error("expected PDF block");
    expect(await readFile(join(sessionDir, block.content.assetPath))).toEqual(PDF);
  });

  it("rejects invalid, empty, oversized and stale PDF input without residue", async () => {
    const before = await readReadonlySessionManifest({
      rootDir: root,
      notebookId: "analysis",
      sessionId: "lecture"
    });
    const service = new SessionPdfImportService(root);
    const common = {
      notebookId: "analysis",
      sessionId: "lecture",
      fileName: "lecture.pdf",
      baseRevision: before.revision
    };
    await expect(service.importPdf({ ...common, bytes: Buffer.alloc(0) }))
      .rejects.toMatchObject({ code: "empty_pdf", statusCode: 400 });
    await expect(service.importPdf({ ...common, bytes: Buffer.from("not a pdf") }))
      .rejects.toMatchObject({ code: "unsupported_pdf", statusCode: 415 });
    await expect(service.importPdf({ ...common, bytes: Buffer.alloc(MAX_LOCAL_PDF_BYTES + 1) }))
      .rejects.toMatchObject({ code: "pdf_too_large", statusCode: 413 });
    await expect(service.importPdf({ ...common, bytes: PDF, baseRevision: "a".repeat(64) }))
      .rejects.toMatchObject({ code: "revision_conflict", statusCode: 409 });
    await expect(readdir(join(sessionDir, "assets", "pdfs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("counts page dictionaries without treating the page tree as a page", () => {
    expect(countPdfPages(PDF)).toBe(2);
    expect(countPdfPages(Buffer.from("%PDF-1.4\n/Type /Pages\n"))).toBe(0);
  });
});

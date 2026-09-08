// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCatalogSyncService, WorkspaceSyncService } from "@mathnotes/core-server";
import { BlockStore } from "./blockStore";
import { PdfIngestPipeline } from "./pdfIngestPipeline";

describe("PdfIngestPipeline", () => {
  let root: string;
  let store: BlockStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-pdf-ingest-"));
    store = new BlockStore(root);
    await store.createSession({ notebookId: "n", sessionId: "s", title: "Session", now: "2026-07-14T12:00:00.000Z" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a PDF retry after remote trash without resurrecting its session directory", async () => {
    const onIngested = vi.fn();
    const pipeline = new PdfIngestPipeline({ store, onIngested });
    const input = pdfInput();
    const accepted = await pipeline.acceptPdf(input);
    const coordinator = store.getWriteCoordinator();
    const sync = new WorkspaceSyncService(root, join(root, "state"), (n, s, operation) => coordinator.run(n, s, operation));
    const catalog = new WorkspaceCatalogSyncService(root, join(root, "state"), coordinator);
    const before = await sync.snapshot("n", "s");
    const deleted = await catalog.execute({ operationId: randomUUID(), action: "trash", notebookId: "n", sessionId: "s", baseRevision: before.revision });
    await expect(pipeline.acceptPdf(input)).rejects.toMatchObject({ message: "session_not_found", statusCode: 404 });
    await expect(stat(store.getSessionDir("n", "s"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(join(root, ".mathnotes-trash", deleted.deletionId!, "payload", accepted.inboxPath))).equals(input.bytes)).toBe(true);
    expect(onIngested).toHaveBeenCalledTimes(1);
    expect((await catalog.catalogState()).trash).toHaveLength(1);
  });

  it("waits behind a pending workspace deletion and checks existence only after that barrier", async () => {
    const pipeline = new PdfIngestPipeline({ store });
    const live = store.getSessionDir("n", "s"), trash = join(root, "trashed-session");
    let entered!: () => void, release!: () => void, queued!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const enqueued = new Promise<void>(resolve => { queued = resolve; });
    const coordinator = store.getWriteCoordinator();
    const originalRun = coordinator.run.bind(coordinator);
    vi.spyOn(store, "getWriteCoordinator").mockReturnValue(coordinator);
    vi.spyOn(coordinator, "run").mockImplementation((n, s, action) => { queued(); return originalRun(n, s, action); });
    const deletion = new BlockStore(root).getWriteCoordinator().runWorkspace(async () => {
      entered(); await gate; await rename(live, trash);
    });
    await started;
    const upload = pipeline.acceptPdf(pdfInput());
    const rejected = expect(upload).rejects.toMatchObject({ message: "session_not_found", statusCode: 404 });
    await enqueued;
    release(); await deletion; await rejected;
    await expect(stat(live)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(trash, "inbox"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes deletion wait for an in-flight PDF and moves the complete upload and log together", async () => {
    const pipeline = new PdfIngestPipeline({ store });
    const live = store.getSessionDir("n", "s"), trash = join(root, "trashed-session");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readSession = store.readSession.bind(store);
    vi.spyOn(store, "readSession").mockImplementationOnce(async (n, s) => {
      const session = await readSession(n, s); entered(); await gate; return session;
    });
    const upload = pipeline.acceptPdf(pdfInput());
    await started;
    let deleteEntered = false;
    const deletion = new BlockStore(root).getWriteCoordinator().runWorkspace(async () => {
      deleteEntered = true;
      const records = JSON.parse(await readFile(join(live, "logs/pdf_uploads.json"), "utf8"));
      expect(records).toHaveLength(1);
      expect((await readFile(records[0].sourcePath)).equals(pdfInput().bytes)).toBe(true);
      await rename(live, trash);
    });
    await Promise.resolve(); await Promise.resolve();
    expect(deleteEntered).toBe(false);
    release();
    const accepted = await upload; await deletion;
    expect((await readFile(join(trash, accepted.inboxPath))).equals(pdfInput().bytes)).toBe(true);
    await expect(stat(live)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores a PDF durably without creating blocks or recognition jobs", async () => {
    const onIngested = vi.fn();
    const pipeline = new PdfIngestPipeline({ store, onIngested });
    const bytes = createMinimalPdf();
    const input = {
      notebookId: "n",
      sessionId: "s",
      originalName: "lecture notes.pdf",
      mimeType: "application/pdf",
      bytes,
      captureId: "capture-pdf-1",
      deviceId: "phone-1",
      receivedAt: "2026-07-14T12:01:00.000Z"
    };

    const first = await pipeline.acceptPdf(input);
    const duplicate = await pipeline.acceptPdf(input);

    expect(first).toMatchObject({ materialType: "pdf", duplicate: false, fileName: "lecture notes.pdf", pageCount: 1 });
    expect(duplicate).toMatchObject({ uploadId: first.uploadId, duplicate: true });
    await expect(readFile(first.sourcePath)).resolves.toEqual(bytes);
    await expect(store.readSession("n", "s")).resolves.toMatchObject({ blocks: [] });
    expect(onIngested).toHaveBeenCalledTimes(2);
  });
});

function pdfInput() {
  return { notebookId: "n", sessionId: "s", originalName: "课堂讲义.pdf", mimeType: "application/pdf",
    bytes: createMinimalPdf(), captureId: "capture-pdf-1", deviceId: "phone-1", receivedAt: "2026-07-14T12:01:00.000Z" };
}

function createMinimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

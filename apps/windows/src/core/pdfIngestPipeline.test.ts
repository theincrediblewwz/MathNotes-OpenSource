// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    await rm(root, { recursive: true, force: true });
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

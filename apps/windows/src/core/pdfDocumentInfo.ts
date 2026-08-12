export type PdfDocumentInfo = {
  pageCount: number;
};

export async function readPdfDocumentInfo(bytes: Buffer): Promise<PdfDocumentInfo> {
  ensurePdfMetadataDomMatrix();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  const info = { pageCount: document.numPages };
  await loadingTask.destroy();
  return info;
}

function ensurePdfMetadataDomMatrix(): void {
  if ("DOMMatrix" in globalThis) return;

  // PDF.js constructs one identity matrix while loading its Node entrypoint.
  // Page-count inspection never renders a page, so the native Canvas package is unnecessary here.
  Object.defineProperty(globalThis, "DOMMatrix", {
    configurable: true,
    value: class PdfMetadataDomMatrix {}
  });
}

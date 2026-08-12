import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export async function renderPdfPagesForRecognition(args: {
  sourceUrl: string;
  pageNumbers: number[];
  renderConcurrency?: number;
  onPage(page: { pageNumber: number; pngDataUrl: string }): Promise<void>;
}): Promise<void> {
  const { GlobalWorkerOptions, getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = getDocument({ url: args.sourceUrl });
  const document = await loadingTask.promise;
  const pageNumbers = [...new Set(args.pageNumbers)].sort((left, right) => left - right);
  if (pageNumbers.some((pageNumber) => pageNumber < 1 || pageNumber > document.numPages)) {
    await loadingTask.destroy();
    throw new Error("PDF 识别页码超出文档范围");
  }

  let cursor = 0;
  const workerCount = Math.min(Math.max(1, args.renderConcurrency ?? 2), 2, pageNumbers.length || 1);
  try {
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < pageNumbers.length) {
          const pageNumber = pageNumbers[cursor++];
          const page = await document.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(2, 2800 / Math.max(baseViewport.width, baseViewport.height));
          const viewport = page.getViewport({ scale });
          const canvas = documentCanvas(viewport.width, viewport.height);
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) {
            throw new Error(`无法创建 PDF 第 ${pageNumber} 页画布`);
          }
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          const pngDataUrl = canvas.toDataURL("image/png");
          canvas.width = 1;
          canvas.height = 1;
          await args.onPage({ pageNumber, pngDataUrl });
        }
      })
    );
  } finally {
    await loadingTask.destroy();
  }
}

function documentCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

type PdfDocumentPreviewProps = {
  sourceUrl: string;
  pageCount: number;
  label: string;
  pageNumbers?: number[];
};

export function PdfDocumentPreview({ sourceUrl, pageCount, label, pageNumbers }: PdfDocumentPreviewProps) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    async function loadDocument() {
      const { GlobalWorkerOptions, getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      GlobalWorkerOptions.workerSrc = workerUrl;
      loadingTask = getDocument({ url: sourceUrl });
      return loadingTask.promise;
    }

    void loadDocument()
      .then((loaded) => {
        if (disposed) {
          void loadingTask?.destroy();
          return;
        }
        setDocument(loaded);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "PDF 加载失败");
        }
      });

    return () => {
      disposed = true;
      void loadingTask?.destroy();
    };
  }, [sourceUrl]);

  if (error) {
    return (
      <div className="pdf-preview-state error" role="alert">
        <strong>{label}</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!document) {
    return <div className="pdf-preview-state">正在打开 {label}</div>;
  }

  const renderedPageCount = Math.max(1, document.numPages || pageCount);
  const pages = pageNumbers?.length
    ? pageNumbers.filter((pageNumber) => pageNumber >= 1 && pageNumber <= renderedPageCount)
    : Array.from({ length: renderedPageCount }, (_, index) => index + 1);
  return (
    <div aria-label={`${label}，共 ${renderedPageCount} 页`} className="pdf-document-preview">
      {pages.map((pageNumber) => (
        <PdfPageCanvas document={document} key={pageNumber} pageNumber={pageNumber} />
      ))}
    </div>
  );
}

function PdfPageCanvas({ document, pageNumber }: { document: PDFDocumentProxy; pageNumber: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageNumber <= 2);
  const [rendered, setRendered] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [retryRequest, setRetryRequest] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "700px 0px" }
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!visible || !host || !canvas) {
      return;
    }

    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null = null;
    let requestedGeneration = 0;
    let scheduledFrame: number | undefined;
    let renderChain = Promise.resolve();

    async function renderPage(generation: number) {
      const page = await document.getPage(pageNumber);
      if (disposed || generation !== requestedGeneration || !host || !canvas) {
        return;
      }
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(320, host.clientWidth - 2);
      const cssScale = availableWidth / baseViewport.width;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: cssScale });
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error("无法创建 PDF 画布");
      }
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.restore();
      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
      });
      await renderTask.promise;
      if (!disposed && generation === requestedGeneration) {
        setRendered(true);
        setRenderError(null);
      }
    }

    function scheduleRender() {
      requestedGeneration += 1;
      const generation = requestedGeneration;
      if (scheduledFrame !== undefined) {
        window.cancelAnimationFrame(scheduledFrame);
      }
      scheduledFrame = window.requestAnimationFrame(() => {
        scheduledFrame = undefined;
        renderChain = renderChain
          .catch(() => undefined)
          .then(() => renderPage(generation))
          .catch((reason: unknown) => {
            if (disposed || generation !== requestedGeneration || isRenderingCancelled(reason)) {
              return;
            }
            setRendered(false);
            setRenderError(reason instanceof Error ? reason.message : "PDF 页面渲染失败");
          });
      });
    }

    scheduleRender();
    const resizeObserver = new ResizeObserver(scheduleRender);
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (scheduledFrame !== undefined) {
        window.cancelAnimationFrame(scheduledFrame);
      }
      void renderTask?.cancel();
    };
  }, [document, pageNumber, retryRequest, visible]);

  return (
    <div className={`pdf-page ${rendered ? "rendered" : renderError ? "error" : "loading"}`} ref={hostRef}>
      <canvas aria-label={`PDF 第 ${pageNumber} 页`} ref={canvasRef} />
      {renderError ? (
        <div className="pdf-page-error" role="alert">
          <span>第 {pageNumber} 页渲染失败：{renderError}</span>
          <button onClick={() => setRetryRequest((current) => current + 1)} type="button">重试本页</button>
        </div>
      ) : null}
      <span className="pdf-page-number">{pageNumber}</span>
    </div>
  );
}

function isRenderingCancelled(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "RenderingCancelledException";
}

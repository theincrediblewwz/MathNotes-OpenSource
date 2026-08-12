import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfDocumentPreview } from "./PdfDocumentPreview";

const pdfRuntime = vi.hoisted(() => ({
  getDocument: vi.fn()
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfRuntime.getDocument
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "pdf.worker.mjs" }));

class ImmediateResizeObserver {
  static callbacks: ResizeObserverCallback[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ImmediateResizeObserver.callbacks.push(callback);
  }

  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  disconnect() {}
  unobserve() {}
}

describe("PdfDocumentPreview", () => {
  beforeEach(() => {
    ImmediateResizeObserver.callbacks = [];
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillRect: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
      fillStyle: ""
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  it("coalesces the immediate resize callback instead of rendering the same canvas concurrently", async () => {
    let activeRenders = 0;
    let maxActiveRenders = 0;
    const pageRender = vi.fn(() => ({
      cancel: vi.fn(),
      promise: new Promise<void>((resolve) => {
        activeRenders += 1;
        maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
        window.setTimeout(() => {
          activeRenders -= 1;
          resolve();
        }, 10);
      })
    }));
    pdfRuntime.getDocument.mockReturnValue({
      destroy: vi.fn(),
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn().mockResolvedValue({
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: pageRender
        })
      })
    });

    render(<PdfDocumentPreview label="lecture.pdf" pageCount={1} sourceUrl="mathnotes-asset://lecture.pdf" />);

    await waitFor(() => expect(screen.getByLabelText("PDF 第 1 页").parentElement?.classList.contains("rendered")).toBe(true));
    expect(maxActiveRenders).toBe(1);
  });

  it("shows a page-level failure and retries it", async () => {
    const pageRender = vi.fn()
      .mockImplementationOnce(() => ({
        cancel: vi.fn(),
        promise: new Promise<void>((_resolve, reject) => window.setTimeout(() => reject(new Error("canvas busy")), 0))
      }))
      .mockReturnValue({ cancel: vi.fn(), promise: Promise.resolve() });
    pdfRuntime.getDocument.mockReturnValue({
      destroy: vi.fn(),
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn().mockResolvedValue({
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: pageRender
        })
      })
    });

    render(<PdfDocumentPreview label="lecture.pdf" pageCount={1} sourceUrl="mathnotes-asset://lecture.pdf" />);
    await screen.findByText(/canvas busy/);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试本页" })));
    await waitFor(() => expect(screen.getByLabelText("PDF 第 1 页").parentElement?.classList.contains("rendered")).toBe(true));
    expect(pageRender).toHaveBeenCalledTimes(2);
  });

  it("mounts only the requested source page for a recognized PDF transcript", async () => {
    pdfRuntime.getDocument.mockReturnValue({
      destroy: vi.fn(),
      promise: Promise.resolve({
        numPages: 5,
        getPage: vi.fn().mockResolvedValue({
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve() }))
        })
      })
    });

    render(
      <PdfDocumentPreview
        label="lecture.pdf"
        pageCount={5}
        pageNumbers={[4]}
        sourceUrl="mathnotes-asset://lecture.pdf"
      />
    );

    expect(await screen.findByLabelText("PDF 第 4 页")).toBeTruthy();
    expect(screen.queryByLabelText("PDF 第 1 页")).toBeNull();
    expect(screen.queryByLabelText("PDF 第 5 页")).toBeNull();
  });
});

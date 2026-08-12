import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageAnnotationEditor } from "./ImageAnnotationEditor";

const draft = {
  fileName: "blackboard.png",
  sourcePath: "C:/photos/blackboard.png",
  previewDataUrl: "data:image/png;base64,ZWRpdGVk"
};

describe("ImageAnnotationEditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the selected image before it is inserted", () => {
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={() => undefined} />);

    expect(screen.getByRole("dialog", { name: "图片编辑" })).toBeTruthy();
    expect(screen.getByText("blackboard.png")).toBeTruthy();
    expect(screen.getByAltText("待插入图片").getAttribute("src")).toBe(draft.previewDataUrl);
    expect((screen.getByRole("button", { name: "裁剪" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "旋转" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "画笔" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "箭头" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("confirms the current image as a png derivative", async () => {
    const onConfirm = vi.fn();
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        fileName: "blackboard.png",
        sourcePath: "C:/photos/blackboard.png",
        pngDataUrl: draft.previewDataUrl,
        operations: [],
        annotations: []
      })
    );
  });

  it("records a crop rectangle before inserting the derivative image", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,Y3JvcHBlZA==");

    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "裁剪" }));
    fireEvent.pointerDown(image, { clientX: 40, clientY: 20 });
    fireEvent.pointerMove(image, { clientX: 240, clientY: 120 });
    fireEvent.pointerUp(image, { clientX: 240, clientY: 120 });

    expect(screen.getByTestId("crop-selection")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        fileName: "blackboard.png",
        sourcePath: "C:/photos/blackboard.png",
        pngDataUrl: "data:image/png;base64,Y3JvcHBlZA==",
        annotations: [],
        operations: [
          {
            type: "crop",
            rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
          }
        ]
      })
    );
  });

  it("resets the current crop before inserting", async () => {
    const onConfirm = vi.fn();
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "裁剪" }));
    dragCrop(image, { x: 40, y: 20 }, { x: 240, y: 120 });
    expect(screen.getByTestId("crop-selection")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重置裁剪" }));
    expect(screen.queryByTestId("crop-selection")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        fileName: "blackboard.png",
        sourcePath: "C:/photos/blackboard.png",
        pngDataUrl: draft.previewDataUrl,
        operations: [],
        annotations: []
      })
    );
  });

  it("undoes the latest crop rectangle", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,dW5kbw==");
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "裁剪" }));
    dragCrop(image, { x: 40, y: 20 }, { x: 240, y: 120 });
    dragCrop(image, { x: 80, y: 40 }, { x: 320, y: 160 });
    fireEvent.click(screen.getByRole("button", { name: "撤销裁剪" }));
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        fileName: "blackboard.png",
        sourcePath: "C:/photos/blackboard.png",
        pngDataUrl: "data:image/png;base64,dW5kbw==",
        annotations: [],
        operations: [
          {
            type: "crop",
            rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }
          }
        ]
      })
    );
  });

  it("resizes the current crop rectangle with a corner handle", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,aGFuZGxl");
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "裁剪" }));
    dragCrop(image, { x: 40, y: 20 }, { x: 240, y: 120 });
    dragHandle("crop-handle-se", { x: 240, y: 120 }, { x: 300, y: 160 });
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        fileName: "blackboard.png",
        sourcePath: "C:/photos/blackboard.png",
        pngDataUrl: "data:image/png;base64,aGFuZGxl",
        annotations: [],
        operations: [
          {
            type: "crop",
            rect: { x: 0.1, y: 0.1, width: 0.65, height: 0.7 }
          }
        ]
      })
    );
  });

  it("keeps resizing a crop rectangle when the pointer leaves the corner handle", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,d2luZG93");
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "裁剪" }));
    dragCrop(image, { x: 40, y: 20 }, { x: 240, y: 120 });

    const handle = screen.getByTestId("crop-handle-se");
    fireEvent.pointerDown(handle, { clientX: 240, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 160, pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        fileName: "blackboard.png",
        sourcePath: "C:/photos/blackboard.png",
        pngDataUrl: "data:image/png;base64,d2luZG93",
        annotations: [],
        operations: [
          {
            type: "crop",
            rect: { x: 0.1, y: 0.1, width: 0.65, height: 0.7 }
          }
        ]
      })
    );
  });

  it("rasterizes a png-looking non-base64 preview before IPC confirmation", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,bm9ybWFsaXplZA==");
    render(<ImageAnnotationEditor
      draft={{ ...draft, previewDataUrl: "data:image/png;charset=utf-8,not-base64" }}
      onCancel={() => undefined}
      onConfirm={onConfirm}
    />);
    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      pngDataUrl: "data:image/png;base64,bm9ybWFsaXplZA=="
    })));
  });

  it("records a freehand lasso before inserting the white-background derivative", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,bGFzc28=");
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);
    fireEvent.click(screen.getByRole("button", { name: "套索" }));
    fireEvent.pointerDown(image, { clientX: 40, clientY: 20 });
    fireEvent.pointerMove(image, { clientX: 240, clientY: 20 });
    fireEvent.pointerMove(image, { clientX: 240, clientY: 120 });
    fireEvent.pointerMove(image, { clientX: 40, clientY: 120 });
    fireEvent.pointerUp(image, { clientX: 40, clientY: 120 });

    expect(screen.getByTestId("lasso-selection")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      fileName: "blackboard.png",
      sourcePath: "C:/photos/blackboard.png",
      pngDataUrl: "data:image/png;base64,bGFzc28=",
      annotations: [],
      operations: [{
        type: "lasso",
        boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
        outsideFill: "#ffffff",
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.6, y: 0.1 },
          { x: 0.6, y: 0.6 },
          { x: 0.1, y: 0.6 }
        ]
      }]
    }));
  });

  it("rotates the image before inserting it", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,cm90YXRlZA==");
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "旋转" }));
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        fileName: "blackboard.png",
        sourcePath: "C:/photos/blackboard.png",
        pngDataUrl: "data:image/png;base64,cm90YXRlZA==",
        annotations: [],
        operations: [
          {
            type: "rotate",
            quarterTurns: 1
          }
        ]
      })
    );
  });

  it("moves a perspective corner and records the ordered transform", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,cGVyc3BlY3RpdmU=");
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);
    fireEvent.click(screen.getByRole("button", { name: "透视" }));
    const corner = screen.getByRole("button", { name: "透视角点 1" });
    fireEvent.pointerDown(corner, { clientX: 8, clientY: 4 });
    fireEvent.pointerMove(corner, { clientX: 40, clientY: 20 });
    fireEvent.pointerUp(corner, { clientX: 40, clientY: 20 });
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].operations).toEqual([{
      type: "perspective",
      corners: [
        { x: 0.1, y: 0.1 },
        { x: 0.98, y: 0.02 },
        { x: 0.98, y: 0.98 },
        { x: 0.02, y: 0.98 }
      ]
    }]);
  });

  it("draws, records and deletes vector annotations", async () => {
    const onConfirm = vi.fn();
    mockCanvasOutput("data:image/png;base64,YW5ub3RhdGVk");
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);
    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "箭头" }));
    fireEvent.pointerDown(image, { clientX: 40, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 240, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 240, clientY: 120 });
    expect(screen.getByTestId("object-annotation-layer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].annotations).toEqual([expect.objectContaining({
      type: "arrow",
      start: { x: 0.1, y: 0.1 },
      end: { x: 0.6, y: 0.6 },
      color: "#187857",
      width: 0.006
    })]);

    fireEvent.click(screen.getByRole("button", { name: "删除标注" }));
    expect(screen.queryByTestId("object-annotation-layer")).toBeNull();
  });

  it("applies the current operation as the base for the next edit stage", async () => {
    mockCanvasOutput("data:image/png;base64,YXBwbGllZA==");
    const onConfirm = vi.fn();
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    const applyButton = screen.getByRole("button", { name: "应用当前操作" }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "旋转" }));
    expect(applyButton.disabled).toBe(false);
    fireEvent.click(applyButton);

    await waitFor(() => expect(screen.getByAltText("待插入图片").getAttribute("src")).toBe("data:image/png;base64,YXBwbGllZA=="));
    expect(applyButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      fileName: "blackboard.png",
      sourcePath: "C:/photos/blackboard.png",
      pngDataUrl: "data:image/png;base64,YXBwbGllZA==",
      annotations: [],
      operations: [{ type: "rotate", quarterTurns: 1 }]
    }));
  });

  it("undoes an operation after it has been applied to the editing baseline", async () => {
    mockCanvasOutput("data:image/png;base64,YXBwbGllZA==");
    const onConfirm = vi.fn();
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("button", { name: "旋转" }));
    fireEvent.click(screen.getByRole("button", { name: "应用当前操作" }));
    await waitFor(() => expect(screen.getByAltText("待插入图片").getAttribute("src")).toBe("data:image/png;base64,YXBwbGllZA=="));

    const undoButton = screen.getByRole("button", { name: "撤销上一步" }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(false);
    fireEvent.click(undoButton);
    await waitFor(() => expect(screen.getByAltText("待插入图片").getAttribute("src")).toBe(draft.previewDataUrl));

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      pngDataUrl: draft.previewDataUrl,
      operations: []
    })));
  });

  it("uses the selected annotation color for new arrows", async () => {
    mockCanvasOutput("data:image/png;base64,cmVkLWFycm93");
    const onConfirm = vi.fn();
    render(<ImageAnnotationEditor draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);
    const image = screen.getByAltText("待插入图片") as HTMLImageElement;
    mockImageGeometry(image);

    fireEvent.click(screen.getByRole("button", { name: "标注颜色 #d84b3e" }));
    fireEvent.click(screen.getByRole("button", { name: "箭头" }));
    fireEvent.pointerDown(image, { clientX: 40, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 240, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 240, clientY: 120 });
    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].annotations).toEqual([
      expect.objectContaining({ type: "arrow", color: "#d84b3e" })
    ]);
  });
});

function mockCanvasOutput(pngDataUrl: string) {
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    if (tagName.toLowerCase() !== "canvas") {
      return originalCreateElement(tagName, options);
    }
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        beginPath: vi.fn(),
        clip: vi.fn(),
        closePath: vi.fn(),
        createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        getImageData: (_x: number, _y: number, width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        lineTo: vi.fn(),
        moveTo: vi.fn(),
        putImageData: vi.fn(),
        restore: vi.fn(),
        rotate: vi.fn(),
        save: vi.fn(),
        stroke: vi.fn(),
        translate: vi.fn()
      }),
      toDataURL: () => pngDataUrl
    } as unknown as HTMLCanvasElement;
  });
}

function mockImageGeometry(image: HTMLImageElement) {
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 400 });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: 200 });
  image.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      toJSON: () => ({})
    }) as DOMRect;
}

function dragCrop(image: HTMLImageElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(image, { clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(image, { clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(image, { clientX: to.x, clientY: to.y });
}

function dragHandle(testId: string, from: { x: number; y: number }, to: { x: number; y: number }) {
  const handle = screen.getByTestId(testId);
  fireEvent.pointerDown(handle, { clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(handle, { clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(handle, { clientX: to.x, clientY: to.y });
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildImageEditOperations,
  isBase64PngDataUrl,
  normalizeRotationDegrees,
  PERSPECTIVE_FRAGMENT_SHADER_SOURCE,
  perspectiveOutputSize,
  projectPerspectivePoint,
  renderImageEditsToPngDataUrl,
  type PerspectiveCorners
} from "./imageAnnotationTransforms";

const sourceDataUrl = "data:image/png;base64,c291cmNl";

describe("imageAnnotationTransforms", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds stable operations for crop and normalized rotation", () => {
    expect(buildImageEditOperations({ x: 10, y: 20, width: 100, height: 50 }, 450, { width: 200, height: 100 })).toEqual([
      { type: "rotate", quarterTurns: 1 },
      { type: "crop", rect: { x: 0.05, y: 0.2, width: 0.5, height: 0.5 } }
    ]);
  });

  it("omits no-op rotation operations", () => {
    expect(buildImageEditOperations(null, 360)).toEqual([]);
    expect(normalizeRotationDegrees(-90)).toBe(270);
  });

  it("accepts only strict base64 png data urls and rasterizes png-looking payloads", async () => {
    expect(isBase64PngDataUrl("data:image/png;base64,c291cmNl")).toBe(true);
    expect(isBase64PngDataUrl(" data:image/png;base64,c291cmNl ")).toBe(true);
    expect(isBase64PngDataUrl("data:image/png;charset=utf-8,not-base64")).toBe(false);

    const image = mockImageElement(400, 200);
    mockCanvasOutput("data:image/png;base64,bm9ybWFsaXplZA==");
    await expect(renderImageEditsToPngDataUrl({
      dataUrl: "data:image/png;charset=utf-8,not-base64",
      currentImage: image
    })).resolves.toBe("data:image/png;base64,bm9ybWFsaXplZA==");
  });

  it("records and renders a normalized lasso selection on a white png canvas", async () => {
    const points = [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.8 },
      { x: 0.1, y: 0.8 }
    ];
    expect(buildImageEditOperations(null, 0, { width: 400, height: 200 }, points)).toEqual([
      {
        type: "lasso",
        points,
        boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.6 },
        outsideFill: "#ffffff"
      }
    ]);

    const image = mockImageElement(400, 200);
    const canvas = mockCanvasOutput("data:image/png;base64,bGFzc28=");
    const result = await renderImageEditsToPngDataUrl({
      dataUrl: sourceDataUrl,
      lassoPoints: points,
      currentImage: image
    });

    expect(result).toBe("data:image/png;base64,bGFzc28=");
    expect(canvas.width).toBe(160);
    expect(canvas.height).toBe(120);
  });

  it("renders a rotated current image into a png data url", async () => {
    const image = mockImageElement(400, 200);
    const canvas = mockCanvasOutput("data:image/png;base64,cm90YXRlZA==");

    const result = await renderImageEditsToPngDataUrl({
      dataUrl: sourceDataUrl,
      rotationDegrees: 90,
      currentImage: image
    });

    expect(result).toBe("data:image/png;base64,cm90YXRlZA==");
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(400);
  });

  it("burns vector annotations into the derived png", async () => {
    const image = mockImageElement(400, 200);
    const canvas = mockCanvasOutput("data:image/png;base64,YW5ub3RhdGVk");
    const result = await renderImageEditsToPngDataUrl({
      dataUrl: sourceDataUrl,
      currentImage: image,
      annotations: [
        { id: "pen-1", type: "pen", points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }], color: "#187857", width: 0.006 },
        { id: "arrow-1", type: "arrow", start: { x: 0.2, y: 0.2 }, end: { x: 0.8, y: 0.7 }, color: "#187857", width: 0.006 }
      ]
    });
    expect(result).toBe("data:image/png;base64,YW5ub3RhdGVk");
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
  });

  it("records perspective before crop and maps the destination rectangle into the source quadrilateral", () => {
    const corners: PerspectiveCorners = [
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.1 },
      { x: 0.8, y: 0.9 },
      { x: 0.2, y: 0.8 }
    ];
    expect(buildImageEditOperations({ x: 10, y: 20, width: 100, height: 50 }, 90, { width: 200, height: 100 }, null, corners)).toEqual([
      { type: "rotate", quarterTurns: 1 },
      { type: "perspective", corners },
      { type: "crop", rect: { x: 0.05, y: 0.2, width: 0.5, height: 0.5 } }
    ]);
    corners.forEach((corner, index) => {
      const [u, v] = [[0, 0], [1, 0], [1, 1], [0, 1]][index];
      const projected = projectPerspectivePoint(corners, u, v);
      expect(projected.x).toBeCloseTo(corner.x, 10);
      expect(projected.y).toBeCloseTo(corner.y, 10);
    });
    expect(perspectiveOutputSize({ width: 1000, height: 500 }, corners)).toEqual({ width: 802, height: 412 });
  });

  it("keeps WebGL perspective texture coordinates in the same vertical orientation", () => {
    expect(PERSPECTIVE_FRAGMENT_SHADER_SOURCE).toContain("texture2D(u_image, source_uv)");
    expect(PERSPECTIVE_FRAGMENT_SHADER_SOURCE).not.toContain("1.0 - source_uv.y");
  });
});

function mockImageElement(width: number, height: number): HTMLImageElement {
  return {
    naturalWidth: width,
    naturalHeight: height,
    width,
    height
  } as HTMLImageElement;
}

function mockCanvasOutput(pngDataUrl: string) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      beginPath: vi.fn(),
      clip: vi.fn(),
      closePath: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
      translate: vi.fn()
    }),
    toDataURL: () => pngDataUrl
  } as unknown as HTMLCanvasElement;
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    if (tagName.toLowerCase() !== "canvas") {
      return originalCreateElement(tagName, options);
    }
    return canvas;
  });
  return canvas;
}

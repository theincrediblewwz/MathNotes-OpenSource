import { describe, expect, it } from "vitest";
import { centeredCrop, DEFAULT_CAPTURE_EDIT, rotateCapture, fittedCaptureRect, capturePointInRect, moveCaptureCropCorner, capturePerspectiveProjector, validCaptureQuad, type CaptureQuad } from "./captureEditing";

describe("capture editing geometry", () => {
  it("rotates in reversible quarter turns", () => {
    const right = rotateCapture(DEFAULT_CAPTURE_EDIT, "right");
    expect(right.rotation).toBe(90);
    expect(rotateCapture(right, "left").rotation).toBe(0);
  });

  it("uses a centered crop without stretching the photo", () => {
    expect(centeredCrop(4_000, 3_000, "4:3")).toEqual({
      x: 0,
      y: 0,
      width: 4_000,
      height: 3_000
    });
    expect(centeredCrop(4_000, 3_000, "square")).toEqual({
      x: 500,
      y: 0,
      width: 3_000,
      height: 3_000
    });
  });

  it("maps crop handles through display padding without shifting the exported coordinates", () => {
    const fitted = fittedCaptureRect(400, 400, 800, 600);
    expect(fitted).toEqual({ x: 28, y: 71, width: 344, height: 258 });
    const point = capturePointInRect(114, 135.5, fitted);
    expect(point).toEqual({ x: .25, y: .25 });
    expect(moveCaptureCropCorner({ x: 0, y: 0, width: 1, height: 1 }, 0, point)).toEqual({ x: .25, y: .25, width: .75, height: .75 });
  });

  it("rotates privacy masks and crop boundaries with the image", () => {
    const edit = { ...DEFAULT_CAPTURE_EDIT, cropRect: { x: .1, y: .2, width: .4, height: .5 }, marks: [{ type: "redaction" as const, points: [{ x: .2, y: .3 }], width: .05 }] };
    const right = rotateCapture(edit, "right");
    expect(right.marks?.[0].points).toEqual([{ x: .7, y: .2 }]);
    expect(right.cropRect?.x).toBeCloseTo(.3);
    expect(right.cropRect?.y).toBeCloseTo(.1);
    expect(right.cropRect?.width).toBeCloseTo(.5);
    const restored = rotateCapture(right, "left");
    expect(restored.marks?.[0].points[0].x).toBeCloseTo(.2);
    expect(restored.marks?.[0].points[0].y).toBeCloseTo(.3);
  });

  it("maps perspective corners exactly and rejects crossed edges", () => {
    const corners: CaptureQuad = [{x:.1,y:.2},{x:.9,y:.1},{x:.8,y:.9},{x:.2,y:.8}];
    const project = capturePerspectiveProjector(corners);
    expect(project(0,0)).toEqual(corners[0]);
    expect(project(1,0).x).toBeCloseTo(corners[1].x);
    expect(project(1,1).y).toBeCloseTo(corners[2].y);
    expect(validCaptureQuad([corners[0],corners[2],corners[1],corners[3]])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { centeredCrop, DEFAULT_CAPTURE_EDIT, rotateCapture } from "./captureEditing";

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
});

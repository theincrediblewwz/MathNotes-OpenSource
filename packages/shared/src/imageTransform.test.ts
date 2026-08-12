import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMAGE_TRANSFORM_OUTSIDE_FILL,
  assertValidImageTransformSidecar,
  isValidPerspectiveCorners,
  normalizeImageTransformOperations,
  type ImageTransformOperation
} from "./imageTransform";

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../contracts/image-transform-v1-fixtures.json"), "utf8")
) as { cases: Array<{ name: string; input: ImageTransformOperation[]; expected: ImageTransformOperation[] }> };

describe("image transform contract", () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      expect(normalizeImageTransformOperations(testCase.input)).toEqual(testCase.expected);
    });
  }

  it("accepts normalized auditable sidecars", () => {
    expect(() => assertValidImageTransformSidecar({
      version: 1,
      sourceAsset: "assets/photos/original.jpg",
      sourceSha256: "a".repeat(64),
      outputMimeType: "image/png",
      operations: [{
        type: "lasso",
        points: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.5, y: 0.7 }],
        boundingBox: { x: 0.1, y: 0.1, width: 0.7, height: 0.6 },
        outsideFill: IMAGE_TRANSFORM_OUTSIDE_FILL
      }],
      createdAt: "2026-07-15T00:00:00.000Z"
    })).not.toThrow();
  });

  it("rejects absolute or traversing asset paths", () => {
    const base = {
      version: 1 as const,
      sourceSha256: "a".repeat(64),
      outputMimeType: "image/png" as const,
      operations: [] as ImageTransformOperation[],
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    expect(() => assertValidImageTransformSidecar({ ...base, sourceAsset: "C:/private/photo.jpg" })).toThrow(
      /portable relative asset path/
    );
    expect(() => assertValidImageTransformSidecar({ ...base, sourceAsset: "../photo.jpg" })).toThrow(
      /portable relative asset path/
    );
  });

  it("accepts convex perspective corners and rejects crossing corners", () => {
    expect(isValidPerspectiveCorners([
      { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.15 }, { x: 0.85, y: 0.9 }, { x: 0.15, y: 0.85 }
    ])).toBe(true);
    expect(isValidPerspectiveCorners([
      { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }
    ])).toBe(false);
  });

  it("accepts auditable pen and arrow annotations", () => {
    expect(() => assertValidImageTransformSidecar({
      version: 1,
      sourceAsset: "assets/photos/original.jpg",
      sourceSha256: "a".repeat(64),
      outputMimeType: "image/png",
      operations: [],
      annotations: [
        { id: "pen-1", type: "pen", points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }], color: "#187857", width: 0.006 },
        { id: "arrow-1", type: "arrow", start: { x: 0.2, y: 0.2 }, end: { x: 0.8, y: 0.7 }, color: "#187857", width: 0.006 }
      ],
      createdAt: "2026-07-15T00:00:00.000Z"
    })).not.toThrow();
  });

  it("rejects malformed annotation objects", () => {
    const base = {
      version: 1 as const,
      sourceAsset: "assets/photos/original.jpg",
      sourceSha256: "a".repeat(64),
      outputMimeType: "image/png" as const,
      operations: [] as ImageTransformOperation[],
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    expect(() => assertValidImageTransformSidecar({
      ...base,
      annotations: [{ id: "arrow-1", type: "arrow", start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 }, color: "#187857", width: 0.006 }]
    })).toThrow(/too short/);
    expect(() => assertValidImageTransformSidecar({
      ...base,
      annotations: [{ id: "pen-1", type: "pen", points: [{ x: -0.1, y: 0.2 }, { x: 0.4, y: 0.5 }], color: "green", width: 0.006 }]
    })).toThrow();
  });
});

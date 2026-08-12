export const IMAGE_TRANSFORM_VERSION = 1 as const;
export const IMAGE_TRANSFORM_OUTSIDE_FILL = "#ffffff" as const;

export type NormalizedPoint = {
  x: number;
  y: number;
};

export type NormalizedRect = NormalizedPoint & {
  width: number;
  height: number;
};

export type ImageTransformOperation =
  | { type: "rotate"; quarterTurns: 1 | 2 | 3 }
  | { type: "perspective"; corners: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint] }
  | { type: "crop"; rect: NormalizedRect }
  | { type: "lasso"; points: NormalizedPoint[]; boundingBox: NormalizedRect; outsideFill: typeof IMAGE_TRANSFORM_OUTSIDE_FILL };

export type ImageAnnotationObject =
  | { id: string; type: "pen"; points: NormalizedPoint[]; color: string; width: number }
  | { id: string; type: "arrow"; start: NormalizedPoint; end: NormalizedPoint; color: string; width: number };

export type ImageTransformSidecar = {
  version: typeof IMAGE_TRANSFORM_VERSION;
  sourceAsset: string;
  sourceSha256: string;
  outputAsset?: string;
  outputMimeType: "image/png";
  operations: ImageTransformOperation[];
  annotations?: ImageAnnotationObject[];
  createdAt: string;
};

const operationOrder: Record<ImageTransformOperation["type"], number> = {
  rotate: 0,
  perspective: 1,
  crop: 2,
  lasso: 3
};

export function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return roundNormalized(Math.min(1, Math.max(0, value)));
}

export function normalizePoint(point: NormalizedPoint): NormalizedPoint {
  return { x: clampNormalized(point.x), y: clampNormalized(point.y) };
}

export function normalizeRect(rect: NormalizedRect): NormalizedRect {
  const start = normalizePoint(rect);
  const end = normalizePoint({ x: rect.x + rect.width, y: rect.y + rect.height });
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    x: left,
    y: top,
    width: roundNormalized(Math.max(0, Math.max(start.x, end.x) - left)),
    height: roundNormalized(Math.max(0, Math.max(start.y, end.y) - top))
  };
}

export function boundingBoxForPoints(points: NormalizedPoint[]): NormalizedRect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const normalized = points.map(normalizePoint);
  const xs = normalized.map((point) => point.x);
  const ys = normalized.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: roundNormalized(Math.max(...xs) - left),
    height: roundNormalized(Math.max(...ys) - top)
  };
}

export function isValidPerspectiveCorners(
  corners: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint]
): boolean {
  const normalized = corners.map(normalizePoint);
  const crosses = normalized.map((point, index) => {
    const next = normalized[(index + 1) % normalized.length];
    const after = normalized[(index + 2) % normalized.length];
    return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
  });
  const direction = Math.sign(crosses.find((value) => Math.abs(value) > 1e-6) ?? 0);
  const area = Math.abs(normalized.reduce((sum, point, index) => {
    const next = normalized[(index + 1) % normalized.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
  return direction !== 0 && area >= 0.001 && crosses.every((value) => Math.sign(value) === direction && Math.abs(value) > 1e-6);
}

function roundNormalized(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function normalizeImageTransformOperations(
  operations: ImageTransformOperation[]
): ImageTransformOperation[] {
  const normalized = operations.map((operation): ImageTransformOperation => {
    switch (operation.type) {
      case "rotate":
        return operation;
      case "perspective":
        return {
          ...operation,
          corners: operation.corners.map(normalizePoint) as [
            NormalizedPoint,
            NormalizedPoint,
            NormalizedPoint,
            NormalizedPoint
          ]
        };
      case "crop":
        return { ...operation, rect: normalizeRect(operation.rect) };
      case "lasso": {
        const points = operation.points.map(normalizePoint);
        return {
          ...operation,
          points,
          boundingBox: boundingBoxForPoints(points),
          outsideFill: IMAGE_TRANSFORM_OUTSIDE_FILL
        };
      }
    }
  });

  return normalized
    .map((operation, index) => ({ operation, index }))
    .sort((left, right) => operationOrder[left.operation.type] - operationOrder[right.operation.type] || left.index - right.index)
    .map(({ operation }) => operation);
}

export function assertValidImageTransformSidecar(sidecar: ImageTransformSidecar): void {
  if (sidecar.version !== IMAGE_TRANSFORM_VERSION) throw new Error("Unsupported image transform version.");
  assertPortableAssetPath(sidecar.sourceAsset, "sourceAsset");
  if (sidecar.outputAsset) assertPortableAssetPath(sidecar.outputAsset, "outputAsset");
  if (!/^[a-f0-9]{64}$/i.test(sidecar.sourceSha256)) throw new Error("sourceSha256 must be a SHA-256 hex digest.");
  if (sidecar.outputMimeType !== "image/png") throw new Error("Image transform output must be PNG.");

  const normalized = normalizeImageTransformOperations(sidecar.operations);
  if (JSON.stringify(normalized) !== JSON.stringify(sidecar.operations)) {
    throw new Error("Image transform operations are not normalized or ordered.");
  }

  for (const operation of sidecar.operations) {
    if (operation.type === "perspective" && !isValidPerspectiveCorners(operation.corners)) {
      throw new Error("Perspective corners must form a non-self-intersecting convex quadrilateral.");
    }
    if (operation.type === "crop" && (operation.rect.width <= 0 || operation.rect.height <= 0)) {
      throw new Error("Crop rectangle must have positive area.");
    }
    if (operation.type === "lasso") {
      if (operation.points.length < 3) throw new Error("Lasso requires at least three points.");
      if (operation.boundingBox.width <= 0 || operation.boundingBox.height <= 0) {
        throw new Error("Lasso bounding box must have positive area.");
      }
    }
  }
  for (const annotation of sidecar.annotations ?? []) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(annotation.id)) throw new Error("Annotation id is invalid.");
    if (!/^#[0-9a-f]{6}$/i.test(annotation.color)) throw new Error("Annotation color must be a six-digit hex value.");
    if (!Number.isFinite(annotation.width) || annotation.width < 0.001 || annotation.width > 0.1) {
      throw new Error("Annotation width is outside the supported normalized range.");
    }
    if (annotation.type === "pen") {
      if (annotation.points.length < 2) throw new Error("Pen annotation requires at least two points.");
      annotation.points.forEach(assertNormalizedPoint);
    } else {
      assertNormalizedPoint(annotation.start);
      assertNormalizedPoint(annotation.end);
      if (Math.hypot(annotation.end.x - annotation.start.x, annotation.end.y - annotation.start.y) < 0.002) {
        throw new Error("Arrow annotation is too short.");
      }
    }
  }
}

function assertNormalizedPoint(point: NormalizedPoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error("Annotation point must use normalized coordinates.");
  }
}

function assertPortableAssetPath(value: string, field: string): void {
  const normalized = value.replace(/\\/g, "/");
  if (
    !normalized.trim() ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`${field} must be a portable relative asset path.`);
  }
}

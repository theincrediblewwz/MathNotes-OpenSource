import {
  isValidPerspectiveCorners,
  normalizeImageTransformOperations,
  type ImageTransformOperation,
  type ImageAnnotationObject,
  type NormalizedPoint,
  type NormalizedRect
} from "@mathnotes/shared";

export type ImageCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RenderImageEditsInput = {
  dataUrl: string;
  perspectiveCorners?: PerspectiveCorners | null;
  cropRect?: ImageCropRect | null;
  lassoPoints?: NormalizedPoint[] | null;
  rotationDegrees?: number;
  currentImage?: HTMLImageElement | null;
  annotations?: ImageAnnotationObject[];
};

export type PerspectiveCorners = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

const BASE64_PNG_DATA_URL = /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/;

export function isBase64PngDataUrl(dataUrl: string): boolean {
  return BASE64_PNG_DATA_URL.test(dataUrl.trim());
}

export const PERSPECTIVE_FRAGMENT_SHADER_SOURCE = `
  precision highp float;
  uniform sampler2D u_image;
  uniform mat3 u_square_to_source;
  varying vec2 v_output_uv;
  void main() {
    vec3 mapped = u_square_to_source * vec3(v_output_uv, 1.0);
    vec2 source_uv = mapped.xy / mapped.z;
    gl_FragColor = texture2D(u_image, source_uv);
  }
`;

export function normalizeRotationDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function buildImageEditOperations(
  cropRect: ImageCropRect | null,
  rotationDegrees: number,
  imageSize: { width: number; height: number } = { width: 1, height: 1 },
  lassoPoints: NormalizedPoint[] | null = null,
  perspectiveCorners: PerspectiveCorners | null = null
): ImageTransformOperation[] {
  const normalizedRotation = normalizeRotationDegrees(rotationDegrees);
  const quarterTurns = normalizedRotation / 90 as 0 | 1 | 2 | 3;
  const lassoOperation: ImageTransformOperation[] = lassoPoints && lassoPoints.length >= 3
    ? [{
        type: "lasso",
        points: lassoPoints,
        boundingBox: pointsBoundingBox(lassoPoints),
        outsideFill: "#ffffff"
      }]
    : [];
  const operations: ImageTransformOperation[] = [
    ...(quarterTurns ? [{ type: "rotate" as const, quarterTurns }] : []),
    ...(perspectiveCorners && isValidPerspectiveCorners(perspectiveCorners)
      ? [{ type: "perspective" as const, corners: perspectiveCorners }]
      : []),
    ...(cropRect ? [{ type: "crop" as const, rect: pixelRectToNormalized(cropRect, imageSize) }] : []),
    ...lassoOperation
  ];
  return normalizeImageTransformOperations(operations);
}

export async function renderImageEditsToPngDataUrl(input: RenderImageEditsInput): Promise<string> {
  const normalizedRotation = normalizeRotationDegrees(input.rotationDegrees ?? 0);
  const rotatedDataUrl = normalizedRotation
    ? await rotateImageDataUrl(input.dataUrl, normalizedRotation, input.currentImage ?? null)
    : null;
  const annotatedDataUrl = input.annotations?.length
    ? await renderAnnotationsToPngDataUrl(
        rotatedDataUrl ?? input.dataUrl,
        input.annotations,
        normalizedRotation ? null : input.currentImage ?? null
      )
    : null;
  const perspectiveDataUrl = input.perspectiveCorners && isValidPerspectiveCorners(input.perspectiveCorners)
    ? await perspectiveImageDataUrl(
        annotatedDataUrl ?? rotatedDataUrl ?? input.dataUrl,
        input.perspectiveCorners,
        annotatedDataUrl || normalizedRotation ? null : input.currentImage ?? null
      )
    : null;
  const transformedDataUrl = perspectiveDataUrl ?? annotatedDataUrl ?? rotatedDataUrl ?? input.dataUrl;
  if (input.lassoPoints && input.lassoPoints.length >= 3) {
    return lassoImageDataUrl(transformedDataUrl, input.lassoPoints, perspectiveDataUrl || normalizedRotation ? null : input.currentImage ?? null);
  }
  if (input.cropRect) {
    return cropImageDataUrl(transformedDataUrl, input.cropRect, perspectiveDataUrl || normalizedRotation ? null : input.currentImage ?? null);
  }
  return perspectiveDataUrl ?? annotatedDataUrl ?? rotatedDataUrl ?? ensurePngDataUrl(input.dataUrl, input.currentImage ?? null);
}

export async function renderAnnotationsToPngDataUrl(
  dataUrl: string,
  annotations: ImageAnnotationObject[],
  currentImage: HTMLImageElement | null = null
): Promise<string> {
  const image = currentImage ?? await loadImage(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is not available.");
  context.drawImage(image, 0, 0);
  const scale = Math.min(width, height);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const annotation of annotations) {
    context.strokeStyle = annotation.color;
    context.lineWidth = Math.max(1, annotation.width * scale);
    context.beginPath();
    if (annotation.type === "pen") {
      annotation.points.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      continue;
    }
    const startX = annotation.start.x * width;
    const startY = annotation.start.y * height;
    const endX = annotation.end.x * width;
    const endY = annotation.end.y * height;
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    const angle = Math.atan2(endY - startY, endX - startX);
    const headLength = Math.max(context.lineWidth * 4, scale * 0.025);
    const spread = Math.PI / 7;
    context.moveTo(endX, endY);
    context.lineTo(endX - headLength * Math.cos(angle - spread), endY - headLength * Math.sin(angle - spread));
    context.moveTo(endX, endY);
    context.lineTo(endX - headLength * Math.cos(angle + spread), endY - headLength * Math.sin(angle + spread));
    context.stroke();
  }
  return canvas.toDataURL("image/png");
}

export function perspectiveOutputSize(
  imageSize: { width: number; height: number },
  corners: PerspectiveCorners
): { width: number; height: number } {
  const pixels = corners.map((point) => ({ x: point.x * imageSize.width, y: point.y * imageSize.height }));
  return {
    width: Math.max(1, Math.round(Math.max(pointDistance(pixels[0], pixels[1]), pointDistance(pixels[3], pixels[2])))),
    height: Math.max(1, Math.round(Math.max(pointDistance(pixels[0], pixels[3]), pointDistance(pixels[1], pixels[2]))))
  };
}

export function projectPerspectivePoint(corners: PerspectiveCorners, u: number, v: number): NormalizedPoint {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    if (Math.abs(determinant) < 1e-12) throw new Error("Perspective quadrilateral is singular.");
    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }
  const a = topRight.x - topLeft.x + g * topRight.x;
  const b = bottomLeft.x - topLeft.x + h * bottomLeft.x;
  const d = topRight.y - topLeft.y + g * topRight.y;
  const e = bottomLeft.y - topLeft.y + h * bottomLeft.y;
  const denominator = g * u + h * v + 1;
  return {
    x: (a * u + b * v + topLeft.x) / denominator,
    y: (d * u + e * v + topLeft.y) / denominator
  };
}

async function perspectiveImageDataUrl(
  dataUrl: string,
  corners: PerspectiveCorners,
  currentImage: HTMLImageElement | null
): Promise<string> {
  if (!isValidPerspectiveCorners(corners)) throw new Error("Perspective corners must form a convex quadrilateral.");
  const image = currentImage ?? await loadImage(dataUrl);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const outputSize = perspectiveOutputSize({ width: sourceWidth, height: sourceHeight }, corners);
  const accelerated = renderPerspectiveWithWebGl(image, corners, outputSize);
  if (accelerated) return accelerated;

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) throw new Error("Canvas 2D context is not available.");
  sourceContext.drawImage(image, 0, 0);
  const sourcePixels = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight);
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = outputSize.width;
  outputCanvas.height = outputSize.height;
  const outputContext = outputCanvas.getContext("2d");
  if (!outputContext) throw new Error("Canvas 2D context is not available.");
  const outputPixels = outputContext.createImageData(outputSize.width, outputSize.height);
  outputPixels.data.fill(255);

  for (let y = 0; y < outputSize.height; y += 1) {
    const v = outputSize.height === 1 ? 0 : y / (outputSize.height - 1);
    for (let x = 0; x < outputSize.width; x += 1) {
      const u = outputSize.width === 1 ? 0 : x / (outputSize.width - 1);
      const sourcePoint = projectPerspectivePoint(corners, u, v);
      copyBilinearPixel(sourcePixels, sourcePoint.x * (sourceWidth - 1), sourcePoint.y * (sourceHeight - 1), outputPixels, x, y);
    }
    if (y > 0 && y % 64 === 0) await yieldToRenderer();
  }
  outputContext.putImageData(outputPixels, 0, 0);
  return outputCanvas.toDataURL("image/png");
}

function renderPerspectiveWithWebGl(
  image: HTMLImageElement,
  corners: PerspectiveCorners,
  outputSize: { width: number; height: number }
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize.width;
  canvas.height = outputSize.height;
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
  if (!gl || typeof gl.createShader !== "function") return null;

  try {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      attribute vec2 a_output_uv;
      varying vec2 v_output_uv;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_output_uv = a_output_uv;
      }
    `);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, PERSPECTIVE_FRAGMENT_SHADER_SOURCE);
    const program = gl.createProgram();
    if (!program) throw new Error("Unable to create WebGL program.");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Unable to link WebGL program.");
    }
    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    const uvBuffer = gl.createBuffer();
    if (!positionBuffer || !uvBuffer) throw new Error("Unable to create WebGL buffers.");
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1, 1, 1, 0, 0,
      0, 0, 1, 1, 1, 0
    ]), gl.STATIC_DRAW);
    const uvLocation = gl.getAttribLocation(program, "a_output_uv");
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    if (!texture) throw new Error("Unable to create WebGL texture.");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(program, "u_square_to_source"), false, squareToQuadMatrix(corners));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const result = canvas.toDataURL("image/png");
    gl.deleteTexture(texture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(uvBuffer);
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return result;
  } catch {
    return null;
  }
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unable to compile WebGL shader.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function squareToQuadMatrix(corners: PerspectiveCorners): Float32Array {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const determinant = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(dx3) <= 1e-12 && Math.abs(dy3) <= 1e-12 ? 0 : (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = Math.abs(dx3) <= 1e-12 && Math.abs(dy3) <= 1e-12 ? 0 : (dx1 * dy3 - dx3 * dy1) / determinant;
  const a = topRight.x - topLeft.x + g * topRight.x;
  const b = bottomLeft.x - topLeft.x + h * bottomLeft.x;
  const d = topRight.y - topLeft.y + g * topRight.y;
  const e = bottomLeft.y - topLeft.y + h * bottomLeft.y;
  return new Float32Array([a, d, g, b, e, h, topLeft.x, topLeft.y, 1]);
}

function copyBilinearPixel(
  source: ImageData,
  sourceX: number,
  sourceY: number,
  target: ImageData,
  targetX: number,
  targetY: number
) {
  const x0 = Math.floor(clamp(sourceX, 0, source.width - 1));
  const y0 = Math.floor(clamp(sourceY, 0, source.height - 1));
  const x1 = Math.min(source.width - 1, x0 + 1);
  const y1 = Math.min(source.height - 1, y0 + 1);
  const tx = sourceX - x0;
  const ty = sourceY - y0;
  const targetOffset = (targetY * target.width + targetX) * 4;
  for (let channel = 0; channel < 4; channel += 1) {
    const top = source.data[(y0 * source.width + x0) * 4 + channel] * (1 - tx) + source.data[(y0 * source.width + x1) * 4 + channel] * tx;
    const bottom = source.data[(y1 * source.width + x0) * 4 + channel] * (1 - tx) + source.data[(y1 * source.width + x1) * 4 + channel] * tx;
    target.data[targetOffset + channel] = Math.round(top * (1 - ty) + bottom * ty);
  }
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function lassoImageDataUrl(
  dataUrl: string,
  points: NormalizedPoint[],
  currentImage: HTMLImageElement | null
): Promise<string> {
  const image = currentImage ?? await loadImage(dataUrl);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const pixelPoints = points.map((point) => ({
    x: clamp(point.x, 0, 1) * sourceWidth,
    y: clamp(point.y, 0, 1) * sourceHeight
  }));
  const left = Math.floor(Math.min(...pixelPoints.map((point) => point.x)));
  const top = Math.floor(Math.min(...pixelPoints.map((point) => point.y)));
  const right = Math.ceil(Math.max(...pixelPoints.map((point) => point.x)));
  const bottom = Math.ceil(Math.max(...pixelPoints.map((point) => point.y)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, right - left);
  canvas.height = Math.max(1, bottom - top);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is not available.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.beginPath();
  context.moveTo(pixelPoints[0].x - left, pixelPoints[0].y - top);
  pixelPoints.slice(1).forEach((point) => context.lineTo(point.x - left, point.y - top));
  context.closePath();
  context.clip();
  context.drawImage(image, -left, -top);
  context.restore();
  return canvas.toDataURL("image/png");
}

export function pixelRectToNormalized(
  rect: ImageCropRect,
  imageSize: { width: number; height: number }
): NormalizedRect {
  const width = Math.max(1, imageSize.width);
  const height = Math.max(1, imageSize.height);
  return {
    x: rect.x / width,
    y: rect.y / height,
    width: rect.width / width,
    height: rect.height / height
  };
}

async function cropImageDataUrl(
  dataUrl: string,
  rect: ImageCropRect,
  currentImage: HTMLImageElement | null
): Promise<string> {
  const image = currentImage ?? await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is not available.");
  }
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function rotateImageDataUrl(
  dataUrl: string,
  degrees: number,
  currentImage: HTMLImageElement | null
): Promise<string> {
  const image = currentImage ?? await loadImage(dataUrl);
  const normalizedDegrees = normalizeRotationDegrees(degrees);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  const swapsAxes = normalizedDegrees === 90 || normalizedDegrees === 270;
  canvas.width = swapsAxes ? sourceHeight : sourceWidth;
  canvas.height = swapsAxes ? sourceWidth : sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is not available.");
  }

  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((normalizedDegrees * Math.PI) / 180);
  context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2);
  return canvas.toDataURL("image/png");
}

async function ensurePngDataUrl(dataUrl: string, currentImage: HTMLImageElement | null = null): Promise<string> {
  if (isBase64PngDataUrl(dataUrl)) {
    return dataUrl.trim();
  }

  const image = currentImage ?? await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is not available.");
  }
  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image preview could not be loaded."));
    image.src = src;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pointDistance(first: NormalizedPoint, second: NormalizedPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointsBoundingBox(points: NormalizedPoint[]): NormalizedRect {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

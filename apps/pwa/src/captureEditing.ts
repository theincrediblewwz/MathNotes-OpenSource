export type CaptureCrop = "original" | "4:3" | "square";
export type CapturePoint = Readonly<{ x: number; y: number }>;
export type CaptureRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type CaptureMark = Readonly<{ type: "pen" | "arrow" | "redaction"; points: readonly CapturePoint[]; width: number }>;
export type CaptureQuad = readonly [CapturePoint, CapturePoint, CapturePoint, CapturePoint];

export type CaptureEdit = Readonly<{
  rotation: 0 | 90 | 180 | 270;
  crop: CaptureCrop;
  cropRect?: CaptureRect;
  lasso?: readonly CapturePoint[];
  marks?: readonly CaptureMark[];
}>;

export const DEFAULT_CAPTURE_EDIT: CaptureEdit = {
  rotation: 0,
  crop: "original"
};

export function rotateCapture(edit: CaptureEdit, direction: "left" | "right"): CaptureEdit {
  const delta = direction === "right" ? 90 : 270;
  const point = (p: CapturePoint): CapturePoint => direction === "right" ? { x: 1 - p.y, y: p.x } : { x: p.y, y: 1 - p.x };
  return {
    ...edit,
    rotation: ((edit.rotation + delta) % 360) as CaptureEdit["rotation"],
    ...(edit.cropRect ? { cropRect: pointsRect(rectPoints(edit.cropRect).map(point)) } : {}),
    ...(edit.lasso ? { lasso: edit.lasso.map(point) } : {}),
    ...(edit.marks ? { marks: edit.marks.map(mark => ({ ...mark, points: mark.points.map(point) })) } : {})
  };
}

export const FULL_CAPTURE_RECT: CaptureRect = { x: 0, y: 0, width: 1, height: 1 };
export const rectPoints = (r: CaptureRect): CaptureQuad => [
  { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
  { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }
];
export function pointsRect(points: readonly CapturePoint[]): CaptureRect {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
}

export function fittedCaptureRect(width: number, height: number, imageWidth: number, imageHeight: number, inset = 28): CaptureRect {
  const scale = Math.max(0.001, Math.min(Math.max(1, width - inset * 2) / imageWidth, Math.max(1, height - inset * 2) / imageHeight));
  return { x: (width - imageWidth * scale) / 2, y: (height - imageHeight * scale) / 2, width: imageWidth * scale, height: imageHeight * scale };
}

export function capturePointInRect(x: number, y: number, rect: CaptureRect): CapturePoint {
  return { x: Math.max(0, Math.min(1, (x - rect.x) / rect.width)), y: Math.max(0, Math.min(1, (y - rect.y) / rect.height)) };
}

export function captureCropRect(width: number, height: number, edit: CaptureEdit): CaptureRect {
  if (edit.cropRect) return edit.cropRect;
  const rect = centeredCrop(width, height, edit.crop);
  return { x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height };
}

export function moveCaptureCropCorner(rect: CaptureRect, corner: number, point: CapturePoint): CaptureRect {
  const opposite = rectPoints(rect)[(corner + 2) % 4];
  const left = corner === 0 || corner === 3, top = corner < 2;
  const x = left ? Math.min(point.x, opposite.x - .02) : Math.max(point.x, opposite.x + .02);
  const y = top ? Math.min(point.y, opposite.y - .02) : Math.max(point.y, opposite.y + .02);
  return pointsRect([{ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }, opposite]);
}

export function centeredCrop(
  width: number,
  height: number,
  crop: CaptureCrop
): { x: number; y: number; width: number; height: number } {
  if (crop === "original") return { x: 0, y: 0, width, height };
  const targetRatio = crop === "square" ? 1 : 4 / 3;
  const sourceRatio = width / height;
  if (sourceRatio > targetRatio) {
    const croppedWidth = height * targetRatio;
    return { x: (width - croppedWidth) / 2, y: 0, width: croppedWidth, height };
  }
  const croppedHeight = width / targetRatio;
  return { x: 0, y: (height - croppedHeight) / 2, width, height: croppedHeight };
}

export async function applyCaptureEdit(file: File, edit: CaptureEdit): Promise<File> {
  if (edit.rotation === 0 && edit.crop === "original" && !edit.cropRect && !edit.lasso?.length && !edit.marks?.length) return file;
  const image = await acquireCaptureImage(file);
  try {
    const output = renderCaptureSelection(image, edit);
    return new File([await canvasBlob(output, "image/png")], editedFileName(file.name, "image/png"), { type: "image/png", lastModified: Date.now() });
  } finally { releaseCaptureImage(file); }
}

function renderCaptureSelection(image: DecodedImage, edit: CaptureEdit): HTMLCanvasElement {
  const quarter = edit.rotation === 90 || edit.rotation === 270;
  const rotated = { width: quarter ? image.height : image.width, height: quarter ? image.width : image.height };
  const normalized = edit.lasso && edit.lasso.length >= 3 ? pointsRect(edit.lasso) : captureCropRect(rotated.width, rotated.height, edit);
  const crop = { x: normalized.x * rotated.width, y: normalized.y * rotated.height, width: normalized.width * rotated.width, height: normalized.height * rotated.height };
  const output = document.createElement("canvas");
  const outputScale = Math.min(1, 3200 / Math.max(crop.width, crop.height));
  output.width = Math.max(1, Math.round(crop.width * outputScale)); output.height = Math.max(1, Math.round(crop.height * outputScale));
  const outputContext = output.getContext("2d");
  if (!outputContext) throw new Error("当前浏览器无法编辑照片。");
  outputContext.fillStyle = "#ffffff"; outputContext.fillRect(0, 0, output.width, output.height);
  if (edit.lasso && edit.lasso.length >= 3) {
    outputContext.beginPath();
    edit.lasso.forEach((p, i) => {
      const x = (p.x * rotated.width - crop.x) * output.width / crop.width;
      const y = (p.y * rotated.height - crop.y) * output.height / crop.height;
      if (i === 0) outputContext.moveTo(x, y); else outputContext.lineTo(x, y);
    });
    outputContext.closePath(); outputContext.clip();
  }
  // Draw the selected part straight from the original decoded image. Cropping an 8K
  // page must retain small text pixels, without allocating a second full-size canvas.
  outputContext.save();
  outputContext.scale(output.width / crop.width, output.height / crop.height);
  outputContext.translate(-crop.x, -crop.y);
  outputContext.save(); outputContext.translate(rotated.width / 2, rotated.height / 2); outputContext.rotate(edit.rotation * Math.PI / 180);
  outputContext.imageSmoothingQuality = "high";
  outputContext.drawImage(image.source, -image.width / 2, -image.height / 2);
  outputContext.restore();
  drawCaptureMarks(outputContext, edit.marks ?? [], rotated.width, rotated.height);
  outputContext.restore();
  if (edit.marks?.some(mark => mark.type === "redaction")) {
    const mask = document.createElement("canvas"); mask.width = output.width; mask.height = output.height;
    const maskContext = mask.getContext("2d")!;
    if (edit.lasso && edit.lasso.length >= 3) {
      maskContext.beginPath(); edit.lasso.forEach((p,i) => {
        const x=(p.x*rotated.width-crop.x)*output.width/crop.width,y=(p.y*rotated.height-crop.y)*output.height/crop.height;
        if (i===0) maskContext.moveTo(x,y); else maskContext.lineTo(x,y);
      }); maskContext.closePath(); maskContext.clip();
    }
    maskContext.scale(output.width/crop.width,output.height/crop.height); maskContext.translate(-crop.x,-crop.y);
    drawCaptureMarks(maskContext,edit.marks.filter(mark => mark.type === "redaction"),rotated.width,rotated.height);
    enforceOpaqueRedaction(output,mask);
  }
  return output;
}

function enforceOpaqueRedaction(canvas: HTMLCanvasElement, mask: HTMLCanvasElement): void {
  const context=canvas.getContext("2d")!,pixels=context.getImageData(0,0,canvas.width,canvas.height);
  const coverage=mask.getContext("2d")!.getImageData(0,0,canvas.width,canvas.height).data;
  for (let index=0; index<coverage.length; index+=4) {
    if (coverage[index+3]) { pixels.data[index]=0; pixels.data[index+1]=0; pixels.data[index+2]=0; pixels.data[index+3]=255; }
  }
  context.putImageData(pixels,0,0);
}

export function drawCaptureMarks(context: CanvasRenderingContext2D, marks: readonly CaptureMark[], width: number, height: number): void {
  // Privacy masks always cover every other mark. They are opaque pixels, never reversible pixelation.
  for (const mark of [...marks.filter(m => m.type !== "redaction"), ...marks.filter(m => m.type === "redaction")]) {
    if (!mark.points.length) continue;
    context.lineCap = "round"; context.lineJoin = "round";
    context.strokeStyle = context.fillStyle = mark.type === "redaction" ? "#000000" : "#d33f35";
    context.lineWidth = mark.width * Math.min(width, height);
    const first = mark.points[0], last = mark.points[mark.points.length - 1];
    context.beginPath();
    if (mark.points.length === 1) {
      context.arc(first.x * width, first.y * height, context.lineWidth / 2, 0, Math.PI * 2); context.fill(); continue;
    }
    const points = mark.type === "arrow" ? [first, last] : mark.points;
    points.forEach((p, i) => { if (i === 0) context.moveTo(p.x * width, p.y * height); else context.lineTo(p.x * width, p.y * height); });
    if (mark.type === "arrow") {
      const angle = Math.atan2((last.y - first.y) * height, (last.x - first.x) * width), length = Math.max(context.lineWidth * 4, Math.min(width, height) * .025);
      for (const side of [-1, 1]) {
        context.moveTo(last.x * width, last.y * height);
        context.lineTo(last.x * width - length * Math.cos(angle + side * Math.PI / 7), last.y * height - length * Math.sin(angle + side * Math.PI / 7));
      }
    }
    context.stroke();
  }
}

export function renderCaptureSurface(image: DecodedImage, edit: CaptureEdit, maximumEdge = 3200): HTMLCanvasElement {
  const scale = Math.min(1, maximumEdge / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  const quarter = edit.rotation === 90 || edit.rotation === 270;
  canvas.width = Math.max(1, Math.round((quarter ? image.height : image.width) * scale));
  canvas.height = Math.max(1, Math.round((quarter ? image.width : image.height) * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法编辑照片。");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.save(); context.translate(canvas.width / 2, canvas.height / 2); context.rotate(edit.rotation * Math.PI / 180);
  context.drawImage(image.source, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale); context.restore();
  drawCaptureMarks(context, edit.marks ?? [], canvas.width, canvas.height);
  if (edit.marks?.some(mark => mark.type === "redaction")) {
    const mask=document.createElement("canvas");mask.width=canvas.width;mask.height=canvas.height;
    drawCaptureMarks(mask.getContext("2d")!,edit.marks.filter(mark => mark.type === "redaction"),canvas.width,canvas.height);
    enforceOpaqueRedaction(canvas,mask);
  }
  return canvas;
}

export function validCaptureQuad(corners: CaptureQuad): boolean {
  return corners.every((p, index) => {
    const q = corners[(index + 1) % 4], r = corners[(index + 2) % 4];
    return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
      (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x) > .0001;
  });
}

/** Projective map from the corrected output to the selected quadrilateral. */
export function capturePerspectiveProjector(corners: CaptureQuad): (u: number, v: number) => CapturePoint {
  if (!validCaptureQuad(corners)) throw new Error("四角不能交叉，请按纸张四角顺序调整。");
  const [a,b,c,d] = corners;
  const dx1 = b.x-c.x, dx2 = d.x-c.x, dx3 = a.x-b.x+c.x-d.x;
  const dy1 = b.y-c.y, dy2 = d.y-c.y, dy3 = a.y-b.y+c.y-d.y;
  const determinant = dx1*dy2-dx2*dy1;
  const g = (dx3*dy2-dx2*dy3)/determinant, h = (dx1*dy3-dx3*dy1)/determinant;
  return (u,v) => ({ x: ((b.x-a.x+g*b.x)*u+(d.x-a.x+h*d.x)*v+a.x)/(g*u+h*v+1), y: ((b.y-a.y+g*b.y)*u+(d.y-a.y+h*d.y)*v+a.y)/(g*u+h*v+1) });
}

export async function applyCapturePerspective(file: File, edit: CaptureEdit, corners: CaptureQuad): Promise<File> {
  if (!validCaptureQuad(corners)) throw new Error("四角不能交叉，请按纸张四角顺序调整。");
  const bounds = pointsRect(corners);
  const localCorners = corners.map(p => ({ x: (p.x-bounds.x)/bounds.width, y: (p.y-bounds.y)/bounds.height })) as unknown as CaptureQuad;
  const project = capturePerspectiveProjector(localCorners);
  const image=await acquireCaptureImage(file);
  try {
  const source = renderCaptureSelection(image, { ...edit, crop: "original", cropRect: bounds, lasso: undefined });
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) throw new Error("当前浏览器无法编辑照片。");
  const distance = (a: CapturePoint, b: CapturePoint) => Math.hypot((a.x-b.x)*source.width, (a.y-b.y)*source.height);
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(Math.max(distance(localCorners[0],localCorners[1]),distance(localCorners[3],localCorners[2]))));
  output.height = Math.max(1, Math.round(Math.max(distance(localCorners[0],localCorners[3]),distance(localCorners[1],localCorners[2]))));
  const outputScale = Math.min(1, 3200 / Math.max(output.width, output.height));
  output.width = Math.max(1, Math.round(output.width * outputScale)); output.height = Math.max(1, Math.round(output.height * outputScale));
  const context = output.getContext("2d"); if (!context) throw new Error("当前浏览器无法编辑照片。");
  const pixels = sourceContext.getImageData(0,0,source.width,source.height), transformed = context.createImageData(output.width,output.height);
  // Yield between strips, keeping the phone responsive even without WebGL.
  for (let y=0; y<output.height; y++) {
    for (let x=0; x<output.width; x++) {
      const p=project((x+.5)/output.width,(y+.5)/output.height);
      const sx=Math.max(0,Math.min(source.width-1,Math.floor(p.x*source.width)));
      const sy=Math.max(0,Math.min(source.height-1,Math.floor(p.y*source.height)));
      const from=(sy*source.width+sx)*4,to=(y*output.width+x)*4;
      transformed.data[to]=pixels.data[from]; transformed.data[to+1]=pixels.data[from+1]; transformed.data[to+2]=pixels.data[from+2]; transformed.data[to+3]=255;
    }
    if (y % 64 === 63) await new Promise<void>(resolve => setTimeout(resolve,0));
  }
  context.putImageData(transformed,0,0);
  return new File([await canvasBlob(output,"image/png")],editedFileName(file.name,"image/png"),{type:"image/png",lastModified:Date.now()});
  } finally { releaseCaptureImage(file); }
}

export async function createCaptureThumbnail(file: Blob): Promise<Blob | undefined> {
  try {
    const image = await decodeImage(file);
    try {
      const maximumEdge = 360;
      const scale = Math.min(1, maximumEdge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      return await canvasBlob(canvas, "image/jpeg", 0.82);
    } finally {
      image.close();
    }
  } catch {
    return undefined;
  }
}

export type DecodedImage = Readonly<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}>;

const decodedCaptures = new WeakMap<Blob, { image: Promise<DecodedImage>; users: number }>();
export function acquireCaptureImage(file: Blob): Promise<DecodedImage> {
  let cached = decodedCaptures.get(file);
  if (!cached) {
    cached = { image: decodeImage(file).catch(error => { decodedCaptures.delete(file); throw error; }), users: 0 };
    decodedCaptures.set(file, cached);
  }
  cached.users += 1;
  return cached.image;
}
export function releaseCaptureImage(file: Blob): void {
  const cached = decodedCaptures.get(file);
  if (!cached || --cached.users > 0) return;
  decodedCaptures.delete(file);
  void cached.image.then(decoded => decoded.close(), () => undefined);
}

async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close()
    };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("照片无法读取。"));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url)
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("照片编辑结果无法保存。")),
      type,
      quality
    );
  });
}

function editedFileName(name: string, mimeType: string): string {
  const extension = mimeType === "image/png" ? ".png" : ".jpg";
  const stem = name.replace(/\.[^.]+$/, "") || "capture";
  return `${stem}-edited${extension}`;
}

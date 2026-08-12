export type CaptureCrop = "original" | "4:3" | "square";

export type CaptureEdit = Readonly<{
  rotation: 0 | 90 | 180 | 270;
  crop: CaptureCrop;
}>;

export const DEFAULT_CAPTURE_EDIT: CaptureEdit = {
  rotation: 0,
  crop: "original"
};

export function rotateCapture(edit: CaptureEdit, direction: "left" | "right"): CaptureEdit {
  const delta = direction === "right" ? 90 : 270;
  return { ...edit, rotation: ((edit.rotation + delta) % 360) as CaptureEdit["rotation"] };
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
  if (edit.rotation === 0 && edit.crop === "original") return file;
  const image = await decodeImage(file);
  try {
    const rotatedWidth = edit.rotation === 90 || edit.rotation === 270 ? image.height : image.width;
    const rotatedHeight = edit.rotation === 90 || edit.rotation === 270 ? image.width : image.height;
    const rotated = document.createElement("canvas");
    rotated.width = rotatedWidth;
    rotated.height = rotatedHeight;
    const context = rotated.getContext("2d");
    if (!context) throw new Error("当前浏览器无法编辑照片。");
    context.translate(rotatedWidth / 2, rotatedHeight / 2);
    context.rotate(edit.rotation * Math.PI / 180);
    context.drawImage(image.source, -image.width / 2, -image.height / 2);

    const crop = centeredCrop(rotatedWidth, rotatedHeight, edit.crop);
    const maximumEdge = 3_200;
    const scale = Math.min(1, maximumEdge / Math.max(crop.width, crop.height));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(crop.width * scale));
    output.height = Math.max(1, Math.round(crop.height * scale));
    const outputContext = output.getContext("2d");
    if (!outputContext) throw new Error("当前浏览器无法编辑照片。");
    outputContext.drawImage(
      rotated,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      output.width,
      output.height
    );
    const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await canvasBlob(output, mimeType, mimeType === "image/jpeg" ? 0.94 : undefined);
    return new File([blob], editedFileName(file.name, mimeType), {
      type: mimeType,
      lastModified: Date.now()
    });
  } finally {
    image.close();
  }
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

type DecodedImage = Readonly<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}>;

async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
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

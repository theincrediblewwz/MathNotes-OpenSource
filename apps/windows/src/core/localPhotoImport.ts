import { extname } from "node:path";

export type LocalPhotoMimeType = "image/jpeg" | "image/png" | "image/webp";

export function detectLocalPhotoMimeType(fileName: string): LocalPhotoMimeType {
  const extension = extname(fileName).toLowerCase();

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }

  throw new Error(`Unsupported local photo type: ${fileName}`);
}

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export async function imagePathToDataUrl(imagePath: string): Promise<string> {
  const bytes = await readFile(imagePath);
  return `data:${mimeTypeForPath(imagePath)};base64,${bytes.toString("base64")}`;
}

function mimeTypeForPath(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

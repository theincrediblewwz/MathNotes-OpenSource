import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const options = parseOptions(process.argv.slice(2));
const inputPath = resolvePath(options.input, "--input");
const outputPath = resolvePath(options.output, "--output");
const maxEdge = Number(options.maxEdge ?? 2048);
const quality = Number(options.quality ?? 92);

if (!Number.isFinite(maxEdge) || maxEdge < 256) throw new Error("--max-edge must be at least 256");
if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new Error("--quality must be between 1 and 100");

const image = await loadImage(inputPath);
const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
const width = Math.max(1, Math.round(image.width * scale));
const height = Math.max(1, Math.round(image.height * scale));
const canvas = createCanvas(width, height);
const context = canvas.getContext("2d");
context.imageSmoothingEnabled = true;
context.imageSmoothingQuality = "high";
context.drawImage(image, 0, 0, width, height);

const encoded = await canvas.encode("jpeg", quality);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, encoded);
const inputStat = await stat(inputPath);

console.log(
  JSON.stringify(
    {
      input: { path: inputPath, bytes: inputStat.size, width: image.width, height: image.height },
      output: { path: outputPath, bytes: encoded.length, width, height, quality },
      byteRatio: Math.round((encoded.length / inputStat.size) * 10000) / 10000
    },
    null,
    2
  )
);

function resolvePath(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`Missing ${flag} <path>`);
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function parseOptions(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--input") parsed.input = value;
    else if (arg === "--output") parsed.output = value;
    else if (arg === "--max-edge") parsed.maxEdge = value;
    else if (arg === "--quality") parsed.quality = value;
    else throw new Error(`Unknown option: ${arg}`);
    index += 1;
  }
  return parsed;
}

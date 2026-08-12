import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type QualityGoldStatus = "candidate" | "approved";

export type ResolvedQualityBenchmarkSample = {
  id: string;
  category: string;
  imagePath: string;
  goldMarkdownPath: string;
  imageFileName: string;
  goldFileName: string;
  imageSha256: string;
  goldSha256: string;
  goldStatus: QualityGoldStatus;
};

export type ResolvedQualityBenchmarkManifest = {
  version: 1;
  manifestPath: string;
  label: string;
  repeats: 1 | 3;
  variant: string;
  samples: ResolvedQualityBenchmarkSample[];
};

type QualityBenchmarkManifestInput = {
  version?: unknown;
  label?: unknown;
  repeats?: unknown;
  variant?: unknown;
  samples?: unknown;
};

type QualityBenchmarkSampleInput = {
  id?: unknown;
  category?: unknown;
  imagePath?: unknown;
  goldMarkdownPath?: unknown;
  goldStatus?: unknown;
};

export async function readQualityBenchmarkManifest(
  manifestPath: string,
  options: { allowSmokeRepeats?: boolean } = {}
): Promise<ResolvedQualityBenchmarkManifest> {
  const resolvedManifestPath = resolve(manifestPath);
  const input = JSON.parse(await readFile(resolvedManifestPath, "utf8")) as QualityBenchmarkManifestInput;

  if (input.version !== 1) {
    throw new Error("Quality benchmark manifest version must be 1");
  }

  const label = requireNonEmptyString(input.label, "label");
  const variant = requireNonEmptyString(input.variant, "variant");
  const repeats = parseRepeats(input.repeats, options.allowSmokeRepeats === true);
  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    throw new Error("Quality benchmark manifest samples must be a non-empty array");
  }

  const ids = new Set<string>();
  const rootDir = dirname(resolvedManifestPath);
  const samples: ResolvedQualityBenchmarkSample[] = [];

  for (const rawSample of input.samples) {
    if (!rawSample || typeof rawSample !== "object") {
      throw new Error("Quality benchmark sample must be an object");
    }
    const sample = rawSample as QualityBenchmarkSampleInput;
    const id = requireNonEmptyString(sample.id, "sample id");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(id)) {
      throw new Error("Quality benchmark sample id must match a safe Windows path segment");
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) {
      throw new Error(`Quality benchmark sample id uses a reserved Windows device name: ${id}`);
    }
    const canonicalId = id.toLowerCase();
    if (ids.has(canonicalId)) {
      throw new Error(`Quality benchmark duplicate sample id: ${id}`);
    }
    ids.add(canonicalId);

    const category = requireNonEmptyString(sample.category, `sample ${id} category`);
    const imagePath = resolve(rootDir, requireNonEmptyString(sample.imagePath, `sample ${id} imagePath`));
    const goldMarkdownPath = resolve(
      rootDir,
      requireNonEmptyString(sample.goldMarkdownPath, `sample ${id} goldMarkdownPath`)
    );
    await requireRegularFile(imagePath, `sample ${id} image file does not exist`);
    await requireRegularFile(goldMarkdownPath, `sample ${id} Gold Markdown file does not exist`);

    samples.push({
      id,
      category,
      imagePath,
      goldMarkdownPath,
      imageFileName: basename(imagePath),
      goldFileName: basename(goldMarkdownPath),
      imageSha256: await sha256File(imagePath),
      goldSha256: await sha256File(goldMarkdownPath),
      goldStatus: parseGoldStatus(sample.goldStatus)
    });
  }

  return {
    version: 1,
    manifestPath: resolvedManifestPath,
    label,
    repeats,
    variant,
    samples
  };
}

function parseRepeats(value: unknown, allowSmokeRepeats: boolean): 1 | 3 {
  if (value === 3) return 3;
  if (allowSmokeRepeats && value === 1) return 1;
  throw new Error("Quality benchmark repeats must be 3 for formal runs");
}

function parseGoldStatus(value: unknown): QualityGoldStatus {
  if (value === undefined || value === "candidate") return "candidate";
  if (value === "approved") return "approved";
  throw new Error("Quality benchmark goldStatus must be candidate or approved");
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Quality benchmark ${field} must be a non-empty string`);
  }
  return value.trim();
}

async function requireRegularFile(path: string, message: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) return;
  } catch {
    // The stable product-facing error is emitted below.
  }
  throw new Error(message);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

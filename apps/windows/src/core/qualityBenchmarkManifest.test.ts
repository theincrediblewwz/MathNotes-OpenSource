import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readQualityBenchmarkManifest } from "./qualityBenchmarkManifest";

describe("readQualityBenchmarkManifest", () => {
  let rootDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-quality-manifest-"));
    await mkdir(join(rootDir, "photos"));
    await mkdir(join(rootDir, "gold"));
    await writeFile(join(rootDir, "photos", "board.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(join(rootDir, "gold", "board.md"), "$$x^2$$\n", "utf8");
    manifestPath = join(rootDir, "benchmark.json");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("resolves private paths and fingerprints files without embedding their bodies", async () => {
    await writeManifest(validManifest());

    const manifest = await readQualityBenchmarkManifest(manifestPath);

    expect(manifest).toMatchObject({
      version: 1,
      label: "functional-analysis",
      repeats: 3,
      variant: "current-provider-settings",
      samples: [{
        id: "board-001",
        imageFileName: "board.png",
        goldFileName: "board.md",
        imageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        goldSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        goldStatus: "candidate"
      }]
    });
    expect(JSON.stringify(manifest)).not.toContain("$$x^2$$");
  });

  it("rejects duplicate sample ids", async () => {
    const manifest = validManifest();
    manifest.samples.push({ ...manifest.samples[0] });
    await writeManifest(manifest);

    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("duplicate sample id");
  });

  it("rejects sample ids that collide on Windows case-insensitive paths", async () => {
    const manifest = validManifest();
    manifest.samples.push({ ...manifest.samples[0], id: "BOARD-001" });
    await writeManifest(manifest);

    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("duplicate sample id");
  });

  it("rejects sample ids that are unsafe as output path segments", async () => {
    const manifest = validManifest();
    manifest.samples[0].id = "../board";
    await writeManifest(manifest);

    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("sample id must match");

    manifest.samples[0].id = "CON";
    await writeManifest(manifest);
    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("reserved Windows device name");

    manifest.samples[0].id = "board.";
    await writeManifest(manifest);
    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("sample id must match");
  });

  it("rejects unsupported versions and formal repeat counts", async () => {
    await writeManifest({ ...validManifest(), version: 2 });
    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("version must be 1");

    await writeManifest({ ...validManifest(), repeats: 2 });
    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("repeats must be 3");
  });

  it("allows one repeat only for an explicit smoke manifest", async () => {
    await writeManifest({ ...validManifest(), repeats: 1 });

    await expect(readQualityBenchmarkManifest(manifestPath, { allowSmokeRepeats: true })).resolves.toMatchObject({
      repeats: 1
    });
  });

  it("rejects missing image and Gold files before any provider work", async () => {
    const missingImage = validManifest();
    missingImage.samples[0].imagePath = "photos/missing.png";
    await writeManifest(missingImage);
    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("image file does not exist");

    const missingGold = validManifest();
    missingGold.samples[0].goldMarkdownPath = "gold/missing.md";
    await writeManifest(missingGold);
    await expect(readQualityBenchmarkManifest(manifestPath)).rejects.toThrow("Gold Markdown file does not exist");
  });

  async function writeManifest(value: unknown) {
    await writeFile(manifestPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
});

function validManifest() {
  return {
    version: 1,
    label: "functional-analysis",
    repeats: 3,
    variant: "current-provider-settings",
    samples: [{
      id: "board-001",
      category: "dense-derivation",
      imagePath: "photos/board.png",
      goldMarkdownPath: "gold/board.md"
    }]
  };
}

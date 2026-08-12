import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "mathnotes-editor-lab-"));
const bundledModel = path.join(tempDir, "sessionSourceEditorModel.mjs");
const outputPath = path.resolve("output/performance/editor-baseline.json");

const shapes = [
  { name: "many-small-blocks", blocks: 420, paragraphs: 6, lookups: 240 },
  { name: "few-long-blocks", blocks: 24, paragraphs: 120, lookups: 240 },
  { name: "thousand-block-session", blocks: 1200, paragraphs: 8, lookups: 480 }
];

try {
  await build({
    bundle: true,
    entryPoints: ["apps/windows/src/ui/components/sessionSourceEditorModel.ts"],
    format: "esm",
    outfile: bundledModel,
    platform: "node",
    sourcemap: false,
    write: true
  });
  const model = await import(pathToFileURL(bundledModel).href);
  const results = shapes.map((shape) => runShape(model, shape));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    },
    methodology: {
      iterations: 5,
      measuredOperations: ["markdown projection", "range index construction", "binary indexed lookup", "legacy recomputed lookup"],
      note: "This is a deterministic model-layer baseline. Browser frame, CodeMirror mount and KaTeX costs require the next UI-trace experiment."
    },
    results
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`editor performance lab baseline written to ${outputPath}`);
} finally {
  await rm(tempDir, { force: true, recursive: true });
}

function runShape(model, shape) {
  const sample = buildSourceDocument(shape.blocks, shape.paragraphs);
  const projectionMs = medianTimed(5, () => model.buildMarkdownProjection(sample.text, sample.blocks));
  const rangeMs = medianTimed(5, () => model.computeSourceEditorBlockRanges(sample.text, sample.blocks));
  const ranges = model.computeSourceEditorBlockRanges(sample.text, sample.blocks);
  const indexedLookupMs = medianTimed(5, () => {
    let hits = 0;
    for (let index = 0; index < shape.lookups; index += 1) {
      if (model.findActiveMarkdownBlockInRanges(sample.probes[index % sample.probes.length], ranges)) hits += 1;
    }
    assert.equal(hits, shape.lookups);
  });
  const legacyLookupMs = medianTimed(3, () => {
    let hits = 0;
    const limitedLookups = Math.min(24, shape.lookups);
    for (let index = 0; index < limitedLookups; index += 1) {
      if (model.findActiveMarkdownBlockAtPosition(sample.probes[index % sample.probes.length], sample.text, sample.blocks)) hits += 1;
    }
    assert.equal(hits, limitedLookups);
  });

  return {
    ...shape,
    characters: sample.text.length,
    projectionMs,
    rangeMs,
    indexedLookupMs,
    indexedLookups: shape.lookups,
    legacyLookupMs,
    legacyLookups: Math.min(24, shape.lookups)
  };
}

function medianTimed(iterations, operation) {
  operation();
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    operation();
    values.push(performance.now() - start);
  }
  values.sort((left, right) => left - right);
  return Number(values[Math.floor(values.length / 2)].toFixed(3));
}

function buildSourceDocument(blockCount, paragraphsPerBlock) {
  const chunks = [];
  const blocks = [];
  const probes = [];
  let position = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const id = String(index + 1).padStart(4, "0");
    const header = `photo_${id}.jpg`;
    const pathName = `blocks/${id}_ai_transcript.md`;
    const lines = [`--- source: ${header} | block: ${id} | path: ${pathName} | kind: ai_transcription ---`, `## 第 ${index + 1} 个识别块`];
    for (let paragraph = 0; paragraph < paragraphsPerBlock; paragraph += 1) {
      lines.push(`设 T_${paragraph}: X -> X 为有界线性算子，并且 ||T_${paragraph}x|| <= C_${paragraph} ||x||。`);
      lines.push(`$$ ||T_${paragraph}|| = sup_{||x|| = 1} ||T_${paragraph}x|| $$`);
    }
    lines.push("");
    const blockText = lines.join("\n");
    const bodyOffset = blockText.indexOf("\n") + 1;
    probes.push(position + bodyOffset + 2);
    chunks.push(blockText);
    position += blockText.length + 1;
    blocks.push({ blockId: id, sourceId: `src-${id}`, path: pathName, source: "ai_transcription", header });
  }
  return { blocks, probes, text: chunks.join("\n") };
}

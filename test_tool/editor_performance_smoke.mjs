import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const blockCount = Number(process.env.MATHNOTES_PERF_BLOCKS ?? 420);
const paragraphsPerBlock = Number(process.env.MATHNOTES_PERF_PARAGRAPHS ?? 6);
const activeLookups = Number(process.env.MATHNOTES_PERF_ACTIVE_LOOKUPS ?? 24);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "mathnotes-editor-perf-"));
const bundledModel = path.join(tempDir, "sessionSourceEditorModel.mjs");

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

  const { computeSourceEditorBlockRanges, findActiveMarkdownBlockAtPosition } = await import(pathToFileURL(bundledModel).href);
  const { text, blocks, probePositions } = buildLargeSourceDocument(blockCount, paragraphsPerBlock);

  const rangeStart = performance.now();
  const ranges = computeSourceEditorBlockRanges(text, blocks);
  const rangeMs = performance.now() - rangeStart;

  const lookupStart = performance.now();
  let hits = 0;
  for (let i = 0; i < activeLookups; i += 1) {
    const block = findActiveMarkdownBlockAtPosition(probePositions[i % probePositions.length], text, blocks);
    if (block) {
      hits += 1;
    }
  }
  const lookupMs = performance.now() - lookupStart;

  assert.equal(ranges.length, blockCount);
  assert.equal(hits, activeLookups);
  assert.ok(rangeMs < 2500, `range computation took ${rangeMs.toFixed(1)}ms`);
  assert.ok(lookupMs < 6000, `active block lookup took ${lookupMs.toFixed(1)}ms`);

  console.log(
    JSON.stringify(
      {
        blocks: blockCount,
        paragraphsPerBlock,
        characters: text.length,
        rangeMs: Number(rangeMs.toFixed(2)),
        activeLookups,
        lookupMs: Number(lookupMs.toFixed(2))
      },
      null,
      2
    )
  );
  console.log("editor performance smoke passed");
} finally {
  await rm(tempDir, { force: true, recursive: true });
}

function buildLargeSourceDocument(blocks, paragraphs) {
  const textParts = [];
  const blockRefs = [];
  const probePositions = [];

  for (let index = 0; index < blocks; index += 1) {
    const id = String(index + 1).padStart(4, "0");
    const photo = `photo_${id}.jpg`;
    const pathName = `blocks/${id}_ai_transcript.md`;
    textParts.push(`--- source: ${photo} | block: ${id} | path: ${pathName} | kind: ai_transcription ---`);

    const bodyStart = textParts.join("\n").length + 1;
    textParts.push(`## 第 ${index + 1} 个识别块`);
    for (let paragraph = 0; paragraph < paragraphs; paragraph += 1) {
      textParts.push(`设 T_${paragraph}: X -> X 为有界线性算子，并且 ||T_${paragraph}x|| <= C_${paragraph} ||x||。`);
      textParts.push(`$$ ||T_${paragraph}|| = sup_{||x|| = 1} ||T_${paragraph}x|| $$`);
    }
    textParts.push("");

    blockRefs.push({
      blockId: id,
      sourceId: `src-${id}`,
      path: pathName,
      source: "ai_transcription",
      header: photo
    });
    if (index % Math.max(1, Math.floor(blocks / 24)) === 0) {
      probePositions.push(bodyStart);
    }
  }

  return {
    blocks: blockRefs,
    probePositions,
    text: textParts.join("\n")
  };
}

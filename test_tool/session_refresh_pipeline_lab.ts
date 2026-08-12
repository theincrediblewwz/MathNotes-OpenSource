import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { SessionRecord } from "@mathnotes/shared";
import { createSessionDocument } from "../apps/windows/src/common/sessionDocument";
import { parseSessionSourceText } from "../apps/windows/src/common/sessionSourceDocument";
import { BlockStore } from "../apps/windows/src/core/blockStore";

type ReadMode = "parallel-8" | "parallel-16" | "parallel-32" | "parallel-64" | "parallel-all" | "sequential";

type Sample = {
  metadataReadMs: number;
  markdownReadMs: number;
  documentBuildMs: number;
  fullPayloadBytes: number;
  compactPayloadBytes: number;
  fullCloneMs: number;
  compactCloneMs: number;
  rendererProjectionMs: number;
  totalMs: number;
};

const shapes = option("shapes", "120,420")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const repeats = Math.max(4, Number.parseInt(option("repeats", "24"), 10) || 24);
const outputPath = option("output", "output/performance/session-refresh-pipeline-baseline.json");

const results = [];
for (const blockCount of shapes) {
  results.push(await measureShape(blockCount));
}

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    node: process.version
  },
  method: {
    shapes,
    repeats,
    warmups: 4,
    note: "Real BlockStore/session parser functions. Variant order rotates per repeat to balance filesystem cache. Renderer projection recreates the product block map from the returned source document. Payload metrics compare the complete SessionDocument with the renderer refresh contract: sourceDocument plus PDF-only render blocks."
  },
  results
};

await mkdir(join(process.cwd(), "output", "performance"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`SESSION_REFRESH_PIPELINE_LAB_OK ${outputPath}\n`);

async function measureShape(blockCount: number) {
  const rootDir = await mkdtemp(join(tmpdir(), `mathnotes-refresh-${blockCount}-`));
  try {
    const fixture = await writeFixture(rootDir, blockCount);
    const store = new BlockStore(rootDir);
    const modes: ReadMode[] = ["sequential", "parallel-8", "parallel-16", "parallel-32", "parallel-64", "parallel-all"];
    for (const mode of modes) {
      await measureLoad({ mode, store });
    }

    const samples = Object.fromEntries(modes.map((mode) => [mode, []])) as Record<ReadMode, Sample[]>;
    for (let index = 0; index < repeats; index += 1) {
      const offset = index % modes.length;
      const order = [...modes.slice(offset), ...modes.slice(0, offset)];
      for (const mode of order) {
        samples[mode].push(await measureLoad({ mode, store }));
      }
    }

    return {
      blockCount,
      markdownBytes: fixture.markdownBytes,
      variants: Object.fromEntries(modes.map((mode) => [mode, summarizeSamples(samples[mode])]))
    };
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

async function measureLoad(args: { mode: ReadMode; store: BlockStore }): Promise<Sample> {
  const totalStartedAt = performance.now();
  const metadataStartedAt = performance.now();
  const session = await args.store.readSession("functional_analysis", "lecture");
  const metadataReadMs = performance.now() - metadataStartedAt;
  const sessionDir = args.store.getSessionDir("functional_analysis", "lecture");

  const markdownReadStartedAt = performance.now();
  const markdownBlocks = session.blocks.filter((block) => block.type === "markdown");
  const markdownByPath: Record<string, string> = {};
  if (args.mode !== "sequential") {
    const concurrency = args.mode === "parallel-all"
      ? markdownBlocks.length
      : Number.parseInt(args.mode.slice("parallel-".length), 10);
    const entries = await mapConcurrent(markdownBlocks, concurrency, async (block) => [
      block.path,
      await readFile(join(sessionDir, block.path), "utf8")
    ] as const);
    for (const [path, markdown] of entries) markdownByPath[path] = markdown;
  } else {
    for (const block of markdownBlocks) {
      markdownByPath[block.path] = await readFile(join(sessionDir, block.path), "utf8");
    }
  }
  const markdownReadMs = performance.now() - markdownReadStartedAt;

  const documentBuildStartedAt = performance.now();
  const document = createSessionDocument({
    notebookId: "functional_analysis",
    session,
    markdownByPath,
    sessionDir
  });
  const documentBuildMs = performance.now() - documentBuildStartedAt;

  const compactDocument = {
    ...document,
    sourceLines: [],
    renderBlocks: document.renderBlocks.filter((block) => Boolean(block.pdf)),
    editableBlocks: []
  };
  const fullPayloadBytes = Buffer.byteLength(JSON.stringify(document));
  const compactPayloadBytes = Buffer.byteLength(JSON.stringify(compactDocument));
  const fullCloneStartedAt = performance.now();
  structuredClone(document);
  const fullCloneMs = performance.now() - fullCloneStartedAt;
  const compactCloneStartedAt = performance.now();
  structuredClone(compactDocument);
  const compactCloneMs = performance.now() - compactCloneStartedAt;

  const rendererProjectionStartedAt = performance.now();
  const parsed = new Map(parseSessionSourceText(document.sourceDocument.text).map((update) => [update.blockId, update.markdown]));
  Object.fromEntries(document.sourceDocument.markdownBlocks.map((block) => [block.blockId, parsed.get(block.blockId) ?? ""]));
  const rendererProjectionMs = performance.now() - rendererProjectionStartedAt;

  return {
    metadataReadMs,
    markdownReadMs,
    documentBuildMs,
    fullPayloadBytes,
    compactPayloadBytes,
    fullCloneMs,
    compactCloneMs,
    rendererProjectionMs,
    totalMs: performance.now() - totalStartedAt
  };
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, values.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}

async function writeFixture(rootDir: string, blockCount: number) {
  const sessionDir = join(rootDir, "notebooks", "functional_analysis", "sessions", "lecture");
  const blocksDir = join(sessionDir, "blocks");
  await mkdir(blocksDir, { recursive: true });
  const now = new Date().toISOString();
  const blocks: SessionRecord["blocks"] = [];
  let markdownBytes = 0;
  for (let index = 1; index <= blockCount; index += 1) {
    const id = String(index).padStart(4, "0");
    const path = `blocks/${id}_user_note.md`;
    const markdown = buildMarkdown(index);
    markdownBytes += Buffer.byteLength(markdown);
    await writeFile(join(sessionDir, path), markdown, "utf8");
    blocks.push({
      id,
      type: "markdown",
      path,
      source: "user",
      status: "draft",
      readonly: false,
      editableByAi: false,
      createdAt: now,
      updatedAt: now
    });
  }
  const session: SessionRecord = {
    id: "lecture",
    title: `Session refresh ${blockCount}`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    blocks,
    locks: [],
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return { markdownBytes };
}

function buildMarkdown(index: number): string {
  return [
    `### 定理 ${index}：有界算子与紧性`,
    "",
    `这是第 ${index} 个用于 Session 刷新分段实验的 Markdown 块。`,
    "",
    "设 $T_n:X\\to Y$ 为一列有界线性算子，并且对任意 $x\\in X$ 有 $T_nx\\to Tx$。",
    "",
    "$$",
    "\\|T\\| \\le \\sup_{n\\ge 1}\\|T_n\\|,\\qquad \\langle Tx,y\\rangle=\\lim_{n\\to\\infty}\\langle T_nx,y\\rangle.",
    "$$",
    "",
    "1. 保留原始推导顺序；",
    "2. 检查一致有界性；",
    "3. 对不清楚的符号保留 [不确定：...] 标记。"
  ].join("\n");
}

function summarizeSamples(samples: Sample[]) {
  return Object.fromEntries((Object.keys(samples[0]) as Array<keyof Sample>).map((key) => [
    key,
    summarize(samples.map((sample) => sample[key]), key.endsWith("Bytes") ? "Bytes" : "Ms")
  ]));
}

function summarize(values: number[], unit: "Bytes" | "Ms" = "Ms") {
  const sorted = values.slice().sort((left, right) => left - right);
  const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
  return {
    [`p50${unit}`]: round(percentile(0.5)),
    [`p95${unit}`]: round(percentile(0.95)),
    [`max${unit}`]: round(sorted.at(-1) ?? 0)
  };
}

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

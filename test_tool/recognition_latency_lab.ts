import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { BlockStore } from "../apps/windows/src/core/blockStore";
import { PhotoIngestPipeline } from "../apps/windows/src/core/photoIngestPipeline";
import {
  createProviderHttpTimingFetch,
  type ProviderHttpTiming
} from "../apps/windows/src/core/providerHttpTimingProbe";
import { readProviderConfig } from "../apps/windows/src/core/providerConfigStore";
import { createRecognitionProviderFromConfig } from "../apps/windows/src/core/recognitionProviderFactory";
import type { RecognitionJob, RecognitionRuntimeEvent } from "../apps/windows/src/core/recognitionQueue";

type Timeline = {
  labStarted: number;
  acceptStarted?: number;
  durableReceipt?: number;
  queueRunning?: number;
  providerStarted?: number;
  firstOutput?: number;
  firstDraftRefreshReady?: number;
  completed?: number;
};

const options = parseOptions(process.argv.slice(2));
const imagePath = resolvePath(options.image ?? "");
const notesRoot = resolvePath(options.root ?? defaultNotesRoot());
const reportPath = resolvePath(
  options.output ?? join("output", "performance", `real-recognition-latency-${Date.now()}.json`)
);
const bytes = await readFile(imagePath);
const providerConfig = await readProviderConfig({ rootDir: notesRoot });
const httpTiming: ProviderHttpTiming = {};
const provider = await createRecognitionProviderFromConfig({
  rootDir: notesRoot,
  allowMockProvider: false,
  fetchImpl: createProviderHttpTimingFetch({ timing: httpTiming })
});
const tempRoot = join(tmpdir(), `mathnotes-recognition-latency-${process.pid}-${Date.now()}`);
const notebookId = "latency_lab";
const sessionId = "single_turn";
const store = new BlockStore(tempRoot);
const timeline: Timeline = { labStarted: performance.now() };
const jobSnapshots: RecognitionJob[] = [];
const eventCounters = { stdout: 0, stderr: 0, info: 0, warning: 0, error: 0, previewChanged: 0 };

try {
  await store.createSession({ notebookId, sessionId, title: "Recognition latency lab", now: new Date().toISOString() });
  const pipeline = new PhotoIngestPipeline({
    store,
    provider,
    onIngested: () => {
      timeline.durableReceipt ??= performance.now();
    },
    onRecognitionJobChanged: (job) => {
      jobSnapshots.push(job);
      if (job.status === "running") timeline.queueRunning ??= performance.now();
      if (job.timing?.providerStartedAt) timeline.providerStarted ??= performance.now();
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        timeline.completed ??= performance.now();
      }
    },
    onRecognitionRuntimeEvent: (event) => recordRuntimeEvent(event, timeline, eventCounters)
  });

  timeline.acceptStarted = performance.now();
  const accepted = await pipeline.acceptPhoto({
    notebookId,
    sessionId,
    originalName: basename(imagePath),
    mimeType: mimeTypeFor(imagePath),
    bytes,
    receivedAt: new Date().toISOString()
  });
  const result = await pipeline.processAcceptedRecognition(accepted);
  const finalJob = [...jobSnapshots].reverse().find((job) => job.id === result.recognitionJobId);
  const transcript = result.transcriptBlockId
    ? await store.readMarkdownBlock(notebookId, sessionId, result.transcriptBlockId)
    : null;

  if (options.transcriptOutput && transcript !== null) {
    const transcriptPath = resolvePath(options.transcriptOutput);
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcript, "utf8");
  }

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    fixture: { fileName: basename(imagePath), bytes: bytes.length },
    provider: {
      id: providerConfig.providerId,
      model: providerConfig.model,
      baseUrl: providerConfig.baseUrl,
      credentialSource: providerConfig.apiKey ? "stored" : "environment"
    },
    result: {
      status: result.recognitionStatus,
      warningCount: result.warnings?.length ?? 0,
      eventCounters,
      transcript: transcript === null ? null : {
        characters: transcript.length,
        sha256: createHash("sha256").update(transcript).digest("hex"),
        outputPath: options.transcriptOutput ? resolvePath(options.transcriptOutput) : null
      }
    },
    timingsMs: summarizeTimeline(timeline),
    httpTimingsMs: summarizeHttpTimeline(timeline, httpTiming),
    queueTimingMs: finalJob?.timing
      ? {
          queue: finalJob.timing.queueMs,
          providerToFirstOutput: finalJob.timing.firstOutputMs,
          providerTotal: finalJob.timing.providerMs,
          acceptedToComplete: finalJob.timing.totalMs
        }
      : null
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
  if (result.recognitionStatus !== "succeeded") process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function summarizeHttpTimeline(timeline: Timeline, timing: ProviderHttpTiming) {
  return {
    providerStartToFetchCall: delta(timeline.providerStarted, timing.fetchCalledAt),
    fetchCallToResponseHeaders: delta(timing.fetchCalledAt, timing.responseHeadersAt),
    responseHeadersToFirstBodyChunk: delta(timing.responseHeadersAt, timing.firstBodyChunkAt),
    firstBodyChunkToFirstOutput: delta(timing.firstBodyChunkAt, timeline.firstOutput),
    fetchCallToFirstBodyChunk: delta(timing.fetchCalledAt, timing.firstBodyChunkAt),
    requestBodyBytes: timing.requestBodyBytes ?? null,
    responseStatus: timing.responseStatus ?? null,
    responseContentType: timing.responseContentType ?? null
  };
}

function recordRuntimeEvent(
  event: RecognitionRuntimeEvent,
  timeline: Timeline,
  counters: Record<"stdout" | "stderr" | "info" | "warning" | "error" | "previewChanged", number>
): void {
  counters[event.level] += 1;
  if (event.previewChanged) {
    counters.previewChanged += 1;
    if (timeline.firstOutput !== undefined) timeline.firstDraftRefreshReady ??= performance.now();
  }
  if (event.level === "stdout" && event.message.length > 0) {
    timeline.firstOutput ??= performance.now();
  }
  if (!timeline.providerStarted && event.message.includes("API 请求已创建")) {
    timeline.providerStarted = performance.now();
  }
}

function summarizeTimeline(timeline: Timeline) {
  return {
    setup: delta(timeline.labStarted, timeline.acceptStarted),
    acceptToDurableReceipt: delta(timeline.acceptStarted, timeline.durableReceipt),
    durableReceiptToQueueRunning: delta(timeline.durableReceipt, timeline.queueRunning),
    queueRunningToProviderStart: delta(timeline.queueRunning, timeline.providerStarted),
    providerStartToFirstOutput: delta(timeline.providerStarted, timeline.firstOutput),
    firstOutputToFirstDraftRefreshReady: delta(timeline.firstOutput, timeline.firstDraftRefreshReady),
    providerStartToComplete: delta(timeline.providerStarted, timeline.completed),
    acceptStartToComplete: delta(timeline.acceptStarted, timeline.completed)
  };
}

function delta(start?: number, end?: number): number | null {
  return start === undefined || end === undefined ? null : Math.round((end - start) * 100) / 100;
}

function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function resolvePath(path: string): string {
  if (!path) throw new Error("Missing --image <path>");
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function defaultNotesRoot(): string {
  if (process.env.MATHNOTES_ROOT) return process.env.MATHNOTES_ROOT;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Electron", "MyMathNotes");
  }
  return join(homedir(), ".mathnotes");
}

function parseOptions(args: string[]): { image?: string; root?: string; output?: string; transcriptOutput?: string } {
  const parsed: { image?: string; root?: string; output?: string; transcriptOutput?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--image") parsed.image = args[++index];
    else if (arg === "--root") parsed.root = args[++index];
    else if (arg === "--output") parsed.output = args[++index];
    else if (arg === "--transcript-output") parsed.transcriptOutput = args[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

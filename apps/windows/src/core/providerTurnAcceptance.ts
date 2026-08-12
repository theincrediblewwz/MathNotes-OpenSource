import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RecognitionProvider } from "@mathnotes/shared";
import { BlockStore } from "./blockStore";
import { exportSessionMarkdown } from "./exporter";
import { detectLocalPhotoMimeType } from "./localPhotoImport";
import { PhotoIngestPipeline } from "./photoIngestPipeline";
import type { RecognitionProviderConfig } from "./providerConfigStore";
import { readRecognitionJobs } from "./recognitionJobLog";
import {
  recognitionProviderLabel,
  type RecognitionFailureKind,
  type RecognitionJobStatus,
  type RecognitionRuntimeEvent
} from "./recognitionQueue";

export type ProviderTurnAcceptanceReport = {
  version: 1;
  provider: {
    id: string;
    label: string;
    model: string;
    endpoint: string;
  };
  timing: {
    startedAt: string;
    firstTokenMs?: number;
    elapsedMs: number;
  };
  stream: {
    eventCount: number;
    warningCount: number;
    previewUpdateCount: number;
  };
  result: {
    status: RecognitionJobStatus;
    failureKind?: RecognitionFailureKind;
    warnings: string[];
  };
  artifacts: {
    sessionDir: string;
    transcriptPath?: string;
    exportPath?: string;
    reportPath: string;
  };
};

export type RunProviderTurnAcceptanceArgs = {
  outputRoot: string;
  imagePath: string;
  provider: RecognitionProvider;
  providerConfig: RecognitionProviderConfig;
  now: string;
};

export async function runProviderTurnAcceptance(
  args: RunProviderTurnAcceptanceArgs
): Promise<ProviderTurnAcceptanceReport> {
  const notebookId = "provider_acceptance";
  const sessionId = createAcceptanceSessionId(args.now);
  const store = new BlockStore(args.outputRoot);
  await store.createSession({
    notebookId,
    sessionId,
    title: `Provider acceptance ${args.now}`,
    now: args.now
  });

  const startedAtMs = performance.now();
  let firstTokenMs: number | undefined;
  const runtimeEvents: RecognitionRuntimeEvent[] = [];
  const pipeline = new PhotoIngestPipeline({
    store,
    provider: args.provider,
    onRecognitionRuntimeEvent: (event) => {
      runtimeEvents.push(event);
      if (firstTokenMs === undefined && event.level === "stdout" && event.message.length > 0) {
        firstTokenMs = elapsedSince(startedAtMs);
      }
    }
  });

  let pipelineError: unknown;
  try {
    await pipeline.ingestPhoto({
      notebookId,
      sessionId,
      originalName: basename(args.imagePath),
      mimeType: detectLocalPhotoMimeType(args.imagePath),
      bytes: await readFile(args.imagePath),
      receivedAt: args.now
    });
  } catch (error) {
    pipelineError = error;
  }

  const jobs = await readRecognitionJobs({
    rootDir: args.outputRoot,
    notebookId,
    sessionId,
    recoverRunning: false
  });
  const job = jobs.at(-1);
  if (!job) {
    throw pipelineError instanceof Error ? pipelineError : new Error("Provider acceptance created no recognition job");
  }

  const session = await store.readSession(notebookId, sessionId);
  const transcriptBlock = job.transcriptBlockId
    ? session.blocks.find((block) => block.id === job.transcriptBlockId && block.type === "markdown")
    : undefined;
  const exportResult = await exportSessionMarkdown({
    rootDir: args.outputRoot,
    notebookId,
    sessionId,
    includeMetadataComments: true,
    mathCompatibility: "portable"
  });
  const sessionDir = store.getSessionDir(notebookId, sessionId);
  const reportPath = join(sessionDir, "logs", "provider_turn_acceptance.json");
  const report: ProviderTurnAcceptanceReport = {
    version: 1,
    provider: {
      id: args.provider.name,
      label: recognitionProviderLabel(args.provider.name),
      model: args.providerConfig.model,
      endpoint: sanitizeEndpoint(args.providerConfig.baseUrl)
    },
    timing: {
      startedAt: args.now,
      firstTokenMs,
      elapsedMs: elapsedSince(startedAtMs)
    },
    stream: {
      eventCount: runtimeEvents.length,
      warningCount: runtimeEvents.filter((event) => event.level === "warning").length,
      previewUpdateCount: runtimeEvents.filter((event) => event.previewChanged).length
    },
    result: {
      status: job.status,
      failureKind: job.failureKind,
      warnings: job.warnings ?? []
    },
    artifacts: {
      sessionDir,
      transcriptPath: transcriptBlock ? join(sessionDir, transcriptBlock.path) : undefined,
      exportPath: exportResult.outPath,
      reportPath
    }
  };

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function createAcceptanceSessionId(now: string): string {
  const timestamp = now.replace(/\D/g, "").slice(0, 17) || Date.now().toString();
  const nonce = Math.random().toString(16).slice(2, 10);
  return `provider_turn_${timestamp}_${nonce}`;
}

function sanitizeEndpoint(endpoint?: string): string {
  if (!endpoint) {
    return "";
  }
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid endpoint]";
  }
}

function elapsedSince(startedAtMs: number): number {
  return Math.max(0, Math.round(performance.now() - startedAtMs));
}

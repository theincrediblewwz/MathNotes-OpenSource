import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProviderTurnAcceptanceReport } from "./providerTurnAcceptance";
import type {
  ResolvedQualityBenchmarkManifest,
  ResolvedQualityBenchmarkSample
} from "./qualityBenchmarkManifest";
import { scoreFaithfulTranscription, type TranscriptionQualityScore } from "./transcriptionQualityScore";

export type QualityBenchmarkProviderIdentity = {
  id: string;
  label: string;
  model: string;
  endpoint: string;
};

export type QualityBenchmarkRunInput = {
  sample: ResolvedQualityBenchmarkSample;
  runIndex: number;
  outputRoot: string;
};

export type QualityBenchmarkRunRecord = {
  version: 1;
  fingerprint: string;
  sample: {
    id: string;
    category: string;
    imageFileName: string;
    goldFileName: string;
    imageSha256: string;
    goldSha256: string;
    goldStatus: string;
  };
  runIndex: number;
  variant?: string;
  scoringVersion?: number;
  status: string;
  provider: QualityBenchmarkProviderIdentity;
  timing?: ProviderTurnAcceptanceReport["timing"];
  warnings: string[];
  score?: TranscriptionQualityScore;
  error?: string;
  artifacts?: {
    sessionDir: string;
    transcriptPath?: string;
    exportPath?: string;
    reportPath: string;
  };
};

type MetricSummary = {
  mean: number;
  min: number;
  standardDeviation: number;
};

export type QualityBenchmarkReport = {
  version: 1;
  label: string;
  variant: string;
  repeats: number;
  provider: QualityBenchmarkProviderIdentity;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  samples: Array<{
    id: string;
    category: string;
    imageFileName: string;
    goldFileName: string;
    imageSha256: string;
    goldSha256: string;
    goldStatus: string;
    metrics: {
      contentSimilarity: MetricSummary;
      formulaExactRate: MetricSummary;
      structureLcsRatio: MetricSummary;
    };
    runs: QualityBenchmarkRunRecord[];
  }>;
  artifacts: {
    jsonReportPath: string;
    markdownReportPath: string;
  };
};

export type RunQualityBenchmarkArgs = {
  manifest: ResolvedQualityBenchmarkManifest;
  outputRoot: string;
  provider: QualityBenchmarkProviderIdentity;
  sensitiveValues?: string[];
  now?: () => string;
  runTurn: (input: QualityBenchmarkRunInput) => Promise<ProviderTurnAcceptanceReport>;
};

export type QualityBenchmarkReuseInspection = {
  total: number;
  reusable: number;
  missing: number;
};

export const QUALITY_SCORING_VERSION = 1;

export async function inspectQualityBenchmarkReuse(args: {
  manifest: ResolvedQualityBenchmarkManifest;
  outputRoot: string;
  provider: QualityBenchmarkProviderIdentity;
}): Promise<QualityBenchmarkReuseInspection> {
  const provider = sanitizeProvider(args.provider);
  let reusable = 0;

  for (const sample of args.manifest.samples) {
    for (let runIndex = 1; runIndex <= args.manifest.repeats; runIndex += 1) {
      const fingerprint = createRunFingerprint(args.manifest, sample, provider, runIndex);
      const runRecordPath = join(args.outputRoot, "runs", safePathSegment(sample.id), `${runIndex}.json`);
      if (await hasReusableRun(runRecordPath, {
        fingerprint,
        variant: args.manifest.variant,
        outputRoot: args.outputRoot
      })) {
        reusable += 1;
      }
    }
  }

  const total = args.manifest.samples.length * args.manifest.repeats;
  return { total, reusable, missing: total - reusable };
}

export async function runQualityBenchmark(args: RunQualityBenchmarkArgs): Promise<QualityBenchmarkReport> {
  const provider = sanitizeProvider(args.provider);
  const sensitiveValues = (args.sensitiveValues ?? []).filter(Boolean);
  const now = args.now ?? (() => new Date().toISOString());
  await mkdir(args.outputRoot, { recursive: true });
  const sampleReports: QualityBenchmarkReport["samples"] = [];
  let skipped = 0;

  for (const sample of args.manifest.samples) {
    const goldMarkdown = await readFile(sample.goldMarkdownPath, "utf8");
    const runs: QualityBenchmarkRunRecord[] = [];

    for (let runIndex = 1; runIndex <= args.manifest.repeats; runIndex += 1) {
      const fingerprint = createRunFingerprint(args.manifest, sample, provider, runIndex);
      const runRecordPath = join(args.outputRoot, "runs", safePathSegment(sample.id), `${runIndex}.json`);
      const existing = await readReusableRun(runRecordPath, {
        fingerprint,
        sample,
        provider,
        variant: args.manifest.variant,
        goldMarkdown,
        outputRoot: args.outputRoot,
        transcriptCachePath: join(args.outputRoot, "transcripts", safePathSegment(sample.id), `${runIndex}.md`)
      });
      if (existing) {
        await writeJsonAtomic(runRecordPath, existing);
        runs.push(existing);
        skipped += 1;
        continue;
      }

      const runOutputRoot = join(args.outputRoot, "provider-turns", safePathSegment(sample.id), `${runIndex}`);
      let record: QualityBenchmarkRunRecord;
      try {
        const turn = await args.runTurn({ sample, runIndex, outputRoot: runOutputRoot });
        const transcriptMarkdown = turn.artifacts.transcriptPath
          ? await readFile(turn.artifacts.transcriptPath, "utf8")
          : undefined;
        const transcriptCachePath = join(
          args.outputRoot,
          "transcripts",
          safePathSegment(sample.id),
          `${runIndex}.md`
        );
        if (transcriptMarkdown !== undefined) {
          await writeTextAtomic(transcriptCachePath, transcriptMarkdown);
        }
        record = {
          version: 1,
          fingerprint,
          sample: publicSample(sample),
          runIndex,
          variant: args.manifest.variant,
          scoringVersion: QUALITY_SCORING_VERSION,
          status: turn.result.status,
          provider,
          timing: turn.timing,
          warnings: turn.result.warnings.map((warning) => sanitizeText(warning, sensitiveValues)),
          score: transcriptMarkdown ? scoreFaithfulTranscription(transcriptMarkdown, goldMarkdown) : undefined,
          artifacts: {
            sessionDir: reportArtifactPath(args.outputRoot, turn.artifacts.sessionDir),
            transcriptPath: transcriptMarkdown !== undefined
              ? reportArtifactPath(args.outputRoot, transcriptCachePath)
              : undefined,
            exportPath: turn.artifacts.exportPath
              ? reportArtifactPath(args.outputRoot, turn.artifacts.exportPath)
              : undefined,
            reportPath: reportArtifactPath(args.outputRoot, turn.artifacts.reportPath)
          }
        };
      } catch (error) {
        record = {
          version: 1,
          fingerprint,
          sample: publicSample(sample),
          runIndex,
          variant: args.manifest.variant,
          scoringVersion: QUALITY_SCORING_VERSION,
          status: "runner_failed",
          provider,
          warnings: [],
          error: sanitizeText(error instanceof Error ? error.message : "Benchmark run failed", sensitiveValues)
        };
      }

      await writeJsonAtomic(runRecordPath, record);
      runs.push(record);
    }

    const scores = runs.flatMap((run) => run.status === "succeeded" && run.score ? [run.score] : []);
    sampleReports.push({
      ...publicSample(sample),
      metrics: {
        contentSimilarity: summarize(scores.map((score) => score.content.similarity)),
        formulaExactRate: summarize(scores.map((score) => score.formulas.exactRate)),
        structureLcsRatio: summarize(scores.map((score) => score.structure.lcsRatio))
      },
      runs
    });
  }

  const allRuns = sampleReports.flatMap((sample) => sample.runs);
  const jsonReportPath = join(args.outputRoot, "quality_benchmark_report.json");
  const markdownReportPath = join(args.outputRoot, "quality_benchmark_report.md");
  const report: QualityBenchmarkReport = {
    version: 1,
    label: args.manifest.label,
    variant: args.manifest.variant,
    repeats: args.manifest.repeats,
    provider,
    summary: {
      total: allRuns.length,
      succeeded: allRuns.filter((run) => run.status === "succeeded").length,
      failed: allRuns.filter((run) => run.status !== "succeeded").length,
      skipped
    },
    samples: sampleReports,
    artifacts: {
      jsonReportPath: reportArtifactPath(args.outputRoot, jsonReportPath),
      markdownReportPath: reportArtifactPath(args.outputRoot, markdownReportPath)
    }
  };

  await writeJsonAtomic(jsonReportPath, report);
  await writeTextAtomic(markdownReportPath, renderMarkdownReport(report, now()));
  return report;
}

function createRunFingerprint(
  manifest: ResolvedQualityBenchmarkManifest,
  sample: ResolvedQualityBenchmarkSample,
  provider: QualityBenchmarkProviderIdentity,
  runIndex: number
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    label: manifest.label,
    variant: manifest.variant,
    imageSha256: sample.imageSha256,
    provider,
    runIndex
  })).digest("hex");
}

async function readReusableRun(path: string, args: {
  fingerprint: string;
  sample: ResolvedQualityBenchmarkSample;
  provider: QualityBenchmarkProviderIdentity;
  variant: string;
  goldMarkdown: string;
  outputRoot: string;
  transcriptCachePath: string;
}): Promise<QualityBenchmarkRunRecord | undefined> {
  try {
    const record = JSON.parse(await readTextWithBackup(path)) as QualityBenchmarkRunRecord;
    if (
      record.version !== 1 ||
      record.status !== "succeeded" ||
      record.variant !== args.variant ||
      record.fingerprint !== args.fingerprint
    ) {
      return undefined;
    }
    const transcriptPath = record.artifacts?.transcriptPath;
    if (!transcriptPath) return undefined;
    const sourceTranscriptPath = isAbsolute(transcriptPath)
      ? transcriptPath
      : resolve(args.outputRoot, transcriptPath);
    const transcriptMarkdown = await readTextWithBackup(sourceTranscriptPath);
    await writeTextAtomic(args.transcriptCachePath, transcriptMarkdown);
    return {
      ...record,
      fingerprint: args.fingerprint,
      sample: publicSample(args.sample),
      variant: args.variant,
      scoringVersion: QUALITY_SCORING_VERSION,
      provider: args.provider,
      score: scoreFaithfulTranscription(transcriptMarkdown, args.goldMarkdown),
      artifacts: record.artifacts ? {
        sessionDir: reportArtifactPath(args.outputRoot, record.artifacts.sessionDir),
        transcriptPath: reportArtifactPath(args.outputRoot, args.transcriptCachePath),
        exportPath: record.artifacts.exportPath
          ? reportArtifactPath(args.outputRoot, record.artifacts.exportPath)
          : undefined,
        reportPath: reportArtifactPath(args.outputRoot, record.artifacts.reportPath)
      } : undefined
    };
  } catch {
    return undefined;
  }
}

async function hasReusableRun(path: string, args: {
  fingerprint: string;
  variant: string;
  outputRoot: string;
}): Promise<boolean> {
  try {
    const record = JSON.parse(await readTextWithBackup(path)) as QualityBenchmarkRunRecord;
    if (
      record.version !== 1 ||
      record.status !== "succeeded" ||
      record.variant !== args.variant ||
      record.fingerprint !== args.fingerprint
    ) {
      return false;
    }
    const transcriptPath = record.artifacts?.transcriptPath;
    if (!transcriptPath) return false;
    const sourceTranscriptPath = isAbsolute(transcriptPath)
      ? transcriptPath
      : resolve(args.outputRoot, transcriptPath);
    await readTextWithBackup(sourceTranscriptPath);
    return true;
  } catch {
    return false;
  }
}

function publicSample(sample: ResolvedQualityBenchmarkSample) {
  return {
    id: sample.id,
    category: sample.category,
    imageFileName: sample.imageFileName,
    goldFileName: sample.goldFileName,
    imageSha256: sample.imageSha256,
    goldSha256: sample.goldSha256,
    goldStatus: sample.goldStatus
  };
}

function summarize(values: number[]): MetricSummary {
  if (values.length === 0) return { mean: 0, min: 0, standardDeviation: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean,
    min: Math.min(...values),
    standardDeviation: Math.sqrt(variance)
  };
}

function sanitizeProvider(provider: QualityBenchmarkProviderIdentity): QualityBenchmarkProviderIdentity {
  return { ...provider, endpoint: sanitizeEndpoint(provider.endpoint) };
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid endpoint]";
  }
}

function sanitizeText(value: string, sensitiveValues: string[]): string {
  let sanitized = value;
  for (const secret of sensitiveValues) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  sanitized = sanitized.replace(/(api[-_]?key\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
  return sanitized.replace(/https?:\/\/[^\s]+/gi, (url) => sanitizeEndpoint(url));
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function reportArtifactPath(outputRoot: string, artifactPath: string): string {
  const absoluteRoot = resolve(outputRoot);
  const absoluteArtifact = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : resolve(absoluteRoot, artifactPath);
  const localPath = relative(absoluteRoot, absoluteArtifact);
  if (localPath && !localPath.startsWith("..") && !isAbsolute(localPath)) {
    return localPath.replace(/\\/g, "/");
  }
  if (!localPath) return ".";
  return `[external]/${basename(artifactPath)}`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const backupPath = `${path}.bak`;
  await writeFile(temporaryPath, value, "utf8");
  try {
    await rename(temporaryPath, path);
    await rm(backupPath, { force: true });
  } catch (error) {
    if (!isReplaceError(error)) throw error;
    await rm(backupPath, { force: true });
    await rename(path, backupPath);
    try {
      await rename(temporaryPath, path);
      await rm(backupPath, { force: true });
    } catch (replacementError) {
      try {
        await rename(backupPath, path);
      } catch {
        // A later run reads the deterministic backup if restoration is interrupted.
      }
      await rm(temporaryPath, { force: true });
      throw replacementError;
    }
  }
}

async function readTextWithBackup(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    try {
      return await readFile(`${path}.bak`, "utf8");
    } catch {
      throw error;
    }
  }
}

function isReplaceError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES");
}

function renderMarkdownReport(report: QualityBenchmarkReport, generatedAt: string): string {
  const lines = [
    `# Faithful Transcription Quality Benchmark`,
    "",
    `- label: \`${report.label}\``,
    `- variant: \`${report.variant}\``,
    `- provider: \`${report.provider.label}\` (\`${report.provider.model}\`)`,
    `- endpoint: \`${report.provider.endpoint}\``,
    `- generated_at: \`${generatedAt}\``,
    `- runs: ${report.summary.succeeded} succeeded, ${report.summary.failed} failed, ${report.summary.skipped} resumed`,
    ""
  ];

  for (const sample of report.samples) {
    lines.push(
      `## ${sample.id}`,
      "",
      `- category: \`${sample.category}\``,
      `- image: \`${sample.imageFileName}\` (sha256 \`${sample.imageSha256}\`)`,
      `- Gold: \`${sample.goldFileName}\` (${sample.goldStatus}, sha256 \`${sample.goldSha256}\`)`,
      `- content similarity: mean ${formatMetric(sample.metrics.contentSimilarity.mean)}, min ${formatMetric(sample.metrics.contentSimilarity.min)}, sd ${formatMetric(sample.metrics.contentSimilarity.standardDeviation)}`,
      `- formula exact: mean ${formatMetric(sample.metrics.formulaExactRate.mean)}, min ${formatMetric(sample.metrics.formulaExactRate.min)}, sd ${formatMetric(sample.metrics.formulaExactRate.standardDeviation)}`,
      `- structure LCS: mean ${formatMetric(sample.metrics.structureLcsRatio.mean)}, min ${formatMetric(sample.metrics.structureLcsRatio.min)}, sd ${formatMetric(sample.metrics.structureLcsRatio.standardDeviation)}`,
      "",
      "| Run | Status | Content | Formula exact | Structure | Warnings |",
      "| --- | --- | ---: | ---: | ---: | ---: |"
    );
    for (const run of sample.runs) {
      lines.push(`| ${run.runIndex} | ${run.status} | ${formatMetric(run.score?.content.similarity)} | ${formatMetric(run.score?.formulas.exactRate)} | ${formatMetric(run.score?.structure.lcsRatio)} | ${run.warnings.length} |`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(4);
}

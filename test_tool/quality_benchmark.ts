import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runProviderTurnAcceptance } from "../apps/windows/src/core/providerTurnAcceptance";
import { readProviderConfig } from "../apps/windows/src/core/providerConfigStore";
import { createRecognitionProviderFromConfig } from "../apps/windows/src/core/recognitionProviderFactory";
import { readQualityBenchmarkManifest } from "../apps/windows/src/core/qualityBenchmarkManifest";
import {
  inspectQualityBenchmarkReuse,
  runQualityBenchmark,
  type QualityBenchmarkReport,
  type QualityBenchmarkReuseInspection
} from "../apps/windows/src/core/qualityBenchmarkRunner";
import { recognitionProviderLabel } from "../apps/windows/src/core/recognitionQueue";
import { readUserSettings } from "../apps/windows/src/core/userSettingsStore";

export type QualityBenchmarkCliArgs = {
  manifestPath: string;
  notesRoot?: string;
  outputRoot?: string;
  confirmPaid: boolean;
  allowMock: boolean;
  resumeOnly: boolean;
};

export type QualityBenchmarkCliDependencies = {
  readSettings: typeof readUserSettings;
  readConfig: typeof readProviderConfig;
  readManifest: typeof readQualityBenchmarkManifest;
  createProvider: typeof createRecognitionProviderFromConfig;
  inspectReuse: typeof inspectQualityBenchmarkReuse;
  runBenchmark: typeof runQualityBenchmark;
  writeOutput: (value: string) => void;
};

export type QualityBenchmarkCliResult =
  | ({ mode: "preflight" } & QualityBenchmarkReuseInspection & { plannedCalls: number; requiredCalls: number })
  | ({ mode: "resume-only" | "completed" } & QualityBenchmarkReuseInspection & {
      plannedCalls: number;
      requiredCalls: number;
      report: QualityBenchmarkReport;
    });

const defaultDependencies: QualityBenchmarkCliDependencies = {
  readSettings: readUserSettings,
  readConfig: readProviderConfig,
  readManifest: readQualityBenchmarkManifest,
  createProvider: createRecognitionProviderFromConfig,
  inspectReuse: inspectQualityBenchmarkReuse,
  runBenchmark: runQualityBenchmark,
  writeOutput: (value) => process.stdout.write(value)
};

export function parseQualityBenchmarkArgs(argv: string[]): QualityBenchmarkCliArgs {
  const parsed: QualityBenchmarkCliArgs = {
    manifestPath: "",
    confirmPaid: false,
    allowMock: false,
    resumeOnly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-paid") {
      parsed.confirmPaid = true;
      continue;
    }
    if (argument === "--allow-mock") {
      parsed.allowMock = true;
      continue;
    }
    if (argument === "--resume-only") {
      parsed.resumeOnly = true;
      continue;
    }
    if (argument === "--manifest" || argument === "--notes-root" || argument === "--output-root") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path value`);
      }
      if (argument === "--manifest") parsed.manifestPath = value;
      if (argument === "--notes-root") parsed.notesRoot = value;
      if (argument === "--output-root") parsed.outputRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!parsed.manifestPath) {
    throw new Error("--manifest is required; select one private benchmark manifest explicitly");
  }
  if (parsed.resumeOnly && parsed.confirmPaid) {
    throw new Error("--resume-only cannot be combined with --confirm-paid");
  }
  return parsed;
}

export async function runQualityBenchmarkCli(
  argv: string[],
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  dependencies: QualityBenchmarkCliDependencies = defaultDependencies
): Promise<QualityBenchmarkCliResult> {
  const options = parseQualityBenchmarkArgs(argv);
  const userDataDir = resolve(
    env.MATHNOTES_USER_DATA ?? join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Electron")
  );
  const fallbackNotesRoot = join(userDataDir, "MyMathNotes");
  const settings = await dependencies.readSettings({ userDataDir, fallbackNotesRootDir: fallbackNotesRoot });
  const notesRoot = resolve(options.notesRoot ?? env.MATHNOTES_ROOT ?? settings.notesRootDir);
  const providerConfig = await dependencies.readConfig({ rootDir: notesRoot });

  if (providerConfig.providerId === "mock" && !options.allowMock) {
    throw new Error("The selected Provider is the mock pipeline validator. Pass --allow-mock only for deterministic smoke tests.");
  }

  const manifest = await dependencies.readManifest(resolve(options.manifestPath), {
    allowSmokeRepeats: providerConfig.providerId === "mock" && options.allowMock
  });
  const plannedCalls = manifest.samples.length * manifest.repeats;
  const label = recognitionProviderLabel(providerConfig.providerId);
  const outputRoot = resolve(
    options.outputRoot ?? join(
      notesRoot,
      "quality-benchmark-runs",
      benchmarkPathSegment(manifest.label),
      benchmarkPathSegment(manifest.variant)
    )
  );
  const providerIdentity = {
    id: providerConfig.providerId,
    label,
    model: providerConfig.model,
    endpoint: providerConfig.baseUrl ?? ""
  };
  const reuse = await dependencies.inspectReuse({ manifest, outputRoot, provider: providerIdentity });
  const requiredCalls = reuse.missing;
  dependencies.writeOutput(`识别服务：${label}\n`);
  dependencies.writeOutput(`模型：${providerConfig.model || "(默认)"}\n`);
  dependencies.writeOutput(`计划调用：${manifest.samples.length} 张图片 × ${manifest.repeats} 次 = ${plannedCalls} 次\n`);
  dependencies.writeOutput(`预计复用：${reuse.reusable} 次；仍需调用：${requiredCalls} 次\n`);

  if (options.resumeOnly && reuse.missing > 0) {
    throw new Error(`--resume-only requires complete reusable evidence; ${reuse.missing} run(s) are missing`);
  }

  if (!options.resumeOnly && providerConfig.providerId !== "mock" && !options.confirmPaid) {
    dependencies.writeOutput("预检完成：未提供 --confirm-paid，未发送任何图片。\n");
    return { mode: "preflight", plannedCalls, requiredCalls, ...reuse };
  }

  const provider = options.resumeOnly
    ? undefined
    : await dependencies.createProvider({ rootDir: notesRoot, env });
  const sensitiveValues = [
    providerConfig.apiKey ?? "",
    env[providerConfig.apiKeyEnvVar] ?? ""
  ].filter(Boolean);
  const report = await dependencies.runBenchmark({
    manifest,
    outputRoot,
    provider: provider ? { ...providerIdentity, id: provider.name } : providerIdentity,
    sensitiveValues,
    runTurn: options.resumeOnly
      ? async () => { throw new Error("resume-only invariant violated: Provider call attempted"); }
      : (input) => runProviderTurnAcceptance({
          outputRoot: input.outputRoot,
          imagePath: input.sample.imagePath,
          provider: provider!,
          providerConfig,
          now: new Date().toISOString()
        })
  });

  dependencies.writeOutput(`完成：${report.summary.succeeded}/${report.summary.total} 成功，${report.summary.failed} 失败。\n`);
  dependencies.writeOutput(`JSON 报告：${resolve(outputRoot, report.artifacts.jsonReportPath)}\n`);
  dependencies.writeOutput(`Markdown 报告：${resolve(outputRoot, report.artifacts.markdownReportPath)}\n`);
  return {
    mode: options.resumeOnly ? "resume-only" : "completed",
    plannedCalls,
    requiredCalls,
    ...reuse,
    report
  };
}

export function benchmarkPathSegment(value: string): string {
  const readablePrefix = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40) || "benchmark";
  const identityHash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readablePrefix}-${identityHash}`;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entryPath && import.meta.url === entryPath) {
  runQualityBenchmarkCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Quality benchmark failed"}\n`);
    process.exitCode = 1;
  });
}

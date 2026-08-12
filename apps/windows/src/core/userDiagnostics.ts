import type { CodexRuntimeState } from "./codexRuntimeManager";
import { getRecognitionProviderCapability } from "./providerCapabilities";
import type { ProviderHealthReport } from "./providerHealth";
import type { RecognitionProviderConfig } from "./providerConfigStore";
import type { IngestServerState } from "../types/mathNotesApi";
import {
  userDiagnosticSchemaVersion,
  type ProviderSelfTestResult,
  type UserDiagnosticReport
} from "../common/userDiagnostics";

export type BuildUserDiagnosticReportArgs = {
  generatedAt: string;
  application: UserDiagnosticReport["application"];
  system: UserDiagnosticReport["system"];
  providerConfig: RecognitionProviderConfig;
  providerHealth: ProviderHealthReport;
  credentialConfigured: boolean;
  runtime: CodexRuntimeState;
  receiver: IngestServerState;
  latestSelfTest?: ProviderSelfTestResult;
};

export function buildUserDiagnosticReport(args: BuildUserDiagnosticReportArgs): UserDiagnosticReport {
  const capability = getRecognitionProviderCapability(args.providerConfig.providerId);
  const requiresApiKey = args.providerConfig.providerId !== "mock" && args.providerConfig.providerId !== "codex_cli";
  return {
    schemaVersion: userDiagnosticSchemaVersion,
    generatedAt: args.generatedAt,
    application: args.application,
    system: args.system,
    provider: {
      id: args.providerConfig.providerId,
      label: capability.label,
      model: args.providerConfig.model,
      endpoint: sanitizeEndpoint(args.providerConfig.baseUrl),
      credentialStatus: requiresApiKey
        ? args.credentialConfigured ? "configured" : "missing"
        : "not_required",
      healthOk: args.providerHealth.ok,
      healthSummary: args.providerHealth.summary,
      checks: args.providerHealth.checks.map((check) => ({
        id: check.id,
        status: check.status,
        label: check.label
      }))
    },
    runtime: {
      status: args.runtime.status,
      progress: args.runtime.progress
    },
    receiver: {
      running: args.receiver.running,
      port: args.receiver.port,
      addressCount: args.receiver.addressCandidates?.filter((candidate) => candidate.usable).length ?? 0
    },
    latestSelfTest: args.latestSelfTest
      ? {
          providerId: args.latestSelfTest.providerId,
          providerLabel: args.latestSelfTest.providerLabel,
          model: args.latestSelfTest.model,
          status: args.latestSelfTest.status,
          failureKind: args.latestSelfTest.failureKind,
          warningCount: args.latestSelfTest.warningCount,
          eventCount: args.latestSelfTest.eventCount,
          previewUpdateCount: args.latestSelfTest.previewUpdateCount,
          elapsedMs: args.latestSelfTest.elapsedMs,
          firstTokenMs: args.latestSelfTest.firstTokenMs
        }
      : undefined
  };
}

export function hasConfiguredProviderCredential(
  config: RecognitionProviderConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): boolean {
  if (config.providerId === "mock" || config.providerId === "codex_cli") return true;
  return Boolean(config.apiKey?.trim() || env[config.apiKeyEnvVar]);
}

function sanitizeEndpoint(endpoint?: string): string {
  if (!endpoint) return "";
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid endpoint]";
  }
}

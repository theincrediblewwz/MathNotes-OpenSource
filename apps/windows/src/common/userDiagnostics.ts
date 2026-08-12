import type { RecognitionFailureKind, RecognitionJobStatus } from "../core/recognitionQueue";
import type { RecognitionProviderId } from "../core/providerConfigStore";

export const userDiagnosticSchemaVersion = 1 as const;

export type ProviderSelfTestInput = {
  imagePath: string;
  confirmedExternalCall: boolean;
};

export type ProviderSelfTestResult = {
  providerId: RecognitionProviderId;
  providerLabel: string;
  model: string;
  status: RecognitionJobStatus;
  failureKind?: RecognitionFailureKind;
  warningCount: number;
  eventCount: number;
  previewUpdateCount: number;
  elapsedMs: number;
  firstTokenMs?: number;
  reportPath: string;
  exportPath?: string;
};

export type UserDiagnosticReport = {
  schemaVersion: typeof userDiagnosticSchemaVersion;
  generatedAt: string;
  application: {
    name: string;
    version: string;
    packaged: boolean;
  };
  system: {
    platform: string;
    architecture: string;
    node: string;
    electron: string;
    chrome: string;
  };
  provider: {
    id: RecognitionProviderId;
    label: string;
    model: string;
    endpoint: string;
    credentialStatus: "configured" | "missing" | "not_required";
    healthOk: boolean;
    healthSummary: string;
    checks: Array<{ id: string; status: "ok" | "attention"; label: string }>;
  };
  runtime: {
    status: string;
    progress: number;
  };
  receiver: {
    running: boolean;
    port?: number;
    addressCount: number;
  };
  latestSelfTest?: Omit<ProviderSelfTestResult, "reportPath" | "exportPath">;
};

export type ExportUserDiagnosticReportInput = {
  outputPath?: string;
};

export type ExportUserDiagnosticReportResult =
  | { cancelled: true }
  | { cancelled: false; outputPath: string; report: UserDiagnosticReport };

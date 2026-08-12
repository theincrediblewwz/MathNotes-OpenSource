import { describe, expect, it } from "vitest";
import { getRecognitionProviderCapability } from "./providerCapabilities";

describe("provider capabilities", () => {
  it("describes Codex CLI as a local process runtime with process logs", () => {
    expect(getRecognitionProviderCapability("codex_cli")).toMatchObject({
      providerId: "codex_cli",
      label: "Codex CLI",
      requiresLocalRuntime: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsHealthCheck: true,
      runtimeLogKind: "process",
      retryPolicy: "manual"
    });
  });

  it("describes Mimo v2.5 as an API runtime with API logs", () => {
    expect(getRecognitionProviderCapability("mimo_2_5")).toMatchObject({
      providerId: "mimo_2_5",
      label: "Mimo v2.5",
      requiresLocalRuntime: false,
      supportsVision: true,
      supportsStreaming: true,
      supportsHealthCheck: true,
      runtimeLogKind: "api",
      retryPolicy: "manual"
    });
  });

  it("describes DeepSeek compatible provider as an API runtime", () => {
    expect(getRecognitionProviderCapability("deepseek")).toMatchObject({
      providerId: "deepseek",
      label: "DeepSeek Compatible",
      requiresLocalRuntime: false,
      supportsVision: false,
      supportsStreaming: true,
      supportsHealthCheck: true,
      runtimeLogKind: "api",
      retryPolicy: "manual"
    });
  });

  it("falls back to mock provider capability for unknown or empty provider ids", () => {
    expect(getRecognitionProviderCapability(null)).toMatchObject({
      providerId: "mock",
      label: "假识别服务（验证管线）",
      runtimeLogKind: "none"
    });
  });
});

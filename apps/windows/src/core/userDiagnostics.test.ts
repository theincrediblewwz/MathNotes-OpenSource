import { describe, expect, it } from "vitest";
import { buildUserDiagnosticReport, hasConfiguredProviderCredential } from "./userDiagnostics";

describe("user diagnostics", () => {
  it("exports only redacted provider and runtime state", () => {
    const report = buildUserDiagnosticReport({
      generatedAt: "2026-07-15T00:00:00.000Z",
      application: { name: "MathNotes", version: "0.1.6", packaged: false },
      system: { platform: "win32", architecture: "x64", node: "24", electron: "39", chrome: "140" },
      providerConfig: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKey: "secret-direct-key",
        apiKeyEnvVar: "MIMO_API_KEY",
        baseUrl: "https://api.xiaomimimo.com/v1?token=must-not-leak",
        status: "configured"
      },
      providerHealth: {
        providerId: "mimo_2_5",
        ok: true,
        summary: "配置可用",
        detail: "secret-direct-key",
        checks: [{ id: "api_key", label: "API 密钥", status: "ok", detail: "secret-direct-key" }]
      },
      credentialConfigured: true,
      runtime: { status: "stopped", progress: 0, detail: "private detail", updatedAt: "2026-07-15T00:00:00.000Z" },
      receiver: { running: true, port: 4095, token: "pairing-secret", addressCandidates: [] },
      latestSelfTest: {
        providerId: "mimo_2_5",
        providerLabel: "Mimo v2.5",
        model: "mimo-v2.5",
        status: "succeeded",
        warningCount: 0,
        eventCount: 3,
        previewUpdateCount: 2,
        elapsedMs: 1200,
        reportPath: "C:/private/diagnostic.json",
        exportPath: "C:/private/export.md"
      }
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-direct-key");
    expect(serialized).not.toContain("pairing-secret");
    expect(serialized).not.toContain("MIMO_API_KEY");
    expect(serialized).not.toContain("C:/private");
    expect(serialized).not.toContain("token=must-not-leak");
    expect(report.provider.endpoint).toBe("https://api.xiaomimimo.com/v1");
    expect(report.provider.credentialStatus).toBe("configured");
  });

  it("detects direct, environment and no-key provider credentials without exposing values", () => {
    const base = {
      providerId: "mimo_2_5" as const,
      model: "mimo-v2.5",
      apiKeyEnvVar: "MIMO_API_KEY",
      status: "configured" as const
    };
    expect(hasConfiguredProviderCredential({ ...base, apiKey: "direct" }, {})).toBe(true);
    expect(hasConfiguredProviderCredential(base, { MIMO_API_KEY: "environment" })).toBe(true);
    expect(hasConfiguredProviderCredential(base, {})).toBe(false);
    expect(hasConfiguredProviderCredential({ ...base, providerId: "codex_cli" }, {})).toBe(true);
  });
});

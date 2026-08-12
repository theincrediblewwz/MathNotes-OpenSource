import { describe, expect, it } from "vitest";
import {
  getProviderDescriptor,
  isProviderAllowedForPurpose,
  isProviderId,
  PROVIDER_CATALOG
} from "./providerCatalog";

describe("providerCatalog", () => {
  it("keeps the frozen legacy wire IDs and adds the new presets", () => {
    const providerIds = [
      "mimo_2_5",
      "glm_5_2",
      "openai_vision",
      "deepseek",
      "gemini",
      "qwen",
      "custom_openai_compatible",
      "codex_cli"
    ] as const;
    for (const providerId of providerIds) {
      expect(getProviderDescriptor(providerId)).toBeDefined();
      expect(getProviderDescriptor(providerId)?.wireId).toBe(providerId);
    }
  });

  it("keeps DeepSeek dialogue-only and every other preset dual-purpose", () => {
    expect(isProviderAllowedForPurpose("deepseek", "recognition")).toBe(false);
    expect(isProviderAllowedForPurpose("deepseek", "assistant")).toBe(true);
    const dualPurposeIds = ["mimo_2_5", "glm_5_2", "openai_vision", "gemini", "qwen", "custom_openai_compatible"] as const;
    for (const providerId of dualPurposeIds) {
      expect(isProviderAllowedForPurpose(providerId, "recognition")).toBe(true);
      expect(isProviderAllowedForPurpose(providerId, "assistant")).toBe(true);
    }
  });

  it("uses the frozen official defaults for DeepSeek, Gemini and Qwen", () => {
    expect(PROVIDER_CATALOG.deepseek.defaultBaseUrl).toBe("https://api.deepseek.com");
    expect(PROVIDER_CATALOG.deepseek.defaultModel).toBe("deepseek-v4-flash");
    expect(PROVIDER_CATALOG.gemini.defaultBaseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(PROVIDER_CATALOG.qwen.defaultBaseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(PROVIDER_CATALOG.qwen.defaultModel).toBe("qwen3.7-plus");
    expect(PROVIDER_CATALOG.openai_vision.defaultModel).toBe("gpt-4.1-mini");
  });

  it("keeps MiMo api-key auth, all other compatible presets bearer, and Codex local", () => {
    expect(PROVIDER_CATALOG.mimo_2_5.authScheme).toBe("api-key");
    const bearerIds = ["glm_5_2", "deepseek", "gemini", "qwen", "custom_openai_compatible", "openai_vision"] as const;
    for (const providerId of bearerIds) {
      expect(PROVIDER_CATALOG[providerId].authScheme).toBe("bearer");
    }
    expect(PROVIDER_CATALOG.codex_cli.requiresLocalRuntime).toBe(true);
  });

  it("requires an explicit endpoint only for the custom preset", () => {
    expect(PROVIDER_CATALOG.custom_openai_compatible.requiresEndpoint).toBe(true);
    const builtInIds = ["openai_vision", "glm_5_2", "mimo_2_5", "deepseek", "gemini", "qwen"] as const;
    for (const providerId of builtInIds) {
      expect(PROVIDER_CATALOG[providerId].requiresEndpoint).toBe(false);
    }
  });

  it("recognizes provider IDs and falls back safely for unknown strings", () => {
    expect(isProviderId("gemini")).toBe(true);
    expect(isProviderId("unknown_provider")).toBe(false);
    expect(isProviderId("toString")).toBe(false);
    expect(getProviderDescriptor("unknown_provider")).toBeUndefined();
  });
});

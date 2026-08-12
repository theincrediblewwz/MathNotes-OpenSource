import { describe, expect, it } from "vitest";
import { RuntimeProviderConfigurationError, RuntimeProviderRegistry } from "./runtimeProviderRegistry";

describe("RuntimeProviderRegistry", () => {
  it("keeps a compatible provider in memory while exposing only redacted status", async () => {
    const registry = new RuntimeProviderRegistry();
    expect(registry.status()).toEqual({ version: 1, configured: false });

    const status = registry.configure({
      providerId: "mimo_2_5",
      model: "mimo-v2.5",
      baseUrl: "https://api.xiaomimimo.com/v1/",
      apiKey: "private-key-value"
    });

    expect(status).toEqual({
      version: 1,
      configured: true,
      providerId: "mimo_2_5",
      label: "Mimo v2.5",
      model: "mimo-v2.5",
      endpoint: "https://api.xiaomimimo.com/v1"
    });
    expect(JSON.stringify(status)).not.toContain("private-key-value");
    const recognition = await registry.createRecognitionProvider();
    const assistant = await registry.createAssistantProvider();
    expect(recognition).toMatchObject({ name: "mimo_2_5" });
    expect(assistant).toBe(recognition);
  });

  it("overwrites and clears the active provider without retaining public secret state", async () => {
    const registry = new RuntimeProviderRegistry();
    registry.configure({ providerId: "mimo_2_5", model: "old", baseUrl: "https://old.example/v1", apiKey: "old-key" });
    const oldProvider = await registry.createRecognitionProvider();
    expect(registry.configure({
      providerId: "glm_5_2", model: "glm-5.2v", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "new-key"
    })).toMatchObject({ configured: true, providerId: "glm_5_2", label: "GLM 5.2" });
    expect(await registry.createRecognitionProvider()).not.toBe(oldProvider);
    expect(registry.clear()).toEqual({ version: 1, configured: false });
    await expect(registry.createAssistantProvider()).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("lets assistant inherit recognition until an independent profile is configured", async () => {
    const registry = new RuntimeProviderRegistry();
    registry.configure({
      providerId: "mimo_2_5", model: "recognition-model", baseUrl: "https://recognition.example/v1", apiKey: "recognition-key"
    });
    expect(registry.status("assistant")).toMatchObject({
      configured: true, purpose: "assistant", inherited: true, model: "recognition-model"
    });
    const inherited = await registry.createAssistantProvider();

    registry.configure({
      providerId: "glm_5_2", model: "dialogue-model", baseUrl: "https://dialogue.example/v1", apiKey: "dialogue-key"
    }, "assistant");
    expect(registry.status("assistant")).toMatchObject({
      configured: true, purpose: "assistant", inherited: false, model: "dialogue-model"
    });
    expect(await registry.createAssistantProvider()).not.toBe(inherited);
    expect(await registry.createRecognitionProvider()).toMatchObject({ name: "mimo_2_5" });

    registry.clear("assistant");
    expect(registry.status("assistant")).toMatchObject({ inherited: true, model: "recognition-model" });
  });

  it("supports the new compatible presets with preset endpoints and rejects DeepSeek recognition", () => {
    const registry = new RuntimeProviderRegistry();

    expect(registry.configure({
      providerId: "gemini",
      model: "gemini-2.5-flash",
      baseUrl: "",
      apiKey: "gemini-key"
    })).toMatchObject({
      configured: true,
      providerId: "gemini",
      label: "Gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai"
    });

    expect(registry.configure({
      providerId: "qwen",
      model: "qwen3.7-plus",
      baseUrl: "",
      apiKey: "qwen-key"
    })).toMatchObject({
      configured: true,
      providerId: "qwen",
      label: "Qwen",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    });

    expect(registry.configure({
      providerId: "openai_vision",
      model: "gpt-4.1-mini",
      baseUrl: "",
      apiKey: "openai-key"
    })).toMatchObject({
      configured: true,
      providerId: "openai_vision",
      label: "OpenAI Vision",
      endpoint: "https://api.openai.com/v1"
    });

    expect(() => registry.configure({
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "",
      apiKey: "deepseek-key"
    }, "recognition")).toThrowError(expect.objectContaining<Partial<RuntimeProviderConfigurationError>>({ code: "unsupported_provider" }));

    expect(registry.configure({
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "",
      apiKey: "deepseek-key"
    }, "assistant")).toMatchObject({
      configured: true,
      providerId: "deepseek",
      label: "DeepSeek Compatible",
      endpoint: "https://api.deepseek.com"
    });

    expect(() => registry.configure({
      providerId: "custom_openai_compatible",
      model: "custom-model",
      baseUrl: "",
      apiKey: "custom-key"
    })).toThrowError(expect.objectContaining<Partial<RuntimeProviderConfigurationError>>({ code: "invalid_provider_endpoint" }));
  });

  it.each([
    [{ providerId: "mock", model: "x", baseUrl: "https://example.test/v1", apiKey: "key" }, "unsupported_provider"],
    [{ providerId: "mimo_2_5", model: "", baseUrl: "https://example.test/v1", apiKey: "key" }, "invalid_provider_model"],
    [{ providerId: "mimo_2_5", model: "x", baseUrl: "http://example.test/v1", apiKey: "key" }, "invalid_provider_endpoint"],
    [{ providerId: "mimo_2_5", model: "x", baseUrl: "https://user@example.test/v1", apiKey: "key" }, "invalid_provider_endpoint"],
    [{ providerId: "mimo_2_5", model: "x", baseUrl: "https://example.test/v1?secret=yes", apiKey: "key" }, "invalid_provider_endpoint"],
    [{ providerId: "mimo_2_5", model: "x", baseUrl: "https://example.test/v1", apiKey: "" }, "invalid_provider_api_key"]
  ])("rejects unsafe runtime configuration", (input, code) => {
    const registry = new RuntimeProviderRegistry();
    expect(() => registry.configure(input as Parameters<typeof registry.configure>[0])).toThrowError(
      expect.objectContaining<Partial<RuntimeProviderConfigurationError>>({ code })
    );
  });

  it("tests a configured provider through a local fake endpoint without leaking the key", async () => {
    const apiKey = "probe-secret-key";
    const calls: Array<{ url: string; body: string }> = [];
    const registry = new RuntimeProviderRegistry(async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    registry.configure({
      providerId: "mimo_2_5",
      model: "mimo-v2.5",
      baseUrl: "https://api.xiaomimimo.com/v1/",
      apiKey
    });

    const result = await registry.testConnection();
    expect(result).toMatchObject({ version: 1, purpose: "recognition", ok: true });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(calls[0].body).not.toContain(apiKey);
    expect(JSON.parse(calls[0].body)).toMatchObject({ model: "mimo-v2.5", max_tokens: 1, stream: false });
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [400, "endpoint_model"],
    [404, "endpoint_model"],
    [422, "endpoint_model"],
    [429, "rate_limit"],
    [500, "provider_response"],
    [503, "provider_response"]
  ])("maps HTTP %s to a sanitized %s probe category", async (status, category) => {
    const apiKey = "probe-secret-key";
    const registry = new RuntimeProviderRegistry(async () => new Response(
      `{"error":{"message":"raw provider detail containing ${apiKey}"}}`,
      { status: status as number }
    ));
    registry.configure({
      providerId: "glm_5_2",
      model: "glm-5.2v",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey
    });

    const result = await registry.testConnection();
    expect(result.ok).toBe(false);
    expect(result.category).toBe(category);
    expect(result.message).not.toContain(apiKey);
    expect(result.message).not.toContain("raw provider detail");
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("maps probe timeouts and network failures to sanitized categories", async () => {
    const registry = new RuntimeProviderRegistry(async () => {
      throw new DOMException("aborted", "TimeoutError");
    });
    registry.configure({
      providerId: "mimo_2_5",
      model: "mimo-v2.5",
      baseUrl: "https://example.test/v1",
      apiKey: "probe-secret-key"
    });
    await expect(registry.testConnection()).resolves.toMatchObject({
      ok: false,
      category: "timeout",
      message: "连接 Provider 超时，请稍后重试。"
    });

    const networkRegistry = new RuntimeProviderRegistry(async () => {
      throw new TypeError("fetch failed");
    });
    networkRegistry.configure({
      providerId: "mimo_2_5",
      model: "mimo-v2.5",
      baseUrl: "https://example.test/v1",
      apiKey: "probe-secret-key"
    });
    await expect(networkRegistry.testConnection()).resolves.toMatchObject({
      ok: false,
      category: "provider_response",
      message: "无法连接 Provider，请检查请求地址和网络。"
    });
  });

  it("rejects an unconfigured probe with provider_unavailable", async () => {
    const registry = new RuntimeProviderRegistry();
    await expect(registry.testConnection()).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeProviderConfig, readProviderConfig, writeProviderConfig } from "./providerConfigStore";

describe("providerConfigStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-provider-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns a mock default when the provider config is missing", async () => {
    await expect(readProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "mock",
      model: "mock-faithful-markdown",
      apiKey: "",
      apiKeyEnvVar: "OPENAI_API_KEY",
      baseUrl: "",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "configured"
    });
  });

  it("persists an OpenAI vision provider config with its preset endpoint", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "MATHNOTES_TEST_OPENAI_API_KEY_DOES_NOT_EXIST",
        baseUrl: "",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: ""
      }
    });

    await expect(readProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "openai_vision",
      model: "gpt-4.1-mini",
      apiKey: "",
      apiKeyEnvVar: "MATHNOTES_TEST_OPENAI_API_KEY_DOES_NOT_EXIST",
      baseUrl: "https://api.openai.com/v1",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "missing_api_key"
    });
  });

  it("persists a direct API key for user-friendly provider setup", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKey: "mimo_direct_key",
        apiKeyEnvVar: "MIMO_API_KEY",
        baseUrl: "https://api.xiaomimimo.com/v1",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: ""
      }
    });

    await expect(readProviderConfig({ rootDir })).resolves.toMatchObject({
      providerId: "mimo_2_5",
      model: "mimo-v2.5",
      apiKey: "mimo_direct_key",
      apiKeyEnvVar: "MIMO_API_KEY",
      baseUrl: "https://api.xiaomimimo.com/v1",
      status: "configured"
    });
  });

  it("normalizes GLM and MiMo recognition defaults", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "glm_5_2",
        model: "",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: ""
      }
    });

    await expect(readProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "glm_5_2",
      model: "glm-5.2",
      apiKey: "",
      apiKeyEnvVar: "ZAI_API_KEY",
      baseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "missing_api_key"
    });

    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "",
        codexRuntime: "windows",
        wslDistro: ""
      }
    });

    await expect(readProviderConfig({ rootDir })).resolves.toMatchObject({
      providerId: "mimo_2_5",
      model: "mimo-v2.5",
      apiKeyEnvVar: "MIMO_API_KEY",
      baseUrl: "https://api.xiaomimimo.com/v1"
    });
  });

  it("applies the official DeepSeek defaults only to assistant profiles", () => {
    expect(() => normalizeProviderConfig({ providerId: "deepseek" }, "recognition")).toThrow(/DeepSeek/);
    expect(normalizeProviderConfig({ providerId: "deepseek" }, "assistant")).toEqual({
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "",
      apiKeyEnvVar: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "missing_api_key"
    });
  });

  it("rejects a hand-written DeepSeek recognition file without leaking the key", async () => {
    await mkdir(join(rootDir, "settings"), { recursive: true });
    await writeFile(
      join(rootDir, "settings", "provider.json"),
      JSON.stringify({
        providerId: "deepseek",
        model: "deepseek-v4-flash",
        apiKey: "never-echo-this-secret",
        apiKeyEnvVar: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com"
      }),
      "utf8"
    );

    await expect(readProviderConfig({ rootDir })).rejects.toThrow(/DeepSeek 只可用于对话模型/);
    expect(() =>
      normalizeProviderConfig(
        { providerId: "deepseek", model: "deepseek-v4-flash", apiKey: "never-echo-this-secret", apiKeyEnvVar: "DEEPSEEK_API_KEY" },
        "recognition"
      )
    ).toThrowError(/DeepSeek/);
  });

  it("normalizes Gemini and Qwen built-in recognition defaults", () => {
    expect(normalizeProviderConfig({ providerId: "gemini" }, "recognition")).toEqual({
      providerId: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "",
      apiKeyEnvVar: "GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "missing_api_key"
    });

    expect(normalizeProviderConfig({ providerId: "qwen" }, "recognition")).toEqual({
      providerId: "qwen",
      model: "qwen3.7-plus",
      apiKey: "",
      apiKeyEnvVar: "DASHSCOPE_API_KEY",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "missing_api_key"
    });
  });

  it("requires an endpoint for the custom OpenAI-compatible preset", () => {
    expect(() =>
      normalizeProviderConfig(
        { providerId: "custom_openai_compatible", model: "custom-model", apiKeyEnvVar: "CUSTOM_API_KEY" },
        "recognition"
      )
    ).toThrow(/自定义 OpenAI 兼容服务必须填写请求地址/);
    expect(
      normalizeProviderConfig(
        {
          providerId: "custom_openai_compatible",
          model: "custom-model",
          apiKeyEnvVar: "CUSTOM_API_KEY",
          baseUrl: "https://custom.example/v1"
        },
        "recognition"
      )
    ).toMatchObject({
      providerId: "custom_openai_compatible",
      baseUrl: "https://custom.example/v1"
    });
  });

  it("preserves Codex CLI advanced runtime defaults", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "codex_cli",
        model: "",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "",
        codexRuntime: "wsl",
        wslDistro: ""
      }
    });

    await expect(readProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "codex_cli",
      model: "",
      apiKey: "",
      apiKeyEnvVar: "OPENAI_API_KEY",
      baseUrl: "",
      commandPath: "codex",
      codexRuntime: "wsl",
      wslDistro: "",
      status: "configured"
    });
  });

  it("falls back to the default when config JSON is invalid", async () => {
    await mkdir(join(rootDir, "settings"), { recursive: true });
    await writeFile(join(rootDir, "settings/provider.json"), "{not json", "utf8");

    await expect(readProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "mock",
      model: "mock-faithful-markdown",
      apiKey: "",
      apiKeyEnvVar: "OPENAI_API_KEY",
      baseUrl: "",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "configured"
    });
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAssistantProviderConfig } from "./assistantProviderConfigStore";
import { writeProviderConfig } from "./providerConfigStore";
import { OpenAICompatibleVisionProvider } from "./openAiCompatibleVisionProvider";
import { createAssistantProviderFromConfig, createRecognitionProviderFromConfig } from "./recognitionProviderFactory";

describe("createRecognitionProviderFromConfig", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-provider-factory-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns the mock provider when no config exists", async () => {
    const provider = await createRecognitionProviderFromConfig({ rootDir, env: {} });

    expect(provider.name).toBe("mock");
  });

  it("never produces fake transcription when a packaged runtime disables mock", async () => {
    const provider = await createRecognitionProviderFromConfig({ rootDir, env: {}, allowMockProvider: false });

    expect(provider.name).toBe("unconfigured");
    await expect(provider.transcribe({
      imagePaths: ["board.jpg"],
      mode: "faithful",
      outputFormat: "markdown"
    })).rejects.toThrow("尚未配置真实识别服务");
  });

  it("returns the OpenAI vision provider when the configured env var exists", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "MATHNOTES_OPENAI_TEST_KEY"
      }
    });

    const provider = await createRecognitionProviderFromConfig({
      rootDir,
      env: {
        MATHNOTES_OPENAI_TEST_KEY: "test_key"
      },
      fetchImpl: async () => new Response(JSON.stringify({ output_text: "ok" }), { status: 200 })
    });

    expect(provider.name).toBe("openai_vision");
  });

  it("throws a clear error when OpenAI is selected without an API key env var", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "MATHNOTES_OPENAI_TEST_KEY"
      }
    });

    await expect(createRecognitionProviderFromConfig({ rootDir, env: {} })).rejects.toThrow(
      /Missing API key.*MATHNOTES_OPENAI_TEST_KEY/
    );
  });

  it("prefers a direct API key over environment variables", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKey: "direct_mimo_key",
        apiKeyEnvVar: "MATHNOTES_MIMO_TEST_KEY",
        baseUrl: "https://example.test/v1",
        commandPath: ""
      }
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];

    const provider = await createRecognitionProviderFromConfig({
      rootDir,
      env: {},
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }
    });

    await provider.transcribe({
      imagePaths: [],
      mode: "faithful",
      outputFormat: "markdown"
    });

    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0].init.headers).toEqual(expect.objectContaining({ "api-key": "direct_mimo_key" }));
  });

  it("returns GLM, MiMo, Gemini, Qwen, and custom providers through the OpenAI-compatible adapter", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "glm_5_2",
        model: "glm-5.2",
        apiKeyEnvVar: "MATHNOTES_ZAI_TEST_KEY",
        baseUrl: "https://example.test/glm/chat/completions",
        commandPath: ""
      }
    });

    const glmProvider = await createRecognitionProviderFromConfig({
      rootDir,
      env: { MATHNOTES_ZAI_TEST_KEY: "glm_key" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });
    expect(glmProvider.name).toBe("glm_5_2");

    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKeyEnvVar: "MATHNOTES_MIMO_TEST_KEY",
        baseUrl: "https://example.test/mimo/chat/completions",
        commandPath: ""
      }
    });

    const mimoProvider = await createRecognitionProviderFromConfig({
      rootDir,
      env: { MATHNOTES_MIMO_TEST_KEY: "mimo_key" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });
    expect(mimoProvider.name).toBe("mimo_2_5");

    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "gemini",
        model: "gemini-2.5-flash",
        apiKeyEnvVar: "MATHNOTES_GEMINI_TEST_KEY",
        baseUrl: "https://example.test/gemini/chat/completions",
        commandPath: ""
      }
    });

    const geminiProvider = await createRecognitionProviderFromConfig({
      rootDir,
      env: { MATHNOTES_GEMINI_TEST_KEY: "gemini_key" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });
    expect(geminiProvider.name).toBe("gemini");

    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "qwen",
        model: "qwen3.7-plus",
        apiKeyEnvVar: "MATHNOTES_QWEN_TEST_KEY",
        baseUrl: "https://example.test/qwen/chat/completions",
        commandPath: ""
      }
    });

    const qwenProvider = await createRecognitionProviderFromConfig({
      rootDir,
      env: { MATHNOTES_QWEN_TEST_KEY: "qwen_key" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });
    expect(qwenProvider.name).toBe("qwen");

    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "custom_openai_compatible",
        model: "custom-model",
        apiKeyEnvVar: "MATHNOTES_CUSTOM_TEST_KEY",
        baseUrl: "https://example.test/custom/chat/completions",
        commandPath: ""
      }
    });

    const customProvider = await createRecognitionProviderFromConfig({
      rootDir,
      env: { MATHNOTES_CUSTOM_TEST_KEY: "custom_key" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });
    expect(customProvider.name).toBe("custom_openai_compatible");
  });

  it("returns a Codex CLI provider without requiring an API key", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "codex_cli",
        model: "",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "codex",
        codexRuntime: "wsl",
        wslDistro: "Ubuntu"
      }
    });

    const provider = await createRecognitionProviderFromConfig({ rootDir, env: {} });

    expect(provider.name).toBe("codex_cli");
  });

  it("returns a Codex app-server provider when a ready runtime endpoint is available", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "codex_cli",
        model: "gpt-5.5",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "codex",
        codexRuntime: "wsl",
        wslDistro: "Ubuntu"
      }
    });

    const provider = await createRecognitionProviderFromConfig({
      rootDir,
      env: {},
      codexRuntimeEndpoint: "ws://127.0.0.1:45519"
    });

    expect(provider.name).toBe("codex_app_server");
  });
});

describe("createAssistantProviderFromConfig", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-assistant-factory-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("inherits the recognition profile until an explicit dialogue profile exists", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKeyEnvVar: "MATHNOTES_MIMO_TEST_KEY",
        baseUrl: "https://example.test/mimo/v1",
        commandPath: ""
      }
    });

    const provider = await createAssistantProviderFromConfig({
      rootDir,
      env: { MATHNOTES_MIMO_TEST_KEY: "inherited-key" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });

    expect(provider.name).toBe("mimo_2_5");
    await expect(readFile(join(rootDir, "settings", "assistant-provider.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("uses the explicit dialogue profile while recognition stays unchanged", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "MATHNOTES_OPENAI_TEST_KEY"
      }
    });
    await writeAssistantProviderConfig({
      rootDir,
      config: {
        providerId: "deepseek",
        model: "deepseek-chat",
        apiKeyEnvVar: "MATHNOTES_DEEPSEEK_TEST_KEY",
        baseUrl: "https://example.test/deepseek/chat/completions",
        commandPath: ""
      }
    });

    const assistant = await createAssistantProviderFromConfig({
      rootDir,
      env: { MATHNOTES_DEEPSEEK_TEST_KEY: "dialogue-key" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });
    const recognition = await createRecognitionProviderFromConfig({
      rootDir,
      env: { MATHNOTES_OPENAI_TEST_KEY: "recognition-key" },
      fetchImpl: async () => new Response(JSON.stringify({ output_text: "ok" }), { status: 200 })
    });

    expect(assistant.name).toBe("deepseek");
    expect(recognition.name).toBe("openai_vision");
  });

  it("routes OpenAI dialogue through the OpenAI-compatible assistant adapter", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "MATHNOTES_OPENAI_RECOGNITION_TEST_KEY"
      }
    });
    await writeAssistantProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "MATHNOTES_OPENAI_DIALOGUE_TEST_KEY",
        baseUrl: "https://api.openai.com/v1",
        commandPath: ""
      }
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];

    const assistant = await createAssistantProviderFromConfig({
      rootDir,
      env: { MATHNOTES_OPENAI_DIALOGUE_TEST_KEY: "dialogue-key" },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "assistant ok" } }] }), { status: 200 });
      }
    });

    expect(assistant).toBeInstanceOf(OpenAICompatibleVisionProvider);
    await assistant.assist({
      mode: "explain",
      markdownContext: "x = 1",
      imagePaths: []
    });
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].init.headers).toEqual(expect.objectContaining({ Authorization: "Bearer dialogue-key" }));
  });

  it("uses the shared Codex app-server endpoint when the dialogue profile is Codex CLI", async () => {
    await writeAssistantProviderConfig({
      rootDir,
      config: {
        providerId: "codex_cli",
        model: "gpt-5.5",
        apiKeyEnvVar: "",
        baseUrl: "",
        commandPath: "codex",
        codexRuntime: "wsl",
        wslDistro: "Ubuntu"
      }
    });

    const provider = await createAssistantProviderFromConfig({
      rootDir,
      env: {},
      codexRuntimeEndpoint: "ws://127.0.0.1:45519"
    });

    expect(provider.name).toBe("codex_app_server");
  });

  it("throws a clear credential error for an explicit dialogue profile without a key", async () => {
    await writeAssistantProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKeyEnvVar: "MATHNOTES_MIMO_TEST_KEY",
        baseUrl: "https://example.test/mimo/v1",
        commandPath: ""
      }
    });

    await expect(createAssistantProviderFromConfig({ rootDir, env: {} })).rejects.toThrow(
      /Missing API key.*MATHNOTES_MIMO_TEST_KEY/
    );
  });
});

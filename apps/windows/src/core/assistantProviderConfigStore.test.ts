import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAssistantProviderConfig, writeAssistantProviderConfig } from "./assistantProviderConfigStore";
import { readProviderConfig, writeProviderConfig } from "./providerConfigStore";

describe("assistantProviderConfigStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-assistant-provider-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("inherits the current recognition profile at read time without writing a dialogue file", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKey: "recognition-secret",
        apiKeyEnvVar: "MIMO_API_KEY",
        baseUrl: "https://api.xiaomimimo.com/v1"
      }
    });

    await expect(readAssistantProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "mimo_2_5",
      model: "mimo-v2.5",
      apiKey: "recognition-secret",
      apiKeyEnvVar: "MIMO_API_KEY",
      baseUrl: "https://api.xiaomimimo.com/v1",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "configured",
      purpose: "assistant",
      inherited: true
    });
    await expect(readFile(join(rootDir, "settings", "assistant-provider.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("picks up recognition changes on later reads while the dialogue file stays absent", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKeyEnvVar: "MIMO_API_KEY"
      }
    });
    await expect(readAssistantProviderConfig({ rootDir })).resolves.toMatchObject({
      providerId: "mimo_2_5",
      inherited: true
    });

    await mkdir(join(rootDir, "settings"), { recursive: true });
    await writeFile(
      join(rootDir, "settings", "provider.json"),
      JSON.stringify({
        providerId: "deepseek",
        model: "deepseek-chat",
        apiKeyEnvVar: "DEEPSEEK_API_KEY"
      }),
      "utf8"
    );
    await expect(readAssistantProviderConfig({ rootDir })).resolves.toMatchObject({
      providerId: "deepseek",
      inherited: true
    });
    await expect(readProviderConfig({ rootDir })).rejects.toThrow(/DeepSeek/);
    await expect(readFile(join(rootDir, "settings", "assistant-provider.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("saves an explicit dialogue profile without mutating the recognition file", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "OPENAI_API_KEY"
      }
    });

    await writeAssistantProviderConfig({
      rootDir,
      config: {
        providerId: "glm_5_2",
        model: "glm-5.2",
        apiKey: "dialogue-secret",
        apiKeyEnvVar: "ZAI_API_KEY",
        baseUrl: "https://example.test/glm/v1"
      }
    });

    await expect(readAssistantProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "glm_5_2",
      model: "glm-5.2",
      apiKey: "dialogue-secret",
      apiKeyEnvVar: "ZAI_API_KEY",
      baseUrl: "https://example.test/glm/v1",
      commandPath: "",
      codexRuntime: "windows",
      wslDistro: "",
      status: "configured",
      purpose: "assistant",
      inherited: false
    });
    await expect(readProviderConfig({ rootDir })).resolves.toMatchObject({
      providerId: "openai_vision",
      apiKey: ""
    });

    const dialogueFile = await readFile(join(rootDir, "settings", "assistant-provider.json"), "utf8");
    expect(dialogueFile).toContain("dialogue-secret");
    expect(dialogueFile).not.toContain("recognition-secret");
    const recognitionFile = await readFile(join(rootDir, "settings", "provider.json"), "utf8");
    expect(recognitionFile).not.toContain("dialogue-secret");
  });

  it("clears only the dialogue file and returns to inherited recognition", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "openai_vision",
        model: "gpt-4.1-mini",
        apiKeyEnvVar: "OPENAI_API_KEY"
      }
    });
    await writeAssistantProviderConfig({
      rootDir,
      config: {
        providerId: "deepseek",
        model: "deepseek-chat",
        apiKey: "dialogue-secret",
        apiKeyEnvVar: "DEEPSEEK_API_KEY",
        baseUrl: "https://example.test/deepseek/chat/completions"
      }
    });

    await expect(
      writeAssistantProviderConfig({
        rootDir,
        config: null
      })
    ).resolves.toMatchObject({
      providerId: "openai_vision",
      inherited: true,
      purpose: "assistant"
    });
    await expect(readFile(join(rootDir, "settings", "assistant-provider.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readProviderConfig({ rootDir })).resolves.toMatchObject({ providerId: "openai_vision" });
  });

  it("falls back to inherited recognition when the dialogue JSON is invalid", async () => {
    await writeProviderConfig({
      rootDir,
      config: {
        providerId: "mimo_2_5",
        model: "mimo-v2.5",
        apiKeyEnvVar: "MIMO_API_KEY"
      }
    });
    await mkdir(join(rootDir, "settings"), { recursive: true });
    await writeFile(join(rootDir, "settings", "assistant-provider.json"), "{not json", "utf8");

    await expect(readAssistantProviderConfig({ rootDir })).resolves.toMatchObject({
      providerId: "mimo_2_5",
      inherited: true
    });
  });

  it("preserves Codex runtime defaults for an explicit dialogue profile", async () => {
    await writeAssistantProviderConfig({
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

    await expect(readAssistantProviderConfig({ rootDir })).resolves.toEqual({
      providerId: "codex_cli",
      model: "",
      apiKey: "",
      apiKeyEnvVar: "OPENAI_API_KEY",
      baseUrl: "",
      commandPath: "codex",
      codexRuntime: "wsl",
      wslDistro: "",
      status: "configured",
      purpose: "assistant",
      inherited: false
    });
  });
});

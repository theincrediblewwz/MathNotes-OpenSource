import { getProviderDescriptor, type ProviderPurpose } from "@mathnotes/shared";
import type { AssistantProvider, RecognitionProvider } from "@mathnotes/shared";
import { CodexAppServerRecognitionProvider } from "./codexAppServerRecognitionProvider";
import { CodexCliRecognitionProvider, type SpawnLike } from "./codexCliRecognitionProvider";
import { MockRecognitionProvider } from "./mockRecognitionProvider";
import { OpenAICompatibleVisionProvider } from "./openAiCompatibleVisionProvider";
import { OpenAIVisionRecognitionProvider } from "./openAiVisionRecognitionProvider";
import { readAssistantProviderConfig } from "./assistantProviderConfigStore";
import { readProviderConfig, type RecognitionProviderConfig } from "./providerConfigStore";
import { getActivePromptTemplate, readPromptTemplateConfig } from "./promptTemplateStore";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CreateRecognitionProviderArgs = {
  rootDir: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  spawnImpl?: SpawnLike;
  codexRuntimeEndpoint?: string;
  allowMockProvider?: boolean;
};

export type CreateAssistantProviderArgs = CreateRecognitionProviderArgs;

export async function createRecognitionProviderFromConfig(args: CreateRecognitionProviderArgs): Promise<RecognitionProvider> {
  const config = await readProviderConfig({ rootDir: args.rootDir });
  return createProviderFromConfig(config, args, "recognition");
}

/**
 * Creates the assistant provider from the effective dialogue profile.
 *
 * Without settings/assistant-provider.json the dialogue profile inherits the
 * recognition profile at read time, so assistant calls keep working until the
 * user explicitly saves a separate dialogue profile.
 */
export async function createAssistantProviderFromConfig(args: CreateAssistantProviderArgs): Promise<AssistantProvider> {
  const config = await readAssistantProviderConfig({ rootDir: args.rootDir });
  const provider = await createProviderFromConfig(config, args, "assistant");
  if (!("assist" in provider) || typeof provider.assist !== "function") {
    throw new Error(`当前识别服务 ${provider.name} 不支持学习助手任务。`);
  }
  return provider as RecognitionProvider & AssistantProvider;
}

async function createProviderFromConfig(
  config: RecognitionProviderConfig,
  args: CreateRecognitionProviderArgs,
  purpose: ProviderPurpose
): Promise<RecognitionProvider> {
  const promptTemplate = getActivePromptTemplate(await readPromptTemplateConfig({ rootDir: args.rootDir }));
  if (config.providerId === "mock") {
    if (args.allowMockProvider === false) {
      return {
        name: "unconfigured",
        async transcribe() {
          throw new Error("尚未配置真实识别服务。请先在设置中选择并检查识别服务。");
        }
      };
    }
    return new MockRecognitionProvider();
  }

  if (config.providerId === "codex_cli") {
    if (args.codexRuntimeEndpoint) {
      return new CodexAppServerRecognitionProvider({
        endpoint: args.codexRuntimeEndpoint,
        cwd: args.rootDir,
        runtime: config.codexRuntime,
        model: config.model,
        promptTemplateContent: promptTemplate.content
      });
    }

    return new CodexCliRecognitionProvider({
      commandPath: config.commandPath ?? "codex",
      runtime: config.codexRuntime,
      wslDistro: config.wslDistro,
      model: config.model,
      promptTemplateContent: promptTemplate.content,
      spawnImpl: args.spawnImpl
    });
  }

  const env = args.env ?? process.env;
  const apiKey = config.apiKey?.trim() || env[config.apiKeyEnvVar];
  if (!apiKey) {
    throw new Error(`Missing API key. Fill API 密钥 in settings or set environment variable ${config.apiKeyEnvVar}`);
  }

  if (config.providerId === "openai_vision" && purpose === "assistant") {
    return new OpenAICompatibleVisionProvider({
      name: config.providerId,
      apiKey,
      baseUrl: config.baseUrl || "https://api.openai.com/v1",
      model: config.model,
      promptTemplateContent: promptTemplate.content,
      fetchImpl: args.fetchImpl
    });
  }

  if (config.providerId === "deepseek" && purpose === "recognition") {
    throw new Error("DeepSeek 只可用于对话模型，不能用于识别服务。");
  }

  const descriptor = getProviderDescriptor(config.providerId);
  if (descriptor?.adapter === "openai_compatible") {
    return new OpenAICompatibleVisionProvider({
      name: config.providerId,
      apiKey,
      baseUrl: config.baseUrl ?? "",
      model: config.model,
      promptTemplateContent: promptTemplate.content,
      fetchImpl: args.fetchImpl
    });
  }

  return new OpenAIVisionRecognitionProvider({
    apiKey,
    model: config.model,
    promptTemplateContent: promptTemplate.content,
    fetchImpl: args.fetchImpl
  });
}

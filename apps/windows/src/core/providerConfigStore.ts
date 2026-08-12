import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getProviderDescriptor,
  isProviderAllowedForPurpose,
  type ProviderId,
  type ProviderPurpose
} from "@mathnotes/shared";

export type RecognitionProviderId = ProviderId;

export type RecognitionProviderConfigInput = {
  providerId: RecognitionProviderId;
  model: string;
  apiKey?: string;
  apiKeyEnvVar: string;
  baseUrl?: string;
  commandPath?: string;
  codexRuntime?: "windows" | "wsl";
  wslDistro?: string;
};

export type RecognitionProviderConfig = RecognitionProviderConfigInput & {
  status: "configured" | "missing_api_key";
};

export type ProviderConfigStoreArgs = {
  rootDir: string;
};

export type WriteProviderConfigArgs = ProviderConfigStoreArgs & {
  config: RecognitionProviderConfigInput;
};

export type ReadProviderConfigForPurposeArgs = ProviderConfigStoreArgs & {
  purpose: ProviderPurpose;
};

export class ProviderConfigError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

const defaultConfig: RecognitionProviderConfigInput = {
  providerId: "mock",
  model: "mock-faithful-markdown",
  apiKey: "",
  apiKeyEnvVar: "OPENAI_API_KEY"
};

const defaultCodexWslCommandPath = "codex";
const defaultCodexWslDistro = "";

export async function readProviderConfig(args: ProviderConfigStoreArgs): Promise<RecognitionProviderConfig> {
  return readProviderConfigForPurpose({ ...args, purpose: "recognition" });
}

/**
 * Reads and normalizes a provider file for a specific purpose.
 *
 * Recognition rejects DeepSeek (including hand-written files). Assistant reads
 * the same recognition file only as an inheritance source and permits DeepSeek,
 * so legacy recognition records remain usable as dialogue until an explicit
 * dialogue profile is saved.
 */
export async function readProviderConfigForPurpose(
  args: ReadProviderConfigForPurposeArgs
): Promise<RecognitionProviderConfig> {
  try {
    const stored = JSON.parse(await readFile(providerConfigPath(args.rootDir), "utf8")) as Partial<RecognitionProviderConfigInput>;
    return normalizeProviderConfig(stored, args.purpose);
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) {
      return normalizeProviderConfig(defaultConfig, args.purpose);
    }

    throw error;
  }
}

export async function writeProviderConfig(args: WriteProviderConfigArgs): Promise<RecognitionProviderConfig> {
  const normalized = normalizeProviderConfig(args.config, "recognition");
  const target = providerConfigPath(args.rootDir);
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    tmp,
    `${JSON.stringify(
      {
        providerId: normalized.providerId,
        model: normalized.model,
        apiKey: normalized.apiKey,
        apiKeyEnvVar: normalized.apiKeyEnvVar,
        baseUrl: normalized.baseUrl,
        commandPath: normalized.commandPath,
        codexRuntime: normalized.codexRuntime,
        wslDistro: normalized.wslDistro
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await rename(tmp, target);
  return normalized;
}

export function normalizeProviderConfig(
  config: Partial<RecognitionProviderConfigInput>,
  purpose: ProviderPurpose = "recognition"
): RecognitionProviderConfig {
  const providerId = normalizeProviderId(config.providerId, purpose);
  const descriptor = getProviderDescriptor(providerId);
  if (!descriptor) {
    throw new ProviderConfigError("unsupported_provider", "不支持的 Provider。");
  }

  const model = config.model?.trim() || descriptor.defaultModel;
  const apiKey = config.apiKey?.trim() ?? "";
  const apiKeyEnvVar = config.apiKeyEnvVar?.trim() || descriptor.defaultApiKeyEnvVar;
  const baseUrl = config.baseUrl?.trim() || descriptor.defaultBaseUrl;
  if (descriptor.requiresEndpoint && !baseUrl) {
    throw new ProviderConfigError("invalid_provider_endpoint", "自定义 OpenAI 兼容服务必须填写请求地址。");
  }

  const codexRuntime = config.codexRuntime === "wsl" ? "wsl" : "windows";
  const commandPath = config.commandPath?.trim() || defaultCommandPathForProvider(providerId, codexRuntime);
  const wslDistro = config.wslDistro?.trim() || defaultWslDistroForProvider(providerId, codexRuntime);
  return {
    providerId,
    model,
    apiKey,
    apiKeyEnvVar,
    baseUrl,
    commandPath,
    codexRuntime,
    wslDistro,
    status: descriptor.requiresApiKey && !apiKey && !process.env[apiKeyEnvVar] ? "missing_api_key" : "configured"
  };
}

function normalizeProviderId(providerId?: string, purpose: ProviderPurpose = "recognition"): RecognitionProviderId {
  if (!providerId) return "mock";
  const descriptor = getProviderDescriptor(providerId);
  if (!descriptor) return "mock";
  if (!isProviderAllowedForPurpose(descriptor.providerId, purpose)) {
    if (descriptor.providerId === "deepseek" && purpose === "recognition") {
      throw new ProviderConfigError(
        "unsupported_provider",
        "DeepSeek 只可用于对话模型，不能用于识别服务。"
      );
    }
    return "mock";
  }
  return descriptor.providerId;
}

function defaultCommandPathForProvider(providerId: RecognitionProviderId, codexRuntime: "windows" | "wsl"): string {
  if (providerId !== "codex_cli") return "";
  return codexRuntime === "wsl" ? defaultCodexWslCommandPath : "codex";
}

function defaultWslDistroForProvider(providerId: RecognitionProviderId, codexRuntime: "windows" | "wsl"): string {
  return providerId === "codex_cli" && codexRuntime === "wsl" ? defaultCodexWslDistro : "";
}

function providerConfigPath(rootDir: string): string {
  return join(rootDir, "settings", "provider.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

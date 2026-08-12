import {
  getProviderDescriptor,
  isProviderAllowedForPurpose,
  type AssistantProvider,
  type ProviderId,
  type ProviderPurpose,
  type RecognitionProvider
} from "@mathnotes/shared";
import { OpenAICompatibleVisionProvider } from "./openAiCompatibleVisionProvider";
import {
  ProviderConnectionProbe,
  type ProviderConnectionTestResult,
  type ProviderProbeFetch
} from "./providerConnectionProbe";
import type { AiGuidanceSettingsService } from "./aiGuidanceSettingsService";

export type RuntimeProviderId = Exclude<ProviderId, "mock" | "codex_cli">;
export type RuntimeProviderPurpose = ProviderPurpose;

export type RuntimeProviderConfiguration = Readonly<{
  providerId: RuntimeProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
}>;

export type RuntimeProviderStatus = Readonly<{
  version: 1;
  configured: boolean;
  providerId?: RuntimeProviderId;
  label?: string;
  model?: string;
  endpoint?: string;
  purpose?: RuntimeProviderPurpose;
  inherited?: boolean;
}>;

export class RuntimeProviderConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class RuntimeProviderRegistry {
  private readonly configurations = new Map<RuntimeProviderPurpose, RuntimeProviderConfiguration>();
  private readonly providers = new Map<RuntimeProviderPurpose, OpenAICompatibleVisionProvider>();
  private readonly probe: ProviderConnectionProbe;

  constructor(fetchImpl?: ProviderProbeFetch, private readonly guidance?: AiGuidanceSettingsService) {
    this.probe = new ProviderConnectionProbe(fetchImpl);
  }

  async testConnection(purpose: RuntimeProviderPurpose = "recognition"): Promise<ProviderConnectionTestResult> {
    const configuration = this.resolvedConfiguration(purpose);
    if (!configuration) throw new RuntimeProviderConfigurationError("provider_unavailable");
    return this.probe.test(configuration, purpose);
  }

  configure(input: RuntimeProviderConfiguration, purpose: RuntimeProviderPurpose = "recognition"): RuntimeProviderStatus {
    const descriptor = getProviderDescriptor(input.providerId);
    if (
      !descriptor ||
      !isRuntimeProviderId(descriptor.providerId) ||
      !isProviderAllowedForPurpose(descriptor.providerId, purpose)
    ) {
      throw new RuntimeProviderConfigurationError("unsupported_provider");
    }
    const baseUrl = input.baseUrl.trim() || descriptor.defaultBaseUrl;
    if (descriptor.requiresEndpoint && !baseUrl) {
      throw new RuntimeProviderConfigurationError("invalid_provider_endpoint");
    }
    const configuration = Object.freeze({
      providerId: descriptor.providerId,
      model: validateText(input.model, "invalid_provider_model", 200),
      baseUrl: validateBaseUrl(baseUrl),
      apiKey: validateText(input.apiKey, "invalid_provider_api_key", 4096)
    });
    this.configurations.set(purpose, configuration);
    this.providers.delete(purpose);
    // Prewarm means constructing and caching the local adapter only. It never
    // sends a billable request; explicit connection testing remains separate.
    this.createProvider(purpose);
    return this.status(purpose);
  }

  clear(purpose: RuntimeProviderPurpose = "recognition"): RuntimeProviderStatus {
    this.configurations.delete(purpose);
    this.providers.delete(purpose);
    return this.status(purpose);
  }

  status(purpose: RuntimeProviderPurpose = "recognition"): RuntimeProviderStatus {
    const ownConfiguration = this.configurations.get(purpose);
    const inherited = purpose === "assistant" && !ownConfiguration;
    const configuration = ownConfiguration ?? (inherited ? this.configurations.get("recognition") : undefined);
    if (!configuration) {
      return purpose === "assistant"
        ? { version: 1, configured: false, purpose, inherited }
        : { version: 1, configured: false };
    }
    const status: RuntimeProviderStatus = {
      version: 1,
      configured: true,
      providerId: configuration.providerId,
      label: providerLabel(configuration.providerId),
      model: configuration.model,
      endpoint: configuration.baseUrl
    };
    return purpose === "assistant" ? { ...status, purpose, inherited } : status;
  }

  async createRecognitionProvider(): Promise<RecognitionProvider> {
    return this.createProvider("recognition");
  }

  async createAssistantProvider(): Promise<AssistantProvider> {
    return this.createProvider("assistant");
  }

  private createProvider(purpose: RuntimeProviderPurpose): OpenAICompatibleVisionProvider {
    const resolvedPurpose = purpose === "assistant" && !this.configurations.has("assistant") ? "recognition" : purpose;
    const configuration = this.configurations.get(resolvedPurpose);
    if (!configuration) throw new RuntimeProviderConfigurationError("provider_unavailable");
    let provider = this.providers.get(resolvedPurpose);
    provider ??= new OpenAICompatibleVisionProvider({
      name: configuration.providerId,
      model: configuration.model,
      baseUrl: configuration.baseUrl,
      apiKey: configuration.apiKey,
      promptTemplateContentProvider: this.guidance ? () => this.guidance!.activePromptTemplateContent() : undefined,
      notationGuidanceProvider: this.guidance
        ? (context) => this.guidance!.notationSelection(context).promptFragment
        : undefined
    });
    this.providers.set(resolvedPurpose, provider);
    return provider;
  }

  private resolvedConfiguration(purpose: RuntimeProviderPurpose): RuntimeProviderConfiguration | undefined {
    const resolvedPurpose = purpose === "assistant" && !this.configurations.has("assistant") ? "recognition" : purpose;
    return this.configurations.get(resolvedPurpose);
  }
}

export function normalizeRuntimeProviderPurpose(value: string | null | undefined): RuntimeProviderPurpose {
  return value === "assistant" ? "assistant" : "recognition";
}

function isRuntimeProviderId(value: ProviderId): value is RuntimeProviderId {
  return value !== "mock" && value !== "codex_cli";
}

function validateText(value: string, code: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new RuntimeProviderConfigurationError(code);
  return trimmed;
}

function validateBaseUrl(value: string): string {
  const text = validateText(value, "invalid_provider_endpoint", 2048).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RuntimeProviderConfigurationError("invalid_provider_endpoint");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RuntimeProviderConfigurationError("invalid_provider_endpoint");
  }
  return url.toString().replace(/\/+$/, "");
}

function providerLabel(providerId: RuntimeProviderId): string {
  return getProviderDescriptor(providerId)?.label ?? providerId;
}

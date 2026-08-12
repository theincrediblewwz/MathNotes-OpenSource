export type ProviderId =
  | "mock"
  | "openai_vision"
  | "glm_5_2"
  | "mimo_2_5"
  | "deepseek"
  | "gemini"
  | "qwen"
  | "custom_openai_compatible"
  | "codex_cli";

export type ProviderPurpose = "recognition" | "assistant";

export type ProviderAdapterKind = "mock" | "openai_responses" | "openai_compatible" | "codex_cli";

export type ProviderAuthScheme = "api-key" | "bearer" | "none";

export type ProviderRuntimeLogKind = "process" | "api" | "none";

export type ProviderRetryPolicy = "manual";

export type ProviderDescriptor = Readonly<{
  providerId: ProviderId;
  /** Stable wire ID. Mirrors the Swift ProviderPreset raw-value contract. */
  wireId: string;
  label: string;
  adapter: ProviderAdapterKind;
  defaultModel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  authScheme: ProviderAuthScheme;
  allowedPurposes: readonly ProviderPurpose[];
  requiresEndpoint: boolean;
  requiresApiKey: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsHealthCheck: boolean;
  requiresLocalRuntime: boolean;
  runtimeLogKind: ProviderRuntimeLogKind;
  retryPolicy: ProviderRetryPolicy;
}>;

export const PROVIDER_CATALOG: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  mock: {
    providerId: "mock",
    wireId: "mock",
    label: "假识别服务（验证管线）",
    adapter: "mock",
    defaultModel: "mock-faithful-markdown",
    defaultBaseUrl: "",
    defaultApiKeyEnvVar: "OPENAI_API_KEY",
    authScheme: "none",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: false,
    requiresApiKey: false,
    supportsVision: false,
    supportsStreaming: false,
    supportsHealthCheck: false,
    requiresLocalRuntime: false,
    runtimeLogKind: "none",
    retryPolicy: "manual"
  },
  openai_vision: {
    providerId: "openai_vision",
    wireId: "openai_vision",
    label: "OpenAI Vision",
    adapter: "openai_responses",
    defaultModel: "gpt-4.1-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultApiKeyEnvVar: "OPENAI_API_KEY",
    authScheme: "bearer",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: false,
    requiresApiKey: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: false,
    runtimeLogKind: "api",
    retryPolicy: "manual"
  },
  glm_5_2: {
    providerId: "glm_5_2",
    wireId: "glm_5_2",
    label: "GLM 5.2",
    adapter: "openai_compatible",
    defaultModel: "glm-5.2",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    defaultApiKeyEnvVar: "ZAI_API_KEY",
    authScheme: "bearer",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: false,
    requiresApiKey: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: false,
    runtimeLogKind: "api",
    retryPolicy: "manual"
  },
  mimo_2_5: {
    providerId: "mimo_2_5",
    wireId: "mimo_2_5",
    label: "Mimo v2.5",
    adapter: "openai_compatible",
    defaultModel: "mimo-v2.5",
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    defaultApiKeyEnvVar: "MIMO_API_KEY",
    authScheme: "api-key",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: false,
    requiresApiKey: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: false,
    runtimeLogKind: "api",
    retryPolicy: "manual"
  },
  deepseek: {
    providerId: "deepseek",
    wireId: "deepseek",
    label: "DeepSeek Compatible",
    adapter: "openai_compatible",
    defaultModel: "deepseek-v4-flash",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultApiKeyEnvVar: "DEEPSEEK_API_KEY",
    authScheme: "bearer",
    allowedPurposes: ["assistant"],
    requiresEndpoint: false,
    requiresApiKey: true,
    supportsVision: false,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: false,
    runtimeLogKind: "api",
    retryPolicy: "manual"
  },
  gemini: {
    providerId: "gemini",
    wireId: "gemini",
    label: "Gemini",
    adapter: "openai_compatible",
    defaultModel: "gemini-2.5-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultApiKeyEnvVar: "GEMINI_API_KEY",
    authScheme: "bearer",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: false,
    requiresApiKey: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: false,
    runtimeLogKind: "api",
    retryPolicy: "manual"
  },
  qwen: {
    providerId: "qwen",
    wireId: "qwen",
    label: "Qwen",
    adapter: "openai_compatible",
    defaultModel: "qwen3.7-plus",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultApiKeyEnvVar: "DASHSCOPE_API_KEY",
    authScheme: "bearer",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: false,
    requiresApiKey: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: false,
    runtimeLogKind: "api",
    retryPolicy: "manual"
  },
  custom_openai_compatible: {
    providerId: "custom_openai_compatible",
    wireId: "custom_openai_compatible",
    label: "Custom OpenAI Compatible",
    adapter: "openai_compatible",
    defaultModel: "",
    defaultBaseUrl: "",
    defaultApiKeyEnvVar: "OPENAI_API_KEY",
    authScheme: "bearer",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: true,
    requiresApiKey: true,
    supportsVision: true,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: false,
    runtimeLogKind: "api",
    retryPolicy: "manual"
  },
  codex_cli: {
    providerId: "codex_cli",
    wireId: "codex_cli",
    label: "Codex CLI",
    adapter: "codex_cli",
    defaultModel: "",
    defaultBaseUrl: "",
    defaultApiKeyEnvVar: "OPENAI_API_KEY",
    authScheme: "none",
    allowedPurposes: ["recognition", "assistant"],
    requiresEndpoint: false,
    requiresApiKey: false,
    supportsVision: true,
    supportsStreaming: true,
    supportsHealthCheck: true,
    requiresLocalRuntime: true,
    runtimeLogKind: "process",
    retryPolicy: "manual"
  }
};

export function getProviderDescriptor(providerId: string): ProviderDescriptor | undefined {
  return Object.hasOwn(PROVIDER_CATALOG, providerId) ? PROVIDER_CATALOG[providerId as ProviderId] : undefined;
}

export function isProviderAllowedForPurpose(providerId: ProviderId, purpose: ProviderPurpose): boolean {
  const descriptor = PROVIDER_CATALOG[providerId];
  return descriptor?.allowedPurposes.includes(purpose) ?? false;
}

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_CATALOG, value);
}

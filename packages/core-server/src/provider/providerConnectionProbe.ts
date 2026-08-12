import { buildCompatibleProviderHeaders, chatCompletionsUrl } from "./openAiCompatibleVisionProvider";
import type { RuntimeProviderConfiguration, RuntimeProviderPurpose } from "./runtimeProviderRegistry";

export type ProviderConnectionTestCategory =
  | "authentication"
  | "endpoint_model"
  | "rate_limit"
  | "timeout"
  | "provider_response";

export type ProviderConnectionTestResult = Readonly<{
  version: 1;
  purpose: RuntimeProviderPurpose;
  ok: boolean;
  category?: ProviderConnectionTestCategory;
  message: string;
}>;

export type ProviderProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

const PROVIDER_TEST_TIMEOUT_MS = 10_000;
const PROVIDER_TEST_MAX_TOKENS = 1;

export class ProviderConnectionProbe {
  private readonly fetchImpl: ProviderProbeFetch;

  constructor(fetchImpl: ProviderProbeFetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async test(
    configuration: RuntimeProviderConfiguration,
    purpose: RuntimeProviderPurpose
  ): Promise<ProviderConnectionTestResult> {
    const endpoint = chatCompletionsUrl(configuration.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: buildCompatibleProviderHeaders(configuration.providerId, configuration.apiKey),
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: configuration.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: PROVIDER_TEST_MAX_TOKENS,
          stream: false
        })
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return failure(purpose, "timeout", "连接 Provider 超时，请稍后重试。");
      }
      return failure(purpose, "provider_response", "无法连接 Provider，请检查请求地址和网络。");
    }
    if (response.ok) {
      return { version: 1, purpose, ok: true, message: "Provider 连通正常。" };
    }
    const category = failureCategory(response.status);
    return failure(purpose, category, messageForCategory(category));
  }
}

function failure(
  purpose: RuntimeProviderPurpose,
  category: ProviderConnectionTestCategory,
  message: string
): ProviderConnectionTestResult {
  return { version: 1, purpose, ok: false, category, message };
}

function failureCategory(status: number): ProviderConnectionTestCategory {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if ([400, 404, 405, 406, 415, 416, 422].includes(status)) return "endpoint_model";
  return "provider_response";
}

function messageForCategory(category: ProviderConnectionTestCategory): string {
  switch (category) {
    case "authentication": return "Provider 拒绝了请求：认证失败，请检查 API 密钥。";
    case "endpoint_model": return "Provider 无法处理请求：请检查请求地址或模型名称。";
    case "rate_limit": return "Provider 请求频率受限，请稍后重试。";
    case "timeout": return "连接 Provider 超时，请稍后重试。";
    case "provider_response": return "Provider 返回异常响应，请检查服务状态。";
  }
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "name" in error
    && (error as { name?: unknown }).name === "TimeoutError";
}

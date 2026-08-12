import type { CodexRuntimeState, ProviderRuntimeState, RecognitionProviderId } from "../types/mathNotesApi";
import { getRecognitionProviderCapability } from "./providerCapabilities";

export function providerRuntimeStateForProvider(
  providerId: RecognitionProviderId | null | undefined,
  codexRuntimeState: CodexRuntimeState
): ProviderRuntimeState | undefined {
  const resolvedProviderId = providerId ?? "mock";
  if (resolvedProviderId !== "codex_cli") {
    return undefined;
  }

  return {
    ...codexRuntimeState,
    providerId: resolvedProviderId
  };
}

export function providerRuntimeSummaryTitle(state: ProviderRuntimeState): string {
  if (state.providerId === "codex_cli") {
    switch (state.status) {
      case "ready":
        return "Codex CLI 启动成功";
      case "starting":
        return `Codex CLI 正在启动 ${state.progress}%`;
      case "error":
        return "Codex CLI 启动失败";
      case "stopped":
        return "Codex CLI 未启动";
    }
  }

  switch (state.status) {
    case "ready":
      return `${providerRuntimeLabel(state.providerId)} API 已就绪`;
    case "starting":
      return `${providerRuntimeLabel(state.providerId)} API 检查中 ${state.progress}%`;
    case "error":
      return `${providerRuntimeLabel(state.providerId)} API 不可用`;
    case "stopped":
      return `${providerRuntimeLabel(state.providerId)} API 未检查`;
  }
}

export function providerRuntimeProgressTitle(state: ProviderRuntimeState): string {
  if (state.providerId === "codex_cli") {
    switch (state.status) {
      case "ready":
        return "Codex CLI 已就绪";
      case "starting":
        return "Codex CLI 正在准备";
      case "error":
        return "Codex CLI 启动失败";
      case "stopped":
        return "Codex CLI 未启动";
    }
  }

  switch (state.status) {
    case "ready":
      return `${providerRuntimeLabel(state.providerId)} API 已就绪`;
    case "starting":
      return `${providerRuntimeLabel(state.providerId)} API 正在检查`;
    case "error":
      return `${providerRuntimeLabel(state.providerId)} API 不可用`;
    case "stopped":
      return `${providerRuntimeLabel(state.providerId)} API 未检查`;
  }
}

function providerRuntimeLabel(providerId: RecognitionProviderId): string {
  return getRecognitionProviderCapability(providerId).label;
}

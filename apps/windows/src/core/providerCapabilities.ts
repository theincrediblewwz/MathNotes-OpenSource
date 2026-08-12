import {
  PROVIDER_CATALOG,
  type ProviderId,
  type ProviderRetryPolicy as CoreProviderRetryPolicy,
  type ProviderRuntimeLogKind as CoreProviderRuntimeLogKind
} from "@mathnotes/shared";
import type { RecognitionProviderId } from "./providerConfigStore";

export type { ProviderRetryPolicy, ProviderRuntimeLogKind } from "@mathnotes/shared";

export type RecognitionProviderCapability = {
  providerId: RecognitionProviderId;
  label: string;
  requiresLocalRuntime: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsHealthCheck: boolean;
  runtimeLogKind: CoreProviderRuntimeLogKind;
  retryPolicy: CoreProviderRetryPolicy;
};

const providerCapabilities = Object.fromEntries(
  Object.values(PROVIDER_CATALOG).map((descriptor) => [
    descriptor.providerId,
    {
      providerId: descriptor.providerId,
      label: descriptor.label,
      requiresLocalRuntime: descriptor.requiresLocalRuntime,
      supportsVision: descriptor.supportsVision,
      supportsStreaming: descriptor.supportsStreaming,
      supportsHealthCheck: descriptor.supportsHealthCheck,
      runtimeLogKind: descriptor.runtimeLogKind,
      retryPolicy: descriptor.retryPolicy
    }
  ])
) as Record<ProviderId, RecognitionProviderCapability>;

export function getRecognitionProviderCapability(
  providerId: RecognitionProviderId | null | undefined
): RecognitionProviderCapability {
  return providerCapabilities[providerId ?? "mock"] ?? providerCapabilities.mock;
}

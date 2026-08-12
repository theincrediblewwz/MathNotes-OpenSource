import path from "node:path";
import type { AssistantProvider, RecognitionProvider } from "@mathnotes/shared";

export type CorePlatform = "windows" | "macos" | "linux";

export type CoreLogContext = Readonly<Record<string, boolean | number | string | null | undefined>>;

export interface CoreLogger {
  debug(message: string, context?: CoreLogContext): void;
  info(message: string, context?: CoreLogContext): void;
  warn(message: string, context?: CoreLogContext): void;
  error(message: string, context?: CoreLogContext): void;
}

export interface ProviderFactory {
  createRecognitionProvider(): Promise<RecognitionProvider>;
  createAssistantProvider(): Promise<AssistantProvider>;
}

export interface PlatformCapabilities {
  readonly canListenOnLan: boolean;
  readonly canSpawnProcesses: boolean;
  readonly canWatchFiles: boolean;
}

export interface CoreEnvironment {
  readonly userDataDir: string;
  readonly notesRootDir: string;
  readonly tempDir: string;
  readonly appVersion: string;
  readonly platform: CorePlatform;
  readonly logger: CoreLogger;
  readonly providerFactory: ProviderFactory;
  readonly platformCapabilities: PlatformCapabilities;
}

export function validateCoreEnvironment(environment: CoreEnvironment): void {
  for (const [name, value] of [
    ["userDataDir", environment.userDataDir],
    ["notesRootDir", environment.notesRootDir],
    ["tempDir", environment.tempDir]
  ] as const) {
    if (!value.trim() || !path.isAbsolute(value)) {
      throw new Error(`CoreEnvironment.${name} must be an absolute path`);
    }
  }
  if (!environment.appVersion.trim()) throw new Error("CoreEnvironment.appVersion is required");
}

export const silentCoreLogger: CoreLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

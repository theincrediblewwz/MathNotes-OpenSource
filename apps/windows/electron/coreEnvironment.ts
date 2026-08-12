import type {
  AssistantProvider,
  RecognitionProvider
} from "@mathnotes/shared";
import type {
  CorePlatform,
  CoreEnvironment,
  CoreLogger,
  CoreService
} from "@mathnotes/core-server";

export interface CreateDesktopCoreEnvironmentInput {
  readonly userDataDir: string;
  readonly notesRootDir: string;
  readonly tempDir: string;
  readonly appVersion: string;
  readonly nodePlatform?: NodeJS.Platform;
  readonly createRecognitionProvider: () => Promise<RecognitionProvider>;
  readonly createAssistantProvider: () => Promise<AssistantProvider>;
  readonly logger?: CoreLogger;
}

export type CreateWindowsCoreEnvironmentInput = Omit<CreateDesktopCoreEnvironmentInput, "nodePlatform">;

export function createDesktopCoreEnvironment(
  input: CreateDesktopCoreEnvironmentInput
): CoreEnvironment {
  return createCoreEnvironment(input, corePlatformFromNodePlatform(input.nodePlatform ?? process.platform));
}

export function createWindowsCoreEnvironment(
  input: CreateWindowsCoreEnvironmentInput
): CoreEnvironment {
  return createCoreEnvironment(input, "windows");
}

export function corePlatformFromNodePlatform(platform: NodeJS.Platform): CorePlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

function createCoreEnvironment(
  input: CreateDesktopCoreEnvironmentInput,
  platform: CorePlatform
): CoreEnvironment {
  return {
    userDataDir: input.userDataDir,
    notesRootDir: input.notesRootDir,
    tempDir: input.tempDir,
    appVersion: input.appVersion,
    platform,
    logger: input.logger ?? consoleCoreLogger,
    providerFactory: {
      createRecognitionProvider: input.createRecognitionProvider,
      createAssistantProvider: input.createAssistantProvider
    },
    platformCapabilities: {
      canListenOnLan: true,
      canSpawnProcesses: true,
      canWatchFiles: true
    }
  };
}

export interface CreateResilientWindowsCoreServiceInput {
  readonly name: string;
  readonly start: () => Promise<void> | void;
  readonly stop: () => Promise<void> | void;
  readonly onStartError: (error: unknown) => Promise<void> | void;
}

/** Keeps an optional desktop capability retryable without blocking the app window. */
export function createResilientWindowsCoreService(
  input: CreateResilientWindowsCoreServiceInput
): CoreService {
  return {
    name: input.name,
    async start() {
      try {
        await input.start();
      } catch (error) {
        await input.onStartError(error);
      }
    },
    async stop() {
      await input.stop();
    }
  };
}

const consoleCoreLogger: CoreLogger = {
  debug(message, context) {
    console.debug(message, context ?? "");
  },
  info(message, context) {
    console.info(message, context ?? "");
  },
  warn(message, context) {
    console.warn(message, context ?? "");
  },
  error(message, context) {
    console.error(message, context ?? "");
  }
};

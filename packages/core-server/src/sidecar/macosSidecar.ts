import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoreEnvironment, CoreLogger, ProviderFactory } from "../environment";
import { startMathNotesCoreHeadless } from "../headless";
import type { CoreService, MathNotesCore } from "../mathNotesCore";
import { LocalShellServer, type StartedLocalShellServer } from "../api/localShellServer";
import {
  NetworkApiServer,
  type StartedNetworkApiServer
} from "../api/networkApiServer";
import { readNotesCatalog } from "../catalog/sessionCatalog";
import {
  createWorkspaceNotebook,
  createWorkspaceSession
} from "../catalog/workspaceCommandService";
import {
  readReadonlySessionAsset,
  readReadonlySessionBlock,
  readReadonlySessionManifest,
  renderReadonlyMarkdownPreview,
  renderStandaloneMarkdownPreview
} from "../session/sessionReadService";
import { SessionEditService } from "../session/sessionEditService";
import { SessionImageImportService } from "../session/sessionImageImportService";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { SessionRecognitionService } from "../session/sessionRecognitionService";
import { SessionAssistantService } from "../session/sessionAssistantService";
import { SessionExportService } from "../session/sessionExportService";
import { SessionPhotoIngestAdapter } from "../session/sessionPhotoIngestAdapter";
import { SessionPdfImportService } from "../session/sessionPdfImportService";
import { SessionPdfIngestAdapter } from "../session/sessionPdfIngestAdapter";
import { SessionBlockOrganizeService } from "../session/sessionBlockOrganizeService";
import { RuntimeProviderRegistry } from "../provider/runtimeProviderRegistry";
import { AiGuidanceSettingsService } from "../provider/aiGuidanceSettingsService";
import { FilesystemCompanionStore } from "../session/filesystemCompanionStore";
import {
  buildCompanionSessionSnapshot,
  readCompanionAsset
} from "../session/companionReadService";
import { RevisionEventLog } from "../events/revisionEventLog";
import type { CompanionUploadActivity } from "../api/networkApiContracts";
import { DeviceIdentityService } from "../device/deviceIdentityService";

export const MACOS_SIDECAR_API_VERSION = 1;

export type MacosSidecarReady = Readonly<{
  type: "mathnotes.ready";
  apiVersion: number;
  instanceId: string;
  host: "127.0.0.1";
  port: number;
  companionHost?: Readonly<{
    host: "0.0.0.0";
    port: number;
    url: string;
  }>;
}>;

export type MacosCompanionHostOptions = Readonly<{
  token: string;
  port?: number;
  pwaStaticRootDir?: string;
}>;

export type StartMacosSidecarOptions = Readonly<{
  token: string;
  userDataDir: string;
  notesRootDir: string;
  tempDir: string;
  appVersion: string;
  logger?: CoreLogger;
  instanceId?: string;
  providerFactory?: ProviderFactory;
  providerRegistry?: RuntimeProviderRegistry;
  companionHost?: MacosCompanionHostOptions;
}>;

export type RunningMacosSidecar = Readonly<{
  core: MathNotesCore;
  ready: MacosSidecarReady;
  stop(): Promise<void>;
}>;

export function parseSidecarParentPid(value: string | undefined, currentPid = process.pid): number | undefined {
  if (!value) return undefined;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === currentPid) {
    throw new Error("MATHNOTES_PARENT_PID must identify a different running process");
  }
  return pid;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startMacosSidecar(options: StartMacosSidecarOptions): Promise<RunningMacosSidecar> {
  await Promise.all([
    mkdir(options.userDataDir, { recursive: true }),
    mkdir(options.notesRootDir, { recursive: true }),
    mkdir(options.tempDir, { recursive: true })
  ]);

  const sessionWrites = new SessionWriteCoordinator();
  const guidanceSettings = new AiGuidanceSettingsService(join(options.userDataDir, "settings"));
  await guidanceSettings.start();
  const providerRegistry = options.providerRegistry ?? new RuntimeProviderRegistry(undefined, guidanceSettings);
  const environment = createEnvironment(options, providerRegistry);
  const sessionEditor = new SessionEditService(options.notesRootDir, undefined, sessionWrites);
  const sessionImageImporter = new SessionImageImportService(options.notesRootDir, undefined, sessionWrites);
  const sessionPdfImporter = new SessionPdfImportService(options.notesRootDir, undefined, sessionWrites);
  const sessionRecognition = new SessionRecognitionService(
    options.notesRootDir,
    () => environment.providerFactory.createRecognitionProvider(),
    sessionWrites
  );
  const sessionAssistant = new SessionAssistantService(
    options.notesRootDir,
    () => environment.providerFactory.createAssistantProvider(),
    sessionWrites
  );
  const sessionBlockOrganizer = new SessionBlockOrganizeService(
    options.notesRootDir,
    undefined,
    sessionWrites
  );
  const sessionExporter = new SessionExportService(options.notesRootDir);
  const companionActivityStore = new SessionCompanionActivityStore(
    join(options.userDataDir, "companion-upload-activity.json")
  );
  await companionActivityStore.start();
  const companionStore = new FilesystemCompanionStore(options.notesRootDir);
  const deviceIdentityService = options.companionHost
    ? new DeviceIdentityService({
        filePath: join(options.userDataDir, "companion-device-identities.json")
      })
    : undefined;
  await deviceIdentityService?.start();
  const localShell = new LocalShellServer({
    host: "127.0.0.1",
    port: 0,
    token: options.token,
    apiVersion: MACOS_SIDECAR_API_VERSION,
    readCatalog: () => readNotesCatalog({ rootDir: options.notesRootDir }),
    createNotebook: (input) => createWorkspaceNotebook({
      rootDir: options.notesRootDir,
      title: input.title
    }),
    createSession: (input) => createWorkspaceSession({
      rootDir: options.notesRootDir,
      notebookId: input.notebookId,
      title: input.title
    }),
    createCompanionPairingChallenge: deviceIdentityService
      ? () => deviceIdentityService.createExclusiveChallenge()
      : undefined,
    readSessionManifest: (input) => readReadonlySessionManifest({ rootDir: options.notesRootDir, ...input }),
    readSessionBlock: (input) => readReadonlySessionBlock({ rootDir: options.notesRootDir, ...input }),
    previewSessionMarkdown: (input) => renderReadonlyMarkdownPreview({
      rootDir: options.notesRootDir,
      ...input
    }),
    previewStandaloneMarkdown: (input) => renderStandaloneMarkdownPreview(input.markdown),
    appendSessionMarkdown: (input) => sessionEditor.appendMarkdownBlock(input),
    saveSessionBlock: (input) => sessionEditor.saveMarkdownBlock(input),
    setSessionBlockLock: (input) => sessionEditor.setMarkdownBlockLock(input),
    reorderSessionBlocks: async (input) => {
      await sessionBlockOrganizer.reorder(input);
      return readReadonlySessionManifest({ rootDir: options.notesRootDir, ...input });
    },
    deleteSessionBlocks: async (input) => {
      await sessionBlockOrganizer.delete(input);
      return readReadonlySessionManifest({ rootDir: options.notesRootDir, ...input });
    },
    transferSessionBlocks: (input) => sessionBlockOrganizer.transfer(input),
    listSessionConflicts: (input) => sessionEditor.listMarkdownConflicts(input),
    readSessionConflict: (input) => sessionEditor.readMarkdownConflict(input),
    resolveSessionConflict: (input) => sessionEditor.resolveMarkdownConflict(input),
    importSessionImage: (input) => sessionImageImporter.importImage(input),
    importSessionPdf: (input) => sessionPdfImporter.importPdf(input),
    readSessionAsset: (input) => readReadonlySessionAsset({ rootDir: options.notesRootDir, ...input }),
    sessionRecognition,
    readSessionCompanionActivity: (input) => companionActivityStore.read(input),
    sessionAssistant,
    providerRegistry,
    readPromptTemplates: () => guidanceSettings.readPromptTemplates(),
    savePromptTemplates: (input) => guidanceSettings.savePromptTemplates(input),
    readNotationProfiles: () => guidanceSettings.readNotationProfiles(),
    saveNotationProfiles: (input) => guidanceSettings.saveNotationProfiles(input),
    previewNotation: (input) => guidanceSettings.previewNotation(input),
    exportSessionMarkdown: (input) => sessionExporter.exportMarkdown({
      ...input,
      includeMetadataComments: false,
      mathCompatibility: "portable",
      packageMode: "markdown"
    }),
    readSessionMarkdownExport: (input) => sessionExporter.readMarkdownExport(input)
  });
  let startedServer: StartedLocalShellServer | undefined;
  let startedCompanionHost: StartedNetworkApiServer | undefined;
  const localShellService: CoreService = {
    name: "local-shell-api",
    async start() {
      startedServer = await localShell.start();
    },
    async stop() {
      await localShell.stop();
    }
  };
  const companionHost = options.companionHost && deviceIdentityService
    ? createCompanionHost({
        options,
        sessionImageImporter,
        sessionPdfImporter,
        sessionRecognition,
        companionStore,
        deviceIdentityService,
        companionActivityStore
      })
    : undefined;
  const companionHostService: CoreService | undefined = companionHost && {
    name: "companion-host-api",
    async start() {
      startedCompanionHost = await companionHost.start();
    },
    async stop() {
      await companionHost.stop();
    }
  };

  const core = await startMathNotesCoreHeadless(environment, {
    services: [localShellService, ...(companionHostService ? [companionHostService] : [])]
  });
  if (!startedServer) {
    await core.stop();
    throw new Error("macOS sidecar local shell did not start");
  }

  const ready: MacosSidecarReady = {
    type: "mathnotes.ready",
    apiVersion: MACOS_SIDECAR_API_VERSION,
    instanceId: options.instanceId ?? randomUUID(),
    host: "127.0.0.1",
    port: startedServer.port,
    companionHost: startedCompanionHost && {
      host: "0.0.0.0",
      port: startedCompanionHost.port,
      url: `http://127.0.0.1:${startedCompanionHost.port}`
    }
  };
  return {
    core,
    ready,
    async stop() {
      await core.stop();
      await companionActivityStore.stop();
    }
  };
}

function createCompanionHost(input: {
  options: StartMacosSidecarOptions;
  sessionImageImporter: SessionImageImportService;
  sessionPdfImporter: SessionPdfImportService;
  sessionRecognition: SessionRecognitionService;
  companionStore: FilesystemCompanionStore;
  deviceIdentityService: DeviceIdentityService;
  companionActivityStore: SessionCompanionActivityStore;
}): NetworkApiServer {
  const companionOptions = input.options.companionHost;
  if (!companionOptions) throw new Error("macOS companion host options are required");
  const targets = async () => {
    const catalog = await readNotesCatalog({ rootDir: input.options.notesRootDir });
    return catalog.notebooks.flatMap((notebook) => notebook.sessions.map((session) => ({
      notebookId: notebook.notebookId,
      notebookTitle: notebook.title,
      sessionId: session.sessionId,
      title: session.title
    })));
  };
  const revisionEventLog = new RevisionEventLog({
    filePath: join(input.options.userDataDir, "companion-events.json")
  });
  const photoIngest = new SessionPhotoIngestAdapter({
    userDataDir: input.options.userDataDir,
    notesRootDir: input.options.notesRootDir,
    imageImporter: input.sessionImageImporter,
    recognition: input.sessionRecognition
  });
  const pdfIngest = new SessionPdfIngestAdapter({
    userDataDir: input.options.userDataDir,
    notesRootDir: input.options.notesRootDir,
    importer: input.sessionPdfImporter
  });
  return new NetworkApiServer({
    host: "0.0.0.0",
    port: companionOptions.port ?? 1051,
    token: companionOptions.token,
    pipeline: photoIngest,
    acceptPdf: (upload) => pdfIngest.acceptPdf(upload),
    getPairingTargets: targets,
    getCompanionSession: (notebookId, sessionId) => buildCompanionSessionSnapshot({
      store: input.companionStore,
      notebookId,
      sessionId
    }),
    getCompanionAsset: (notebookId, sessionId, assetPath) => readCompanionAsset({
      store: input.companionStore,
      notebookId,
      sessionId,
      assetPath
    }),
    revisionEventLog,
    onUploadActivity: (activity) => input.companionActivityStore.update(activity),
    deviceIdentityService: input.deviceIdentityService,
    pwaStaticRootDir: companionOptions.pwaStaticRootDir
  });
}

class SessionCompanionActivityStore {
  private readonly latest = new Map<string, CompanionUploadActivity>();
  private writeChain = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async start(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(stored)) return;
      for (const candidate of stored) {
        if (!isStoredCompanionActivity(candidate) || this.isExpired(candidate)) continue;
        this.latest.set(this.key(candidate), candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  update(activity: CompanionUploadActivity): void {
    this.latest.set(this.key(activity), activity);
    const snapshot = [...this.latest.values()].filter((candidate) => !this.isExpired(candidate));
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const temporaryPath = `${this.filePath}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await rename(temporaryPath, this.filePath);
      });
  }

  read(input: { notebookId: string; sessionId: string }): CompanionUploadActivity | undefined {
    const activity = this.latest.get(this.key(input));
    if (!activity) return undefined;
    if (this.isExpired(activity)) {
      this.latest.delete(this.key(input));
      return undefined;
    }
    return activity;
  }

  async stop(): Promise<void> {
    await this.writeChain;
  }

  private isExpired(activity: CompanionUploadActivity): boolean {
    const age = Date.now() - Date.parse(activity.updatedAt);
    if (!Number.isFinite(age)) return true;
    return age > (activity.status === "receiving" ? 30_000 : 7 * 24 * 60 * 60 * 1_000);
  }

  private key(input: { notebookId: string; sessionId: string }): string {
    return `${input.notebookId}\u0000${input.sessionId}`;
  }
}

function isStoredCompanionActivity(value: unknown): value is CompanionUploadActivity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CompanionUploadActivity>;
  return candidate.version === 1
    && typeof candidate.notebookId === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.receivedBytes === "number"
    && (candidate.status === "receiving" || candidate.status === "accepted")
    && typeof candidate.updatedAt === "string";
}

function createEnvironment(
  options: StartMacosSidecarOptions,
  providerRegistry: RuntimeProviderRegistry
): CoreEnvironment {
  return {
    userDataDir: options.userDataDir,
    notesRootDir: options.notesRootDir,
    tempDir: options.tempDir,
    appVersion: options.appVersion,
    platform: "macos",
    logger: options.logger ?? stderrLogger,
    providerFactory: options.providerFactory ?? providerRegistry,
    platformCapabilities: {
      canListenOnLan: true,
      canSpawnProcesses: true,
      canWatchFiles: true
    }
  };
}

const stderrLogger: CoreLogger = {
  debug(message, context) { writeLog("debug", message, context); },
  info(message, context) { writeLog("info", message, context); },
  warn(message, context) { writeLog("warn", message, context); },
  error(message, context) { writeLog("error", message, context); }
};

function writeLog(level: string, message: string, context?: Readonly<Record<string, unknown>>): void {
  const suffix = context ? ` ${JSON.stringify(context)}` : "";
  process.stderr.write(`[${level}] ${message}${suffix}\n`);
}

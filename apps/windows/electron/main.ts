import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, net, protocol, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import {
  createMathNotesCore,
  DeviceIdentityService,
  readWorkspaceContext,
  RevisionEventLog,
  SessionBlockOrganizeService,
  SessionEditService,
  SessionSelectionEditService,
  writeWorkspaceContext,
  type CompanionUploadActivity,
  type MathNotesCore,
  type PairingChallenge
} from "@mathnotes/core-server";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BlockStore } from "../src/core/blockStore";
import { BlockWriter } from "../src/core/blockWriter";
import { buildConnectionDiagnostics } from "../src/core/connectionDiagnostics";
import { IngestServer } from "../src/core/ingestServer";
import { readIngestIdentity, writeIngestIdentity } from "../src/core/ingestIdentityStore";
import { exportSessionMarkdown } from "../src/core/exporter";
import { choosePreferredIngestHost, chooseRefreshedIngestHost, isUsableIngestHost, listIPv4AddressCandidates } from "../src/core/networkAddress";
import { PairingManager, validatePairingTokenUpdate } from "../src/core/pairingManager";
import { type IngestPhotoResult, PhotoIngestPipeline } from "../src/core/photoIngestPipeline";
import { buildCompanionSessionSnapshot, readCompanionAsset } from "../src/core/companionReadService";
import { detectLocalPhotoMimeType } from "../src/core/localPhotoImport";
import { checkProviderHealth } from "../src/core/providerHealth";
import { readAssistantProviderConfig, writeAssistantProviderConfig } from "../src/core/assistantProviderConfigStore";
import { readProviderConfig, writeProviderConfig, type RecognitionProviderConfig } from "../src/core/providerConfigStore";
import { runProviderTurnAcceptance } from "../src/core/providerTurnAcceptance";
import { buildUserDiagnosticReport, hasConfiguredProviderCredential } from "../src/core/userDiagnostics";
import { getActivePromptTemplate, readPromptTemplateConfig, writePromptTemplateConfig } from "../src/core/promptTemplateStore";
import { normalizeNotationProfileConfig, readNotationProfileConfig, writeNotationProfileConfig } from "../src/core/notationProfileStore";
import { selectNotationRules } from "../src/core/notationProfileSelector";
import { buildFaithfulTranscriptionPrompt } from "../src/core/faithfulTranscriptionPrompt";
import { CodexRuntimeManager, type CodexRuntimeState as CoreCodexRuntimeState } from "../src/core/codexRuntimeManager";
import { createAssistantProviderFromConfig, createRecognitionProviderFromConfig } from "../src/core/recognitionProviderFactory";
import { runAssistantTask, type AssistantTaskRuntimeEvent } from "../src/core/assistantTask";
import { AssistantRemarkStore } from "../src/core/assistantRemarkStore";
import { RecognitionQueue, type RecognitionJob, type RecognitionRuntimeEvent as CoreRecognitionRuntimeEvent } from "../src/core/recognitionQueue";
import { buildRecognitionContextForJob } from "../src/core/sessionRecognitionContext";
import { retryRecognitionJob } from "../src/core/recognitionRetry";
import { recognitionJobToTaskSummary, upsertRecognitionJob } from "../src/core/recognitionJobLog";
import { readRecognitionTaskSummaries } from "../src/core/uploadTaskLog";
import { compactSessionDocumentForRenderer, loadSessionDocumentFromStore } from "../src/core/sessionDocumentStore";
import { createNotebook, deleteNotebookSession, listNotebooks, listNotebookSessions, renameSessionTitle } from "../src/core/sessionCatalog";
import { readUserSettings, writeUserSettings, type UserSettings } from "../src/core/userSettingsStore";
import { createNotesBackup } from "../src/core/notesBackup";
import { isTrustedRendererUrl } from "../src/core/electronSecurity";
import { decodePngDataUrl, markdownForEmbeddedAsset } from "../src/core/imageAnnotation";
import { imagePathToDataUrl } from "../src/core/imageDataUrl";
import { readPdfDocumentInfo } from "../src/core/pdfDocumentInfo";
import { PdfRecognitionBatchRunner, type PdfRecognitionBatch } from "../src/core/pdfRecognitionBatch";
import { PdfIngestPipeline, type IngestPdfResult } from "../src/core/pdfIngestPipeline";
import { createSessionId } from "../src/common/sessionNaming";
import { parseSessionSourceText } from "../src/common/sessionSourceDocument";
import { createDesktopCoreEnvironment, createResilientWindowsCoreService } from "./coreEnvironment";
import type {
  CreateNotebookInput,
  CreateSessionInput,
  CreateMarkdownBlockInput,
  DeleteMarkdownBlockInput,
  DeleteSessionInput,
  SaveAnnotatedImageInput,
  SaveAnnotatedImageResult,
  EmbeddedImageImportInput,
  EmbeddedImageImportResult,
  ExportCurrentSessionInput,
  IngestServerState,
  UpdatePairingTokenInput,
  LoadRecognitionTasksInput,
  LocalPhotoImportInput,
  LocalPhotoImportResult,
  ImportLocalPdfInput,
  ImportLocalPdfResult,
  StagePdfRecognitionPageInput,
  StagePdfRecognitionPageResult,
  StartPdfRecognitionBatchInput,
  StartPdfRecognitionBatchResult,
  PdfRecognitionBatchControlInput,
  PdfRecognitionBatchControlResult,
  PickLocalPdfInput,
  PickLocalPdfResult,
  PickImageForAnnotationInput,
  PickImageForAnnotationResult,
  PickDirectoryInput,
  PickDirectoryResult,
  ProposeSelectionEditInput,
  CreateNotesBackupResult,
  RevealPathInput,
  CancelRecognitionTaskInput,
  CancelAssistantTaskInput,
  RecognitionJobChangedEvent,
  RecognitionRuntimeEvent,
  AssistantProviderConfigInput,
  RecognitionProviderConfigInput,
  PromptTemplateConfig,
  NotationPreviewInput,
  NotationProfileConfig,
  NotationPromptPreview,
  ExportUserDiagnosticReportInput,
  ExportUserDiagnosticReportResult,
  ProviderSelfTestInput,
  ProviderSelfTestResult,
  RenameSessionInput,
  OpenSessionInput,
  RestoreDeletedMarkdownBlockInput,
  ReorderSessionBlocksInput,
  RetryRecognitionTaskInput,
  RunAssistantTaskInput,
  SelectionEditProposalCommand,
  SetMarkdownBlockLockInput,
  TransferSessionBlocksInput,
  UploadCompletedEvent,
  WindowControlAction,
  WindowDragInput
} from "../src/types/mathNotesApi";

const devServerUrl = process.env.MATHNOTES_DEV_SERVER;
const defaultNotebookId = "functional_analysis";
const defaultSessionId = "lecture";
const defaultSessionTitle = "泛函分析 第 3 讲";
const rendererDistRootDir = path.join(__dirname, "../dist");

function bundledPwaStaticRootDir(): string | undefined {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "MathNotesPWA")
    : path.resolve(__dirname, "../../pwa/dist");
  return existsSync(path.join(root, "index.html")) ? root : undefined;
}

const ipcMain = {
  handle<TArgs extends unknown[], TResult>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
  ): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedRenderer(event);
      return listener(event, ...(args as TArgs));
    });
  }
};

let ingestServer: IngestServer | undefined;
let mainWindow: BrowserWindow | undefined;
let appIsQuitting = false;
let deviceIdentityService: DeviceIdentityService | undefined;
let activeDevicePairingChallenge: PairingChallenge | undefined;
let ingestState: IngestServerState = { running: false };
let mathNotesCore: MathNotesCore | undefined;
let currentNotebookId = defaultNotebookId;
let currentSessionId = defaultSessionId;
let cachedUserSettings: UserSettings | undefined;
let defaultStoreInitialization: { rootDir: string; promise: Promise<void> } | undefined;
let blockOrganizeRuntime: { rootDir: string; service: SessionBlockOrganizeService } | undefined;
let selectionEditRuntime: { rootDir: string; service: SessionSelectionEditService } | undefined;
let activeRecognitionPipeline: { rootDir: string; generation: number; promise: Promise<PhotoIngestPipeline> } | undefined;
let recognitionPipelineGeneration = 0;
const codexRuntimeManager = new CodexRuntimeManager();
const approvedWindowCloses = new WeakSet<BrowserWindow>();
const windowDragSessions = new WeakMap<BrowserWindow, {
  startScreenX: number;
  startScreenY: number;
  startWindowX: number;
  startWindowY: number;
}>();
const activeRecognitionCancels = new Map<string, () => void>();
const activeAssistantCancels = new Map<string, () => void>();
let latestProviderSelfTest: ProviderSelfTestResult | undefined;
type PdfBatchRuntime = {
  runner: PdfRecognitionBatchRunner;
  batch: PdfRecognitionBatch;
  status: "running" | "pausing" | "paused";
};
const activePdfRecognitionBatches = new Map<string, PdfBatchRuntime>();

function refreshIngestAddressState(): IngestServerState {
  if (!ingestServer || !ingestState.running || !ingestState.port || !ingestState.token) {
    return ingestState;
  }

  const addressCandidates = listIPv4AddressCandidates();
  const displayHost = chooseRefreshedIngestHost(
    addressCandidates,
    ingestState.displayHost ?? ingestState.host,
    ingestState.preferredHost
  );
  const transportKind = addressCandidates.find((candidate) => candidate.address === displayHost)?.transportKind;
  const pairing = new PairingManager().createPairingSession({
    host: displayHost,
    hosts: addressCandidates.filter(isUsableIngestHost).map((candidate) => candidate.address),
    port: ingestState.port,
    token: ingestState.token,
    now: new Date().toISOString()
  });

  ingestState = {
    ...ingestState,
    host: displayHost,
    displayHost,
    transportKind,
    url: `http://${displayHost}:${ingestState.port}`,
    pairingPayload: pairing.payload,
    ...devicePairingState(displayHost, addressCandidates, ingestState.port),
    addressCandidates
  };
  return ingestState;
}

function devicePairingState(
  host: string,
  addressCandidates: IngestServerState["addressCandidates"],
  port: number
): Pick<IngestServerState, "devicePairingPayload" | "devicePairingCode" | "devicePairingExpiresAt"> {
  const challenge = activeDevicePairingChallenge;
  if (!challenge) return {};
  const pairing = new PairingManager().createDevicePairingSession({
    host,
    hosts: (addressCandidates ?? []).filter(isUsableIngestHost).map((candidate) => candidate.address),
    port,
    challengeId: challenge.challengeId,
    userCode: challenge.userCode,
    expiresAt: challenge.expiresAt,
    now: new Date().toISOString()
  });
  return {
    devicePairingPayload: pairing.payload,
    devicePairingCode: challenge.userCode,
    devicePairingExpiresAt: challenge.expiresAt
  };
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mathnotes-asset",
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      supportFetchAPI: true
    }
  }
]);

function createWindow() {
  const windowIcon = process.platform === "win32"
    ? path.join(__dirname, "../assets/mathnotes.ico")
    : path.join(__dirname, "../assets/mathnotes.png");
  const window = new BrowserWindow({
    width: 1280,
    height: 911,
    minWidth: 960,
    minHeight: 680,
    title: "Math Notes",
    icon: windowIcon,
    titleBarStyle: "hidden",
    backgroundColor: "#fbfaf7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const distIndexPath = path.join(__dirname, "../dist/index.html");
  let shouldFallbackFromDevServer = Boolean(devServerUrl);

  window.webContents.setWindowOpenHandler((details) => {
    if (details.frameName === "mathnotes-assistant" && details.url === "about:blank") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          minWidth: 420,
          minHeight: 480,
          title: "MathNotes 学习助手",
          frame: false,
          resizable: true,
          alwaysOnTop: false,
          autoHideMenuBar: true,
          backgroundColor: "#fbfaf7",
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    return { action: "deny" };
  });
  mainWindow = window;
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedAppUrl(targetUrl)) event.preventDefault();
  });

  window.webContents.once("did-fail-load", (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (!shouldFallbackFromDevServer || !isMainFrame) {
      return;
    }
    shouldFallbackFromDevServer = false;
    void window.loadFile(distIndexPath);
  });

  if (devServerUrl) {
    window.loadURL(devServerUrl).catch(() => {
      if (!shouldFallbackFromDevServer) {
        return;
      }
      shouldFallbackFromDevServer = false;
      void window.loadFile(distIndexPath);
    });
  } else {
    window.loadFile(distIndexPath);
  }

  window.on("close", (event) => {
    if (appIsQuitting || approvedWindowCloses.has(window)) {
      approvedWindowCloses.delete(window);
      for (const auxiliaryWindow of BrowserWindow.getAllWindows()) {
        if (auxiliaryWindow !== window) auxiliaryWindow.destroy();
      }
      return;
    }

    event.preventDefault();
    window.webContents.send("mathnotes:window-close-requested");
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
}

if (process.platform === "win32") {
  app.setAppUserModelId("com.mathnotes.windows");
}

app.whenReady().then(async () => {
  registerAssetProtocol();
  registerIpcHandlers();
  codexRuntimeManager.onStateChanged(notifyCodexRuntimeStateChanged);
  await ensureUserSettings();
  mathNotesCore = createMathNotesCore(
    createDesktopCoreEnvironment({
      userDataDir: app.getPath("userData"),
      notesRootDir: notesRootDir(),
      tempDir: app.getPath("temp"),
      appVersion: app.getVersion(),
      createRecognitionProvider: createRecognitionProviderForCurrentRuntime,
      createAssistantProvider: createAssistantProviderForCurrentRuntime
    }),
    {
      services: [
        createResilientWindowsCoreService({
          name: "ingest-server",
          start: async () => {
            await startIngestServerInternal();
          },
          stop: async () => {
            await stopIngestServerInternal();
          },
          onStartError: (error) => {
            ingestState = {
              running: false,
              rootDir: notesRootDir(),
              lastError: errorMessage(error)
            };
          }
        })
      ]
    }
  );
  await mathNotesCore.start();
  createWindow();
  void syncCodexRuntimeWithProviderConfig();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  appIsQuitting = true;
  void mathNotesCore?.stop();
  codexRuntimeManager.stop();
});

function registerAssetProtocol() {
  protocol.handle("mathnotes-asset", async (request) => {
    try {
      const assetPath = assetPathFromProtocolUrl(request.url);
      await ensureUserSettings();
      const rootDir = path.resolve(notesRootDir());

      if (!isPathInside(rootDir, assetPath) || !isAllowedSessionAssetPath(assetPath)) {
        return new Response("Forbidden", { status: 403 });
      }

      const response = await net.fetch(pathToFileURL(assetPath).toString());
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return new Response("Asset not found", { status: 404 });
    }
  });
}

function assetPathFromProtocolUrl(url: string): string {
  const parsed = new URL(url);
  const pathname = decodeURIComponent(parsed.pathname);
  const platformPath = process.platform === "win32" && /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
  return path.resolve(platformPath);
}

function isPathInside(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isAllowedSessionAssetPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  const assetsIndex = parts.lastIndexOf("assets");
  return assetsIndex >= 0 && ["embedded", "pdfs", "photos"].includes(parts[assetsIndex + 1] ?? "");
}

function registerIpcHandlers() {
  ipcMain.handle("mathnotes:load-current-session", async () => {
    const store = await ensureDefaultStore();
    const document = await loadSessionDocumentFromStore({
      store,
      notebookId: currentNotebookId,
      sessionId: currentSessionId
    });
    return compactSessionDocumentForRenderer(document);
  });

  ipcMain.handle("mathnotes:load-notebooks", async () => {
    await ensureDefaultStore();
    return listNotebooks({ rootDir: notesRootDir() });
  });

  ipcMain.handle("mathnotes:load-notebook-sessions", async (_event, input: { notebookId: string }) => {
    await ensureDefaultStore();
    return listNotebookSessions({
      rootDir: notesRootDir(),
      notebookId: input.notebookId
    });
  });

  ipcMain.handle("mathnotes:open-session", async (_event, input: OpenSessionInput) => {
    const store = await ensureDefaultStore();
    currentNotebookId = input.notebookId;
    currentSessionId = input.sessionId;
    await persistCurrentWorkspaceContext();
    return loadSessionDocumentFromStore({
      store,
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:rename-session", async (_event, input: RenameSessionInput) => {
    const store = await ensureDefaultStore();
    await renameSessionTitle({
      rootDir: notesRootDir(),
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      title: input.title,
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionCatalogChange("renamed", input.notebookId, input.sessionId);
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store,
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:delete-session", async (_event, input: DeleteSessionInput) => {
    await ensureDefaultStore();
    const remainingSessions = await deleteNotebookSession({
      rootDir: notesRootDir(),
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
    if (currentNotebookId === input.notebookId && currentSessionId === input.sessionId) {
      currentNotebookId = input.notebookId;
      currentSessionId = remainingSessions[0]?.sessionId ?? "";
      if (currentSessionId) await persistCurrentWorkspaceContext();
    }
    ingestServer?.publishCompanionDeleted(input.notebookId, input.sessionId);
    return {
      deletedSessionId: input.sessionId,
      remainingSessions
    };
  });

  ipcMain.handle("mathnotes:load-user-settings", async () => ensureUserSettings());

  ipcMain.handle("mathnotes:save-user-settings", async (_event, input: UserSettings) => {
    cachedUserSettings = await writeUserSettings({
      userDataDir: app.getPath("userData"),
      settings: input
    });
    return cachedUserSettings;
  });

  ipcMain.handle("mathnotes:load-connection-diagnostics", async () =>
    buildConnectionDiagnostics({
      hasNativeApi: true,
      ingestServer: ingestState
    })
  );

  ipcMain.handle("mathnotes:load-provider-config", async () =>
    readProviderConfig({
      rootDir: notesRootDir()
    })
  );

  ipcMain.handle("mathnotes:load-assistant-provider-config", async () =>
    readAssistantProviderConfig({
      rootDir: notesRootDir()
    })
  );

  ipcMain.handle("mathnotes:load-prompt-template-config", async () =>
    readPromptTemplateConfig({
      rootDir: notesRootDir()
    })
  );

  ipcMain.handle("mathnotes:save-prompt-template-config", async (_event, input: PromptTemplateConfig) => {
    const config = await writePromptTemplateConfig({
      rootDir: notesRootDir(),
      config: input
    });
    invalidateRecognitionPipeline();
    void prewarmRecognitionPipeline();
    return config;
  });

  ipcMain.handle("mathnotes:load-notation-profile-config", async () =>
    readNotationProfileConfig({ rootDir: notesRootDir() })
  );

  ipcMain.handle("mathnotes:save-notation-profile-config", async (_event, input: NotationProfileConfig) =>
    writeNotationProfileConfig({ rootDir: notesRootDir(), config: input })
  );

  ipcMain.handle("mathnotes:preview-notation-prompt", async (_event, input: NotationPreviewInput): Promise<NotationPromptPreview> => {
    const [storedNotationConfig, promptConfig] = await Promise.all([
      input.config ? Promise.resolve(input.config) : readNotationProfileConfig({ rootDir: notesRootDir() }),
      readPromptTemplateConfig({ rootDir: notesRootDir() })
    ]);
    const notationConfig = input.config ? normalizeNotationProfileConfig(storedNotationConfig) : storedNotationConfig;
    const selection = selectNotationRules(notationConfig, input);
    const promptTemplate = getActivePromptTemplate(promptConfig);
    return {
      selection,
      fullPrompt: buildFaithfulTranscriptionPrompt(undefined, promptTemplate.content, selection)
    };
  });

  ipcMain.handle("mathnotes:save-provider-config", async (_event, input: RecognitionProviderConfigInput) => {
    const config = await writeProviderConfig({
      rootDir: notesRootDir(),
      config: input
    });
    void syncCodexRuntimeWithProviderConfig();
    invalidateRecognitionPipeline();
    void prewarmRecognitionPipeline();
    return config;
  });

  ipcMain.handle("mathnotes:save-assistant-provider-config", async (_event, input: AssistantProviderConfigInput | null) => {
    const config = await writeAssistantProviderConfig({
      rootDir: notesRootDir(),
      config: input
    });
    void syncCodexRuntimeWithProviderConfig();
    return config;
  });

  ipcMain.handle("mathnotes:check-provider-health", async () =>
    checkProviderHealth({
      rootDir: notesRootDir()
    })
  );

  ipcMain.handle("mathnotes:run-provider-self-test", async (_event, input: ProviderSelfTestInput): Promise<ProviderSelfTestResult> => {
    const providerConfig = await readProviderConfig({ rootDir: notesRootDir() });
    if (providerConfig.providerId !== "mock" && !input.confirmedExternalCall) {
      throw new Error("必须明确确认本次单图自检将调用当前识别服务 1 次。");
    }
    const provider = await createRecognitionProviderForCurrentRuntime();
    const report = await runProviderTurnAcceptance({
      outputRoot: path.join(app.getPath("userData"), "diagnostics", "provider-self-tests"),
      imagePath: input.imagePath,
      provider,
      providerConfig,
      now: new Date().toISOString()
    });
    latestProviderSelfTest = {
      providerId: providerConfig.providerId,
      providerLabel: report.provider.label,
      model: report.provider.model,
      status: report.result.status,
      failureKind: report.result.failureKind,
      warningCount: report.stream.warningCount,
      eventCount: report.stream.eventCount,
      previewUpdateCount: report.stream.previewUpdateCount,
      elapsedMs: report.timing.elapsedMs,
      firstTokenMs: report.timing.firstTokenMs,
      reportPath: report.artifacts.reportPath,
      exportPath: report.artifacts.exportPath
    };
    return latestProviderSelfTest;
  });

  ipcMain.handle(
    "mathnotes:export-user-diagnostic-report",
    async (event, input?: ExportUserDiagnosticReportInput): Promise<ExportUserDiagnosticReportResult> => {
      const providerConfig = await readProviderConfig({ rootDir: notesRootDir() });
      const providerHealth = await checkProviderHealth({ rootDir: notesRootDir() });
      const report = buildUserDiagnosticReport({
        generatedAt: new Date().toISOString(),
        application: {
          name: app.getName(),
          version: app.getVersion(),
          packaged: app.isPackaged
        },
        system: {
          platform: process.platform,
          architecture: process.arch,
          node: process.versions.node,
          electron: process.versions.electron ?? "",
          chrome: process.versions.chrome ?? ""
        },
        providerConfig,
        providerHealth,
        credentialConfigured: hasConfiguredProviderCredential(providerConfig, process.env),
        runtime: codexRuntimeManager.getState(),
        receiver: ingestState,
        latestSelfTest: latestProviderSelfTest
      });
      let outputPath = input?.outputPath;
      if (!outputPath) {
        const browserWindow = BrowserWindow.fromWebContents(event.sender);
        const defaultName = `MathNotes-diagnostics-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
        const selection = browserWindow
          ? await dialog.showSaveDialog(browserWindow, { defaultPath: path.join(app.getPath("documents"), defaultName), filters: [{ name: "JSON", extensions: ["json"] }] })
          : await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("documents"), defaultName), filters: [{ name: "JSON", extensions: ["json"] }] });
        if (selection.canceled || !selection.filePath) return { cancelled: true };
        outputPath = selection.filePath;
      }
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return { cancelled: false, outputPath, report };
    }
  );

  ipcMain.handle("mathnotes:load-codex-runtime-state", () => codexRuntimeManager.getState());

  ipcMain.handle("mathnotes:start-codex-runtime", async () => {
    const config = await effectiveCodexProviderConfig();
    return config ? codexRuntimeManager.ensureStarted(config) : codexRuntimeManager.stop();
  });

  ipcMain.handle("mathnotes:stop-codex-runtime", () => {
    codexRuntimeManager.stop();
    return codexRuntimeManager.getState();
  });

  ipcMain.handle("mathnotes:load-recognition-tasks", async (_event, input: LoadRecognitionTasksInput) =>
    readRecognitionTaskSummaries({
      rootDir: notesRootDir(),
      notebookId: input.notebookId,
      sessionId: input.sessionId
    })
  );

  ipcMain.handle("mathnotes:retry-recognition-task", async (_event, input: RetryRecognitionTaskInput) => {
    const store = await ensureDefaultStore();
    const abortController = new AbortController();
    activeRecognitionCancels.set(input.recognitionJobId, () => abortController.abort());
    try {
      const job = await retryRecognitionJob({
        rootDir: notesRootDir(),
        store,
        provider: await createRecognitionProviderForCurrentRuntime(),
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        jobId: input.recognitionJobId,
        now: new Date().toISOString(),
        abortSignal: abortController.signal,
        onJobChanged: notifyRecognitionJobChanged,
        onRuntimeEvent: notifyRecognitionRuntimeEvent
      });
      return recognitionJobToTaskSummary(job);
    } finally {
      activeRecognitionCancels.delete(input.recognitionJobId);
    }
  });

  ipcMain.handle("mathnotes:cancel-recognition-task", async (_event, input: CancelRecognitionTaskInput) => {
    const cancel = activeRecognitionCancels.get(input.recognitionJobId);
    if (!cancel) {
      throw new Error(`当前没有正在运行的识别任务：${input.recognitionJobId}`);
    }
    cancel();
    activeRecognitionCancels.delete(input.recognitionJobId);
    const task = await waitForRecognitionTaskSummary(input);
    return task ?? {
      id: input.recognitionJobId,
      fileName: input.recognitionJobId,
      assetPath: "",
      recognitionJobId: input.recognitionJobId,
      recognitionStatus: "cancelled",
      imageBlockId: "-",
      transcriptBlockId: "-",
      receivedAt: new Date().toISOString(),
      error: "用户已中断识别。"
    };
  });

  ipcMain.handle("mathnotes:create-session", async (_event, input: CreateSessionInput | undefined) => {
    const store = await ensureDefaultStore();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const notebookId = input?.notebookId?.trim() || defaultNotebookId;
    const sessionId = await createUniqueSessionId(store, notebookId, nowDate);
    await store.createSession({
      notebookId,
      sessionId,
      title: input?.title?.trim() || "未命名",
      now
    });
    await store.appendMarkdownBlock({
      notebookId,
      sessionId,
      source: "user",
      markdown: [
        "## 新 Session",
        "",
        "这里开始整理本次课堂、讨论或阅读笔记。"
      ].join("\n"),
      now
    });
    currentNotebookId = notebookId;
    currentSessionId = sessionId;
    await persistCurrentWorkspaceContext();
    ingestServer?.publishCompanionCatalogChange("created", notebookId, sessionId);
    return loadSessionDocumentFromStore({
      store,
      notebookId,
      sessionId
    });
  });

  ipcMain.handle("mathnotes:run-assistant-task", async (_event, input: RunAssistantTaskInput) => {
    if (activeAssistantCancels.has(input.taskId)) {
      throw new Error(`学习助手任务已在运行：${input.taskId}`);
    }
    const settings = await ensureUserSettings();
    if (!settings.assistantOnlineEnabled) {
      throw new Error("学习助手在线调用已在设置中关闭。");
    }
    const store = await ensureDefaultStore();
    const controller = new AbortController();
    activeAssistantCancels.set(input.taskId, () => controller.abort());
    try {
      const result = await runAssistantTask({
        store,
        provider: await createAssistantProviderForCurrentRuntime(),
        input: { ...input, abortSignal: controller.signal },
        onRuntimeEvent: (runtimeEvent) => notifyAssistantRuntimeEvent(runtimeEvent, input)
      });
      ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
      return result;
    } finally {
      activeAssistantCancels.delete(input.taskId);
    }
  });

  ipcMain.handle("mathnotes:cancel-assistant-task", async (_event, input: CancelAssistantTaskInput) => {
    const cancel = activeAssistantCancels.get(input.taskId);
    if (!cancel) return { taskId: input.taskId, cancelled: false };
    cancel();
    return { taskId: input.taskId, cancelled: true };
  });

  ipcMain.handle("mathnotes:load-assistant-remarks", async (_event, input: { notebookId: string; sessionId: string }) => {
    const store = await ensureDefaultStore();
    return new AssistantRemarkStore(store).list(input.notebookId, input.sessionId);
  });

  ipcMain.handle("mathnotes:promote-assistant-remark", async (_event, input: { notebookId: string; sessionId: string; remarkId: string }) => {
    const store = await ensureDefaultStore();
    const remarkStore = new AssistantRemarkStore(store);
    const remark = await remarkStore.get(input);
    if (!remark) throw new Error(`学习旁注不存在：${input.remarkId}`);
    await store.appendMarkdownBlock({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      source: "ai_explanation",
      markdown: remark.markdown,
      insertAfterBlockId: remark.sourceBlockIds.at(-1),
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({ store, notebookId: input.notebookId, sessionId: input.sessionId });
  });

  ipcMain.handle("mathnotes:delete-assistant-remark", async (_event, input: { notebookId: string; sessionId: string; remarkId: string }) => {
    const store = await ensureDefaultStore();
    return { deleted: await new AssistantRemarkStore(store).remove(input) };
  });

  ipcMain.handle("mathnotes:create-notebook", async (_event, input: CreateNotebookInput) => {
    const store = await ensureDefaultStore();
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const notebookId = await createUniqueNotebookId(nowDate);
    await createNotebook({
      rootDir: notesRootDir(),
      notebookId,
      title: input.title.trim() || "未命名笔记本",
      now
    });
    const sessionId = await createUniqueSessionId(store, notebookId, nowDate);
    await store.createSession({ notebookId, sessionId, title: "未命名", now });
    await store.appendMarkdownBlock({
      notebookId,
      sessionId,
      source: "user",
      markdown: "## 新 Session\n\n这里开始整理本次课堂、讨论或阅读笔记。",
      now
    });
    currentNotebookId = notebookId;
    currentSessionId = sessionId;
    await persistCurrentWorkspaceContext();
    ingestServer?.publishCompanionCatalogChange("created", notebookId, sessionId);
    return loadSessionDocumentFromStore({ store, notebookId, sessionId });
  });

  ipcMain.handle("mathnotes:create-markdown-block", async (_event, input: CreateMarkdownBlockInput) => {
    const store = await ensureDefaultStore();
    await store.appendMarkdownBlock({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      source: "user",
      markdown: input.markdown ?? "## 新文本块\n\n在这里继续整理笔记。",
      sourceName: input.sourceName,
      insertAfterBlockId: input.insertAfterBlockId,
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store,
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:propose-selection-edit", async (_event, input: ProposeSelectionEditInput) => {
    await ensureDefaultStore();
    return ensureSelectionEditService().propose({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      blockId: input.blockId,
      selection: { from: input.from, to: input.to, selectedText: input.selectedText },
      instruction: input.instruction
    });
  });

  ipcMain.handle("mathnotes:apply-selection-edit", async (_event, input: SelectionEditProposalCommand) => {
    await ensureDefaultStore();
    await ensureSelectionEditService().apply(input);
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store: await ensureDefaultStore(),
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:cancel-selection-edit", async (_event, input: SelectionEditProposalCommand) => {
    await ensureDefaultStore();
    return ensureSelectionEditService().cancel(input);
  });

  ipcMain.handle("mathnotes:save-markdown-block", async (_event, input: { notebookId: string; sessionId: string; blockId: string; markdown: string }) => {
    const store = await ensureDefaultStore();
    await store.updateMarkdownBlock({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      blockId: input.blockId,
      markdown: input.markdown,
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store,
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:save-session-source", async (_event, input: { notebookId: string; sessionId: string; sourceText: string }) => {
    const store = await ensureDefaultStore();
    const updates = parseSessionSourceText(input.sourceText);
    await store.updateMarkdownBlocks({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      updates,
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store,
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:set-markdown-block-lock", async (_event, input: SetMarkdownBlockLockInput) => {
    const store = await ensureDefaultStore();
    await store.setMarkdownBlockLock({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      blockId: input.blockId,
      locked: input.locked,
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store,
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:delete-markdown-block", async (_event, input: DeleteMarkdownBlockInput) => {
    const store = await ensureDefaultStore();
    const undo = await store.deleteMarkdownBlock({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      blockId: input.blockId,
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return {
      document: await loadSessionDocumentFromStore({
        store,
        notebookId: input.notebookId,
        sessionId: input.sessionId
      }),
      undo
    };
  });

  ipcMain.handle("mathnotes:restore-deleted-markdown-block", async (_event, input: RestoreDeletedMarkdownBlockInput) => {
    const store = await ensureDefaultStore();
    await store.restoreDeletedMarkdownBlock({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      snapshot: input.snapshot,
      now: new Date().toISOString()
    });
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store,
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:reorder-session-blocks", async (_event, input: ReorderSessionBlocksInput) => {
    const service = ensureBlockOrganizeService();
    await service.reorder(input);
    ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
    return loadSessionDocumentFromStore({
      store: await ensureDefaultStore(),
      notebookId: input.notebookId,
      sessionId: input.sessionId
    });
  });

  ipcMain.handle("mathnotes:transfer-session-blocks", async (_event, input: TransferSessionBlocksInput) => {
    const result = await ensureBlockOrganizeService().transfer(input);
    ingestServer?.publishCompanionChange(input.targetNotebookId, input.targetSessionId);
    if (input.mode === "move" && !result.sourceCleanupPending) {
      ingestServer?.publishCompanionChange(input.sourceNotebookId, input.sourceSessionId);
    }
    return {
      document: await loadSessionDocumentFromStore({
        store: await ensureDefaultStore(),
        notebookId: input.sourceNotebookId,
        sessionId: input.sourceSessionId
      }),
      copiedBlockIds: result.copiedBlockIds,
      sourceCleanupPending: result.sourceCleanupPending
    };
  });

  ipcMain.handle("mathnotes:export-current-session", async (_event, input: ExportCurrentSessionInput) =>
    exportSessionMarkdown({
      rootDir: notesRootDir(),
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      includeMetadataComments: input.includeMetadataComments,
      defaultExportDir: (await ensureUserSettings()).defaultExportDir,
      packageMode: input.packageMode,
      includeAssistantRemarks: input.includeAssistantRemarks
    })
  );

  ipcMain.handle("mathnotes:reveal-path", async (_event, input: RevealPathInput) => {
    shell.showItemInFolder(input.path);
    return { path: input.path };
  });

  ipcMain.handle("mathnotes:pick-directory", async (event, input: PickDirectoryInput | undefined): Promise<PickDirectoryResult> => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      defaultPath: input?.defaultPath || notesRootDir(),
      properties: ["openDirectory", "createDirectory"],
      title: input?.title ?? "选择文件夹"
    };
    const result = browserWindow ? await dialog.showOpenDialog(browserWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || !result.filePaths[0]) {
      return { cancelled: true };
    }
    return {
      cancelled: false,
      path: result.filePaths[0]
    };
  });

  ipcMain.handle("mathnotes:create-notes-backup", async (event): Promise<CreateNotesBackupResult> => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: OpenDialogOptions = {
      title: "选择笔记备份保存位置",
      defaultPath: cachedUserSettings?.defaultExportDir || path.dirname(notesRootDir()),
      properties: ["openDirectory", "createDirectory"]
    };
    const selection = browserWindow
      ? await dialog.showOpenDialog(browserWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };

    return {
      cancelled: false,
      ...await createNotesBackup({
        notesRootDir: notesRootDir(),
        destinationParentDir: selection.filePaths[0],
        appVersion: app.getVersion()
      })
    };
  });

  ipcMain.handle("mathnotes:window-control", (event, action: WindowControlAction) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error("No Electron window is attached to this renderer");
    }

    if (action === "minimize") {
      window.minimize();
      return { action };
    }

    if (action === "toggleMaximize") {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
      return { action, maximized: window.isMaximized() };
    }

    if (action === "close") {
      approvedWindowCloses.add(window);
      window.close();
      return { action };
    }

    throw new Error(`Unsupported window control action: ${action}`);
  });

  ipcMain.handle("mathnotes:begin-window-drag", (event, input: WindowDragInput) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isMaximized()) return;
    const [startWindowX, startWindowY] = window.getPosition();
    windowDragSessions.set(window, {
      startScreenX: input.screenX,
      startScreenY: input.screenY,
      startWindowX,
      startWindowY
    });
  });

  ipcMain.handle("mathnotes:update-window-drag", (event, input: WindowDragInput) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    const drag = windowDragSessions.get(window);
    if (!drag) return;
    window.setPosition(
      Math.round(drag.startWindowX + input.screenX - drag.startScreenX),
      Math.round(drag.startWindowY + input.screenY - drag.startScreenY),
      false
    );
  });

  ipcMain.handle("mathnotes:end-window-drag", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) windowDragSessions.delete(window);
  });

  ipcMain.handle("mathnotes:import-local-photo", async (event, input: LocalPhotoImportInput): Promise<LocalPhotoImportResult> => {
    const selectedPath = input.filePath ?? (await pickLocalPhotoPath(event));
    if (!selectedPath) {
      return { cancelled: true };
    }

    const store = await ensureDefaultStore();
    const bytes = await readFile(selectedPath);
    const pipeline = await getActiveRecognitionPipeline(store);
    const result = await pipeline.ingestPhoto({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      originalName: path.basename(selectedPath),
      mimeType: detectLocalPhotoMimeType(selectedPath),
      bytes,
      captureId: `local_${Date.now()}`,
      deviceId: "windows_local_import",
      insertAfterBlockId: input.insertAfterBlockId,
      receivedAt: new Date().toISOString()
    });

    return {
      cancelled: false,
      uploadId: result.uploadId,
      duplicate: result.duplicate,
      assetPath: result.assetPath,
      imageBlockId: result.imageBlockId,
      transcriptBlockId: result.transcriptBlockId,
      recognitionJobId: result.recognitionJobId,
      recognitionStatus: result.recognitionStatus
    };
  });

  ipcMain.handle("mathnotes:import-embedded-image", async (event, input: EmbeddedImageImportInput): Promise<EmbeddedImageImportResult> => {
    const selectedPath = input.filePath ?? (await pickLocalPhotoPath(event, "插入图片到当前 Markdown 块"));
    if (!selectedPath) {
      return { cancelled: true };
    }

    const store = await ensureDefaultStore();
    const saved = await store.saveEmbeddedAsset({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      fileName: path.basename(selectedPath),
      bytes: await readFile(selectedPath)
    });

    return {
      cancelled: false,
      assetPath: saved.relativePath,
      markdown: `![图](../${saved.relativePath.replace(/\\/g, "/")})`
    };
  });

  ipcMain.handle("mathnotes:pick-image-for-annotation", async (event, input?: PickImageForAnnotationInput): Promise<PickImageForAnnotationResult> => {
    const selectedPath = input?.filePath ?? (await pickLocalPhotoPath(event, "编辑并插入图片"));
    if (!selectedPath) {
      return { cancelled: true };
    }

    return {
      cancelled: false,
      fileName: path.basename(selectedPath),
      sourcePath: selectedPath,
      previewDataUrl: await imagePathToDataUrl(selectedPath)
    };
  });

  ipcMain.handle("mathnotes:save-annotated-image", async (_event, input: SaveAnnotatedImageInput): Promise<SaveAnnotatedImageResult> => {
    const store = await ensureDefaultStore();
    const sourceBytes = await readFile(input.sourcePath);
    const saved = await store.saveAnnotatedImageAsset({
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      fileName: input.fileName,
      pngBytes: decodePngDataUrl(input.pngDataUrl),
      metadata: {
        version: 1,
        sourceAsset: path.basename(input.sourcePath),
        sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
        outputMimeType: "image/png",
        operations: input.operations,
        annotations: input.annotations,
        createdAt: input.createdAt ?? new Date().toISOString()
      }
    });

    return {
      assetPath: saved.relativePath,
      metadataPath: saved.metadataRelativePath,
      markdown: markdownForEmbeddedAsset(saved.relativePath)
    };
  });

  ipcMain.handle("mathnotes:load-ingest-server-state", async () => refreshDevicePairingChallengeInternal(false));

  ipcMain.handle("mathnotes:start-ingest-server", async () => startIngestServerInternal());

  ipcMain.handle("mathnotes:pick-local-pdf", async (event, input: PickLocalPdfInput | undefined): Promise<PickLocalPdfResult> => {
    const selectedPath = input?.filePath ?? (await pickLocalPdfPath(event));
    if (!selectedPath) {
      return { cancelled: true };
    }

    const bytes = await readFile(selectedPath);
    const info = await readPdfDocumentInfo(bytes);
    return {
      cancelled: false,
      sourcePath: selectedPath,
      fileName: path.basename(selectedPath),
      byteLength: bytes.byteLength,
      pageCount: info.pageCount
    };
  });

  ipcMain.handle("mathnotes:import-local-pdf", async (_event, input: ImportLocalPdfInput): Promise<ImportLocalPdfResult> => {
    const store = await ensureDefaultStore();
    const bytes = await readFile(input.sourcePath);
    const info = await readPdfDocumentInfo(bytes);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    let sessionId = input.sessionId;

    if (input.destination === "new_session") {
      sessionId = await createUniqueSessionId(store, input.notebookId, nowDate);
      await store.createSession({
        notebookId: input.notebookId,
        sessionId,
        title: input.newSessionTitle?.trim() || path.basename(input.sourcePath, path.extname(input.sourcePath)),
        now
      });
    }

    const saved = await store.savePdfAsset({
      notebookId: input.notebookId,
      sessionId,
      fileName: path.basename(input.sourcePath),
      bytes
    });
    const block = await store.appendPdfBlock({
      notebookId: input.notebookId,
      sessionId,
      assetPath: saved.relativePath,
      sourceName: path.basename(input.sourcePath),
      pageCount: info.pageCount,
      renderInNote: input.mode === "read_only",
      insertAfterBlockId: input.destination === "current_session" ? input.insertAfterBlockId : undefined,
      now
    });

    currentNotebookId = input.notebookId;
    currentSessionId = sessionId;
    await persistCurrentWorkspaceContext();
    ingestServer?.publishCompanionChange(input.notebookId, sessionId);
    return {
      document: await loadSessionDocumentFromStore({ store, notebookId: input.notebookId, sessionId }),
      pdfBlockId: block.id,
      assetPath: saved.relativePath,
      pageCount: info.pageCount,
      recognitionQueued: false
    };
  });

  ipcMain.handle(
    "mathnotes:stage-pdf-recognition-page",
    async (_event, input: StagePdfRecognitionPageInput): Promise<StagePdfRecognitionPageResult> => {
      const store = await ensureDefaultStore();
      const saved = await store.savePdfPageAsset({
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        pdfBlockId: input.pdfBlockId,
        pageNumber: input.pageNumber,
        fileName: `page-${input.pageNumber}.png`,
        bytes: decodePngDataUrl(input.pngDataUrl)
      });
      return { pageNumber: input.pageNumber, assetPath: saved.relativePath, imagePath: saved.absolutePath };
    }
  );

  ipcMain.handle(
    "mathnotes:start-pdf-recognition-batch",
    async (_event, input: StartPdfRecognitionBatchInput): Promise<StartPdfRecognitionBatchResult> => {
      const store = await ensureDefaultStore();
      const runner = await createPdfRecognitionRunner(store, input.concurrency);
      const batch = await runner.prepare({
        notebookId: input.notebookId,
        sessionId: input.sessionId,
        pdfBlockId: input.pdfBlockId,
        pdfAssetPath: input.pdfAssetPath,
        pageCount: input.pageCount,
        pages: input.pages,
        now: new Date().toISOString()
      });
      launchPdfRecognitionBatch({ runner, batch, status: "running" });
      return {
        batchId: batch.batchId,
        jobIds: batch.jobIds,
        document: await loadSessionDocumentFromStore({ store, notebookId: input.notebookId, sessionId: input.sessionId })
      };
    }
  );

  ipcMain.handle(
    "mathnotes:pause-pdf-recognition-batch",
    async (_event, input: PdfRecognitionBatchControlInput): Promise<PdfRecognitionBatchControlResult> => {
      const runtime = activePdfRecognitionBatches.get(input.batchId);
      if (!runtime) throw new Error("PDF 识别批次当前未运行");
      runtime.status = "pausing";
      runtime.runner.pause();
      return { batchId: input.batchId, status: "pausing" };
    }
  );

  ipcMain.handle(
    "mathnotes:resume-pdf-recognition-batch",
    async (_event, input: PdfRecognitionBatchControlInput): Promise<PdfRecognitionBatchControlResult> => {
      let runtime = activePdfRecognitionBatches.get(input.batchId);
      if (runtime?.status === "running" || runtime?.status === "pausing") {
        return { batchId: input.batchId, status: "running" };
      }
      if (!runtime) {
        const store = await ensureDefaultStore();
        const runner = await createPdfRecognitionRunner(store, 2);
        const batch = await runner.restore(input);
        runtime = { runner, batch, status: "paused" };
      }
      launchPdfRecognitionBatch(runtime);
      return { batchId: input.batchId, status: "running" };
    }
  );

  ipcMain.handle(
    "mathnotes:cancel-pdf-recognition-batch",
    async (_event, input: PdfRecognitionBatchControlInput): Promise<PdfRecognitionBatchControlResult> => {
      let runtime = activePdfRecognitionBatches.get(input.batchId);
      if (!runtime) {
        const store = await ensureDefaultStore();
        const runner = await createPdfRecognitionRunner(store, 2);
        runtime = { runner, batch: await runner.restore(input), status: "paused" };
      }
      runtime.runner.cancelBatch(runtime.batch);
      activePdfRecognitionBatches.delete(input.batchId);
      ingestServer?.publishCompanionChange(input.notebookId, input.sessionId);
      return { batchId: input.batchId, status: "cancelled" };
    }
  );

  ipcMain.handle("mathnotes:set-ingest-display-host", async (_event, host: string | null) => {
    if (!ingestServer || !ingestState.running || !ingestState.port || !ingestState.token) {
      throw new Error("接收服务尚未启动");
    }
    if (host) {
      const candidate = ingestState.addressCandidates?.find((entry) => entry.address === host);
      if (!candidate || !isUsableIngestHost(candidate)) {
        throw new Error("所选地址不是手机可用的私有网络地址");
      }
    }
    await writeIngestIdentity(app.getPath("userData"), {
      version: 1,
      token: ingestState.token,
      port: ingestState.port,
      ...(host ? { preferredHost: host } : {})
    });
    ingestState = {
      ...ingestState,
      preferredHost: host ?? undefined
    };
    return refreshIngestAddressState();
  });

  ipcMain.handle("mathnotes:refresh-ingest-addresses", async () => refreshIngestAddressState());

  ipcMain.handle("mathnotes:refresh-device-pairing", async () => refreshDevicePairingChallengeInternal(true));

  ipcMain.handle("mathnotes:revoke-paired-device", async (_event, deviceId: string) => {
    return revokePairedDeviceInternal(deviceId);
  });

  ipcMain.handle("mathnotes:update-pairing-token", async (_event, input: UpdatePairingTokenInput) => {
    return updatePairingTokenInternal(input);
  });

  ipcMain.handle("mathnotes:stop-ingest-server", async () => stopIngestServerInternal());
}

async function pickLocalPhotoPath(event: IpcMainInvokeEvent, title = "导入本机照片"): Promise<string | undefined> {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const dialogOptions: OpenDialogOptions = {
    title,
    properties: ["openFile"],
    filters: [
      {
        name: "Images",
        extensions: ["jpg", "jpeg", "png", "webp"]
      }
    ]
  };
  const selection = browserWindow
    ? await dialog.showOpenDialog(browserWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  return selection.canceled ? undefined : selection.filePaths[0];
}

async function createRecognitionProviderForCurrentRuntime() {
  const providerConfig = await readProviderConfig({ rootDir: notesRootDir() });
  const runtimeState =
    providerConfig.providerId === "codex_cli" ? await codexRuntimeManager.ensureStarted(providerConfig) : codexRuntimeManager.getState();
  return createRecognitionProviderFromConfig({
    rootDir: notesRootDir(),
    codexRuntimeEndpoint: runtimeState.status === "ready" ? runtimeState.endpoint : undefined,
    allowMockProvider: !app.isPackaged || process.env.MATHNOTES_ALLOW_MOCK_PROVIDER === "1"
  });
}

async function createAssistantProviderForCurrentRuntime() {
  const [recognitionConfig, assistantConfig] = await Promise.all([
    readProviderConfig({ rootDir: notesRootDir() }),
    readAssistantProviderConfig({ rootDir: notesRootDir() })
  ]);
  const codexConfig =
    recognitionConfig.providerId === "codex_cli"
      ? recognitionConfig
      : assistantConfig.providerId === "codex_cli"
        ? assistantConfig
        : null;
  const runtimeState = codexConfig ? await codexRuntimeManager.ensureStarted(codexConfig) : codexRuntimeManager.getState();
  return createAssistantProviderFromConfig({
    rootDir: notesRootDir(),
    codexRuntimeEndpoint: runtimeState.status === "ready" ? runtimeState.endpoint : undefined,
    allowMockProvider: !app.isPackaged || process.env.MATHNOTES_ALLOW_MOCK_PROVIDER === "1"
  });
}

async function createActiveRecognitionPipeline(store: BlockStore): Promise<PhotoIngestPipeline> {
  const provider = await createRecognitionProviderForCurrentRuntime();
  let queue: RecognitionQueue;
  queue = new RecognitionQueue({
    provider,
    writer: new BlockWriter(store),
    buildContext: (job) => buildRecognitionContextForJob(store, job),
    onJobChanged: (job) => {
      if (job.status === "running") {
        activeRecognitionCancels.set(job.id, () => queue.cancel(job.id));
      } else {
        activeRecognitionCancels.delete(job.id);
      }
      return upsertRecognitionJob({
        rootDir: store.getRootDir(),
        job
      }).then(() => notifyRecognitionJobChanged(job));
    },
    onRuntimeEvent: notifyRecognitionRuntimeEvent
  });

  return new PhotoIngestPipeline({
    store,
    provider,
    queue,
    onIngested: notifyUploadCompleted
  });
}

function notifyUploadCompleted(result: IngestPhotoResult): void {
  const event: UploadCompletedEvent = {
    uploadId: result.uploadId,
    duplicate: result.duplicate,
    assetPath: result.assetPath,
    imageBlockId: result.imageBlockId,
    transcriptBlockId: result.transcriptBlockId,
    recognitionJobId: result.recognitionJobId,
    recognitionStatus: result.recognitionStatus
  };

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("mathnotes:upload-completed", event);
  }
}

function notifyRecognitionJobChanged(job: RecognitionJob): void {
  const event: RecognitionJobChangedEvent = recognitionJobToTaskSummary(job);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("mathnotes:recognition-job-changed", event);
  }
  ingestServer?.publishCompanionChange(job.notebookId, job.sessionId, job.now);
}

function invalidateRecognitionPipeline(): void {
  recognitionPipelineGeneration += 1;
  activeRecognitionPipeline = undefined;
}

async function getActiveRecognitionPipeline(store: BlockStore): Promise<PhotoIngestPipeline> {
  const rootDir = store.getRootDir();
  const cached = activeRecognitionPipeline;
  if (cached && cached.rootDir === rootDir && cached.generation === recognitionPipelineGeneration) {
    return cached.promise;
  }

  const generation = recognitionPipelineGeneration;
  const promise = createActiveRecognitionPipeline(store).catch((error) => {
    if (activeRecognitionPipeline?.promise === promise) {
      activeRecognitionPipeline = undefined;
    }
    throw error;
  });
  activeRecognitionPipeline = { rootDir, generation, promise };
  return promise;
}

async function prewarmRecognitionPipeline(): Promise<void> {
  try {
    const store = await ensureDefaultStore();
    await getActiveRecognitionPipeline(store);
  } catch (error) {
    notifyRecognitionPipelineWarmupFailed(error);
  }
}

function notifyRecognitionPipelineWarmupFailed(error: unknown): void {
  console.warn(`Recognition pipeline warmup failed: ${errorMessage(error)}`);
}

async function startIngestServerInternal(tokenOverride?: string): Promise<IngestServerState> {
  if (ingestServer) {
    return refreshDevicePairingChallengeInternal(false);
  }

  const store = await ensureDefaultStore();
  const identityRoot = app.getPath("userData");
  const persistedIdentity = await readIngestIdentity(identityRoot);
  const deviceIdentities = await ensureDeviceIdentityService(identityRoot);
  const addressCandidates = listIPv4AddressCandidates();
  const displayHost = choosePreferredIngestHost(addressCandidates, persistedIdentity?.preferredHost);
  const transportKind = addressCandidates.find((candidate) => candidate.address === displayHost)?.transportKind;
  const listenHost = "0.0.0.0";
  const token = tokenOverride ?? persistedIdentity?.token ?? new PairingManager().createPairingSession({
    host: displayHost,
    port: 0,
    now: new Date().toISOString()
  }).token;

  let candidate = createIngestServer(store, token, persistedIdentity?.port ?? 0, deviceIdentities);
  let started;
  try {
    started = await candidate.start();
  } catch (error) {
    if (!persistedIdentity || !isAddressInUse(error)) throw error;
    candidate = createIngestServer(store, token, 0, deviceIdentities);
    started = await candidate.start();
  }

  try {
    await writeIngestIdentity(identityRoot, {
      version: 1,
      token,
      port: started.port,
      ...(persistedIdentity?.preferredHost ? { preferredHost: persistedIdentity.preferredHost } : {})
    });
  } catch (error) {
    await candidate.stop().catch(() => undefined);
    throw error;
  }

  ingestServer = candidate;
  const pairing = new PairingManager().createPairingSession({
    host: displayHost,
    hosts: addressCandidates.filter(isUsableIngestHost).map((candidate) => candidate.address),
    port: started.port,
    token,
    now: new Date().toISOString()
  });
  ingestState = {
    running: true,
    host: displayHost,
    listenHost,
    displayHost,
    preferredHost: persistedIdentity?.preferredHost,
    transportKind,
    port: started.port,
    url: `http://${displayHost}:${started.port}`,
    token,
    pairingPayload: pairing.payload,
    rootDir: notesRootDir(),
    addressCandidates
  };
  await refreshDevicePairingChallengeInternal(true);
  void prewarmRecognitionPipeline();
  return ingestState;
}

async function refreshDevicePairingChallengeInternal(force: boolean): Promise<IngestServerState> {
  if (!ingestServer || !ingestState.running || !ingestState.port) return ingestState;
  const remainingMs = activeDevicePairingChallenge
    ? Date.parse(activeDevicePairingChallenge.expiresAt) - Date.now()
    : 0;
  if (force || remainingMs <= 30_000) {
    activeDevicePairingChallenge = await ingestServer.createDevicePairingChallenge();
  }
  const identities = await deviceIdentityService?.listDevices() ?? [];
  refreshIngestAddressState();
  ingestState = {
    ...ingestState,
    pairedDevices: identities
      .filter((device) => !device.revokedAt)
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        scopes: [...device.scopes],
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt
      }))
  };
  return ingestState;
}

async function revokePairedDeviceInternal(deviceId: string): Promise<IngestServerState> {
  if (!deviceIdentityService || !ingestServer) throw new Error("接收服务尚未启动");
  const revoked = await deviceIdentityService.revokeDevice(deviceId);
  if (!revoked) throw new Error("设备不存在或已经撤销");
  return refreshDevicePairingChallengeInternal(false);
}

async function stopIngestServerInternal(): Promise<IngestServerState> {
  await ingestServer?.stop();
  ingestServer = undefined;
  activeDevicePairingChallenge = undefined;
  ingestState = {
    running: false,
    rootDir: notesRootDir()
  };
  return ingestState;
}

async function updatePairingTokenInternal(input: UpdatePairingTokenInput): Promise<IngestServerState> {
  const token = validatePairingTokenUpdate(input);
  const identityRoot = app.getPath("userData");
  const persistedIdentity = await readIngestIdentity(identityRoot);
  const previousToken = ingestState.token ?? persistedIdentity?.token;

  if (previousToken === token) {
    return ingestServer ? refreshIngestAddressState() : startIngestServerInternal(token);
  }

  await stopIngestServerInternal();
  try {
    return await startIngestServerInternal(token);
  } catch (error) {
    if (previousToken) {
      await startIngestServerInternal(previousToken).catch((rollbackError) => {
        console.error(`Pairing token rollback failed: ${errorMessage(rollbackError)}`);
      });
    }
    throw error;
  }
}

async function ensureDeviceIdentityService(identityRoot: string): Promise<DeviceIdentityService> {
  if (deviceIdentityService) return deviceIdentityService;
  const service = new DeviceIdentityService({
    filePath: path.join(identityRoot, "device-identities.json")
  });
  await service.start();
  deviceIdentityService = service;
  return service;
}

function createIngestServer(
  store: BlockStore,
  token: string,
  port: number,
  deviceIdentities: DeviceIdentityService
): IngestServer {
  const pdfPipeline = new PdfIngestPipeline({ store, onIngested: notifyPdfUploadCompleted });
  return new IngestServer({
    host: "0.0.0.0",
    port,
    token,
    deviceIdentityService: deviceIdentities,
    getActivePairingTarget: () => ({
      notebookId: currentNotebookId,
      sessionId: currentSessionId,
      title: currentSessionId
    }),
    getPairingTargets: () => listAllPairingTargets(),
    getCompanionSession: (notebookId, sessionId) => buildCompanionSessionSnapshot({ store, notebookId, sessionId }),
    getCompanionAsset: (notebookId, sessionId, assetPath) =>
      readCompanionAsset({ store, notebookId, sessionId, assetPath }),
    createPipeline: async () => getActiveRecognitionPipeline(store),
    acceptPdf: (input) => pdfPipeline.acceptPdf(input),
    onUploadActivity: notifyCompanionUploadActivity,
    pwaStaticRootDir: bundledPwaStaticRootDir(),
    revisionEventLog: new RevisionEventLog({
      filePath: path.join(app.getPath("userData"), "revision-events.json"),
      maxEvents: 512
    })
  });
}

function notifyCompanionUploadActivity(activity: CompanionUploadActivity): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("mathnotes:companion-upload-activity", activity);
  }
}

function isTrustedAppUrl(candidateUrl: string): boolean {
  return isTrustedRendererUrl({
    candidateUrl,
    devServerUrl,
    distRootDir: rendererDistRootDir
  });
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const rendererUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedAppUrl(rendererUrl)) {
    throw new Error("拒绝来自非受信页面的桌面调用。");
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyPdfUploadCompleted(result: IngestPdfResult): void {
  const event: UploadCompletedEvent = {
    materialType: "pdf",
    uploadId: result.uploadId,
    duplicate: result.duplicate,
    notebookId: result.notebookId,
    sessionId: result.sessionId,
    sourcePath: result.sourcePath,
    inboxPath: result.inboxPath,
    fileName: result.fileName,
    byteLength: result.byteLength,
    pageCount: result.pageCount
  };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("mathnotes:upload-completed", event);
  }
}

async function createPdfRecognitionRunner(store: BlockStore, concurrency: number): Promise<PdfRecognitionBatchRunner> {
  const provider = await createRecognitionProviderForCurrentRuntime();
  let runner!: PdfRecognitionBatchRunner;
  runner = new PdfRecognitionBatchRunner({
    store,
    provider,
    initialConcurrency: concurrency,
    maxConcurrency: 4,
    onJobChanged: async (job) => {
      if (job.status === "running") {
        activeRecognitionCancels.set(job.id, () => runner.cancelJob(job.id));
      } else {
        activeRecognitionCancels.delete(job.id);
      }
      notifyRecognitionJobChanged(job);
    },
    onRuntimeEvent: notifyRecognitionRuntimeEvent
  });
  return runner;
}

function launchPdfRecognitionBatch(runtime: PdfBatchRuntime): void {
  runtime.status = "running";
  activePdfRecognitionBatches.set(runtime.batch.batchId, runtime);
  void runtime.runner
    .run(runtime.batch)
    .then((result) => {
      if (result.status === "paused" && activePdfRecognitionBatches.get(runtime.batch.batchId) === runtime) {
        runtime.status = "paused";
      } else {
        activePdfRecognitionBatches.delete(runtime.batch.batchId);
      }
    })
    .catch((error) => {
      activePdfRecognitionBatches.delete(runtime.batch.batchId);
      console.error("PDF recognition batch failed", error);
    })
    .finally(() => {
      ingestServer?.publishCompanionChange(runtime.batch.notebookId, runtime.batch.sessionId);
    });
}

async function pickLocalPdfPath(event: IpcMainInvokeEvent): Promise<string | undefined> {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const dialogOptions: OpenDialogOptions = {
    title: "导入 PDF",
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  };
  const selection = browserWindow
    ? await dialog.showOpenDialog(browserWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  return selection.canceled ? undefined : selection.filePaths[0];
}

function notifyRecognitionRuntimeEvent(event: CoreRecognitionRuntimeEvent): void {
  const payload: RecognitionRuntimeEvent = {
    id: `${event.job.id}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    recognitionJobId: event.job.id,
    notebookId: event.job.notebookId,
    sessionId: event.job.sessionId,
    level: event.level,
    message: event.message,
    at: new Date().toISOString(),
    transcriptBlockId: event.transcriptBlockId,
    previewChanged: event.previewChanged
  };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("mathnotes:recognition-runtime-event", payload);
  }
  if (event.previewChanged) {
    ingestServer?.publishCompanionChange(event.job.notebookId, event.job.sessionId, payload.at);
  }
}

function notifyAssistantRuntimeEvent(event: AssistantTaskRuntimeEvent, input: RunAssistantTaskInput): void {
  const payload: RecognitionRuntimeEvent = {
    id: `${event.taskId}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    recognitionJobId: event.taskId,
    notebookId: input.notebookId,
    sessionId: input.sessionId,
    level: event.level,
    message: event.message,
    at: event.at,
    previewChanged: event.previewChanged
  };
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("mathnotes:recognition-runtime-event", payload);
  }
  if (event.previewChanged) ingestServer?.publishCompanionChange(input.notebookId, input.sessionId, event.at);
}

function notifyCodexRuntimeStateChanged(state: CoreCodexRuntimeState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("mathnotes:codex-runtime-state-changed", state);
  }
}

async function waitForRecognitionTaskSummary(input: CancelRecognitionTaskInput): Promise<ReturnType<typeof recognitionJobToTaskSummary> | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tasks = await readRecognitionTaskSummaries({
      rootDir: notesRootDir(),
      notebookId: input.notebookId,
      sessionId: input.sessionId,
      limit: 100
    });
    const task = tasks.find((candidate) => candidate.recognitionJobId === input.recognitionJobId);
    if (task && task.recognitionStatus === "cancelled") {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return undefined;
}

async function syncCodexRuntimeWithProviderConfig(): Promise<void> {
  const config = await effectiveCodexProviderConfig();
  if (config) {
    await codexRuntimeManager.ensureStarted(config);
  } else {
    codexRuntimeManager.stop();
  }
}

async function effectiveCodexProviderConfig(): Promise<RecognitionProviderConfig | null> {
  const [recognitionConfig, assistantConfig] = await Promise.all([
    readProviderConfig({ rootDir: notesRootDir() }),
    readAssistantProviderConfig({ rootDir: notesRootDir() })
  ]);
  if (recognitionConfig.providerId === "codex_cli") return recognitionConfig;
  if (!assistantConfig.inherited && assistantConfig.providerId === "codex_cli") return assistantConfig;
  return null;
}

async function ensureDefaultStore(): Promise<BlockStore> {
  await ensureUserSettings();
  const rootDir = notesRootDir();
  if (!defaultStoreInitialization || defaultStoreInitialization.rootDir !== rootDir) {
    const promise = initializeDefaultStore(rootDir).catch((error) => {
      if (defaultStoreInitialization?.rootDir === rootDir) {
        defaultStoreInitialization = undefined;
      }
      throw error;
    });
    defaultStoreInitialization = { rootDir, promise };
  }
  await defaultStoreInitialization.promise;
  return new BlockStore(rootDir);
}

function ensureSelectionEditService(): SessionSelectionEditService {
  const rootDir = notesRootDir();
  if (!selectionEditRuntime || selectionEditRuntime.rootDir !== rootDir) {
    const editor = new SessionEditService(rootDir);
    selectionEditRuntime = {
      rootDir,
      service: new SessionSelectionEditService(
        rootDir,
        () => createAssistantProviderForCurrentRuntime(),
        editor
      )
    };
  }
  return selectionEditRuntime.service;
}

async function initializeDefaultStore(rootDir: string): Promise<void> {
  const store = new BlockStore(rootDir);
  await mkdir(rootDir, { recursive: true });

  try {
    await store.readSession(defaultNotebookId, defaultSessionId);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }

    const now = new Date().toISOString();
    await store.createSession({
      notebookId: defaultNotebookId,
      sessionId: defaultSessionId,
      title: defaultSessionTitle,
      now
    });
    await store.appendMarkdownBlock({
      notebookId: defaultNotebookId,
      sessionId: defaultSessionId,
      source: "user",
      markdown: [
        `## ${defaultSessionTitle}`,
        "",
        "当前 Session 已准备接收上传照片。",
        "打开右下角更多信息，可以启动本机 ingest server。"
      ].join("\n"),
      now
    });
  }

  await ensureDemoContent(store);
  await restoreWorkspaceContext(store, rootDir);
}

async function ensureDemoContent(store: BlockStore): Promise<void> {
  const session = await store.readSession(defaultNotebookId, defaultSessionId);
  if (session.blocks.length !== 1 || session.blocks[0]?.type !== "markdown") {
    return;
  }

  const now = new Date().toISOString();
  const demoPhotoPath = path.join(store.getSessionDir(defaultNotebookId, defaultSessionId), "assets", "photos", "photo_2026-06-26_001.png");
  await mkdir(path.dirname(demoPhotoPath), { recursive: true });
  await writeFile(demoPhotoPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));

  await store.appendImageBlock({
    notebookId: defaultNotebookId,
    sessionId: defaultSessionId,
    assetPath: "assets/photos/photo_2026-06-26_001.png",
    now
  });
  await store.appendMarkdownBlock({
    notebookId: defaultNotebookId,
    sessionId: defaultSessionId,
    source: "ai_transcription",
    fromAssets: ["assets/photos/photo_2026-06-26_001.png"],
    markdown: [
      "#### 推导片段（来自 OCR 草稿）",
      "",
      "设 T_n 为有界线性算子，T_n \\\\to T 强收敛。",
      "若 T 有界，则 \\\\sup_n \\\\|T_n\\\\| < \\\\infty？",
      "（待验证）"
    ].join("\n"),
    now
  });
  await store.appendMarkdownBlock({
    notebookId: defaultNotebookId,
    sessionId: defaultSessionId,
    source: "ai_transcription",
    fromAssets: ["assets/photos/photo_2026-06-26_001.png"],
    markdown: ["```text", "设 T: X -> Y 线性有界，", "||Tx||_Y <= C ||x||_X,   C > 0", "||T|| = sup ||Tx||_Y,", "        ||x||_X <= 1", "```"].join("\n"),
    now
  });
  await store.appendMarkdownBlock({
    notebookId: defaultNotebookId,
    sessionId: defaultSessionId,
    source: "user_revision",
    markdown: "注意常数记号的一致性：这里将有界常数记为 C，coercivity 常数记为 \\\\alpha。\n同时 \\\\|T\\\\| = \\\\sup_{\\\\|x\\\\|=1}\\\\|Tx\\\\| 更简洁。",
    now
  });
}

async function createUniqueSessionId(store: BlockStore, notebookId: string, now: Date): Promise<string> {
  const baseId = createSessionId(now);
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? baseId : `${baseId}_${index + 1}`;
    try {
      await store.readSession(notebookId, candidate);
    } catch (error) {
      if (isMissingFile(error)) {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error(`Unable to create a unique session id for ${baseId}`);
}

async function createUniqueNotebookId(now: Date): Promise<string> {
  const existing = new Set((await listNotebooks({ rootDir: notesRootDir() })).map((notebook) => notebook.notebookId));
  const baseId = createSessionId(now).replace(/_session$/, "_notebook");
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? baseId : `${baseId}_${index + 1}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Unable to create a unique notebook id for ${baseId}`);
}

async function listAllPairingTargets() {
  const rootDir = notesRootDir();
  const notebooks = await listNotebooks({ rootDir });
  const groups = await Promise.all(notebooks.map(async (notebook) => ({
    notebook,
    sessions: await listNotebookSessions({
      rootDir,
      notebookId: notebook.notebookId
    })
  })));
  return groups.flatMap(({ notebook, sessions }) => sessions.map((session) => ({
    notebookId: session.notebookId,
    notebookTitle: notebook.title,
    sessionId: session.sessionId,
    title: session.title
  })));
}

async function restoreWorkspaceContext(store: BlockStore, rootDir: string): Promise<void> {
  const saved = await readWorkspaceContext(rootDir);
  if (saved) {
    try {
      await store.readSession(saved.notebookId, saved.sessionId);
      currentNotebookId = saved.notebookId;
      currentSessionId = saved.sessionId;
      return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  currentNotebookId = defaultNotebookId;
  currentSessionId = defaultSessionId;
  await persistCurrentWorkspaceContext();
}

async function persistCurrentWorkspaceContext(): Promise<void> {
  if (!currentNotebookId || !currentSessionId) return;
  await writeWorkspaceContext(notesRootDir(), {
    notebookId: currentNotebookId,
    sessionId: currentSessionId
  });
}

function notesRootDir(): string {
  return process.env.MATHNOTES_ROOT ?? cachedUserSettings?.notesRootDir ?? defaultNotesRootDir();
}

function ensureBlockOrganizeService(): SessionBlockOrganizeService {
  const rootDir = notesRootDir();
  if (!blockOrganizeRuntime || blockOrganizeRuntime.rootDir !== rootDir) {
    blockOrganizeRuntime = {
      rootDir,
      service: new SessionBlockOrganizeService(rootDir)
    };
  }
  return blockOrganizeRuntime.service;
}

async function ensureUserSettings(): Promise<UserSettings> {
  if (!cachedUserSettings) {
    cachedUserSettings = await readUserSettings({
      userDataDir: app.getPath("userData"),
      fallbackNotesRootDir: defaultNotesRootDir()
    });
  }
  return cachedUserSettings;
}

function defaultNotesRootDir(): string {
  return path.join(app.getPath("userData"), "MyMathNotes");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

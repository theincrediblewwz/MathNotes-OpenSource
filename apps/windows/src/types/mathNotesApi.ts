import type { SessionDocument } from "../common/sessionDocument";
import type { NotebookSessionSummary, NotebookSummary } from "../core/sessionCatalog";
import type { UserSettings } from "../core/userSettingsStore";
import type { RecognitionTaskSummary } from "../core/uploadTaskLog";
import type { PromptTemplateConfig } from "../common/promptTemplates";
import type { NotationPreviewInput, NotationProfileConfig, NotationPromptPreview } from "../common/notationProfiles";
import type {
  ExportUserDiagnosticReportInput,
  ExportUserDiagnosticReportResult,
  ProviderSelfTestInput,
  ProviderSelfTestResult,
  UserDiagnosticReport
} from "../common/userDiagnostics";
import type { AssistantMode, BlockRef, ImageAnnotationObject, ImageTransformOperation, LockMeta } from "@mathnotes/shared";
import type { AssistantTaskSummary } from "../core/assistantTask";
import type { AssistantRemark } from "../core/assistantRemarkStore";
import type { RecognitionProviderId as CoreRecognitionProviderId } from "../core/providerConfigStore";
import type { SelectionEditProposal } from "@mathnotes/core-server";

export type {
  NotebookSessionSummary,
  NotebookSummary,
  NotationPreviewInput,
  NotationProfileConfig,
  NotationPromptPreview,
  ExportUserDiagnosticReportInput,
  ExportUserDiagnosticReportResult,
  ProviderSelfTestInput,
  ProviderSelfTestResult,
  PromptTemplateConfig,
  UserDiagnosticReport,
  UserSettings
};

export type IngestAddressCandidate = {
  label: string;
  address: string;
  internal: boolean;
  usable?: boolean;
  recommended?: boolean;
  guidance?: string;
  transportKind?: "tailnet" | "private_lan" | "link_local" | "unusable";
};

export type IngestServerState = {
  running: boolean;
  host?: string;
  listenHost?: string;
  displayHost?: string;
  preferredHost?: string;
  transportKind?: "tailnet" | "private_lan" | "link_local" | "unusable";
  port?: number;
  url?: string;
  token?: string;
  pairingPayload?: string;
  devicePairingPayload?: string;
  devicePairingCode?: string;
  devicePairingExpiresAt?: string;
  pairedDevices?: PairedDeviceSummary[];
  rootDir?: string;
  addressCandidates?: IngestAddressCandidate[];
  lastError?: string;
};

export type PairedDeviceSummary = {
  deviceId: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
};

export type UpdatePairingTokenInput = {
  token: string;
  confirmation: string;
};

export type ConnectionDiagnosticStatus = "ok" | "attention";

export type ConnectionDiagnosticCheck = {
  id: string;
  label: string;
  status: ConnectionDiagnosticStatus;
  detail: string;
};

export type ConnectionDiagnosticReport = {
  summary: "ready" | "attention";
  recommendedMode: "tailscale_first";
  checks: ConnectionDiagnosticCheck[];
  guidance: string[];
};

export type RecognitionProviderId = CoreRecognitionProviderId;

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

export type AssistantProviderConfigInput = RecognitionProviderConfigInput;

export type AssistantProviderConfig = RecognitionProviderConfig & {
  purpose: "assistant";
  inherited: boolean;
};

export type SaveAssistantProviderConfigInput = AssistantProviderConfigInput | null;

export type ProviderHealthStatus = "ok" | "attention";

export type ProviderHealthCheck = {
  id: string;
  label: string;
  status: ProviderHealthStatus;
  detail: string;
};

export type ProviderHealthReport = {
  providerId: RecognitionProviderId;
  ok: boolean;
  summary: string;
  detail: string;
  checks: ProviderHealthCheck[];
};

export type UploadCompletedEvent = {
  materialType?: "image";
  uploadId: string;
  duplicate: boolean;
  assetPath: string;
  imageBlockId: string;
  transcriptBlockId?: string;
  recognitionJobId: string;
  recognitionStatus: "pending" | "running" | "succeeded" | "failed" | "cancelled";
} | {
  materialType: "pdf";
  uploadId: string;
  duplicate: boolean;
  notebookId: string;
  sessionId: string;
  sourcePath: string;
  inboxPath: string;
  fileName: string;
  byteLength: number;
  pageCount: number;
};

export type CompanionUploadActivityEvent = {
  version: 1;
  notebookId: string;
  sessionId: string;
  captureId?: string;
  fileName?: string;
  receivedBytes: number;
  totalBytes?: number;
  status: "receiving" | "accepted";
  updatedAt: string;
};

export type RecognitionJobChangedEvent = RecognitionTaskSummary;

export type RecognitionRuntimeEvent = {
  id: string;
  recognitionJobId: string;
  notebookId: string;
  sessionId: string;
  level: "info" | "stdout" | "stderr" | "warning" | "error";
  message: string;
  at: string;
  transcriptBlockId?: string;
  previewChanged?: boolean;
};

export type CodexRuntimeStatus = "stopped" | "starting" | "ready" | "error";

export type CodexRuntimeState = {
  status: CodexRuntimeStatus;
  progress: number;
  detail: string;
  command?: string;
  endpoint?: string;
  updatedAt: string;
};

export type ProviderRuntimeStatus = CodexRuntimeStatus;

export type ProviderRuntimeState = {
  providerId: RecognitionProviderId;
  status: ProviderRuntimeStatus;
  progress: number;
  detail: string;
  command?: string;
  endpoint?: string;
  updatedAt: string;
};

export type SaveMarkdownBlockInput = {
  notebookId: string;
  sessionId: string;
  blockId: string;
  markdown: string;
};

export type CreateMarkdownBlockInput = {
  notebookId: string;
  sessionId: string;
  insertAfterBlockId?: string;
  markdown?: string;
  sourceName?: string;
};

export type ProposeSelectionEditInput = {
  notebookId: string;
  sessionId: string;
  blockId: string;
  from: number;
  to: number;
  selectedText: string;
  instruction: string;
};

export type SelectionEditProposalCommand = {
  notebookId: string;
  sessionId: string;
  proposalId: string;
};

export type SaveSessionSourceInput = {
  notebookId: string;
  sessionId: string;
  sourceText: string;
};

export type SetMarkdownBlockLockInput = {
  notebookId: string;
  sessionId: string;
  blockId: string;
  locked: boolean;
};

export type DeleteMarkdownBlockInput = {
  notebookId: string;
  sessionId: string;
  blockId: string;
};

export type DeletedMarkdownBlockSnapshot = BlockRef & {
  block: BlockRef;
  index: number;
  markdown: string;
  locks: LockMeta[];
};

export type DeleteMarkdownBlockResult = {
  document: SessionDocument;
  undo: DeletedMarkdownBlockSnapshot;
};

export type RestoreDeletedMarkdownBlockInput = {
  notebookId: string;
  sessionId: string;
  snapshot: DeletedMarkdownBlockSnapshot;
};

export type ReorderSessionBlocksInput = {
  notebookId: string;
  sessionId: string;
  blockIds: string[];
  direction: "up" | "down";
};

export type TransferSessionBlocksInput = {
  sourceNotebookId: string;
  sourceSessionId: string;
  targetNotebookId: string;
  targetSessionId: string;
  blockIds: string[];
  mode: "copy" | "move";
};

export type TransferSessionBlocksResult = {
  document: SessionDocument;
  copiedBlockIds: readonly string[];
  sourceCleanupPending: boolean;
};

export type CreateSessionInput = {
  notebookId?: string;
  title?: string;
};

export type OpenSessionInput = {
  notebookId: string;
  sessionId: string;
};

export type RenameSessionInput = {
  notebookId: string;
  sessionId: string;
  title: string;
};

export type DeleteSessionInput = {
  notebookId: string;
  sessionId: string;
};

export type DeleteSessionResult = {
  deletedSessionId: string;
  remainingSessions: NotebookSessionSummary[];
};

export type ExportCurrentSessionInput = {
  notebookId: string;
  sessionId: string;
  includeMetadataComments: boolean;
  packageMode?: "markdown" | "share";
  includeAssistantRemarks?: boolean;
};

export type ExportCurrentSessionResult = {
  outPath: string;
  exportedBlocks: number;
  packageDir?: string;
  copiedAssets?: string[];
  missingAssets?: string[];
};

export type RevealPathInput = {
  path: string;
};

export type RevealPathResult = {
  path: string;
};

export type PickDirectoryInput = {
  defaultPath?: string;
  title?: string;
};

export type PickDirectoryResult =
  | {
      cancelled: true;
    }
  | {
      cancelled: false;
      path: string;
    };

export type CreateNotesBackupResult =
  | {
      cancelled: true;
    }
  | {
      cancelled: false;
      backupDir: string;
      manifestPath: string;
      fileCount: number;
      totalBytes: number;
    };

export type LocalPhotoImportInput = {
  notebookId: string;
  sessionId: string;
  insertAfterBlockId?: string;
  filePath?: string;
};

export type LocalPhotoImportResult =
  | {
      cancelled: true;
    }
  | ({
      cancelled: false;
    } & UploadCompletedEvent);

export type PickLocalPdfInput = {
  filePath?: string;
};

export type CreateNotebookInput = {
  title: string;
};

export type PickLocalPdfResult =
  | {
      cancelled: true;
    }
  | {
      cancelled: false;
      sourcePath: string;
      fileName: string;
      byteLength: number;
      pageCount: number;
    };

export type PdfImportMode = "read_only" | "recognize_selected" | "recognize_all";

export type ImportLocalPdfInput = {
  notebookId: string;
  sessionId: string;
  sourcePath: string;
  mode: PdfImportMode;
  destination: "current_session" | "new_session";
  newSessionTitle?: string;
  insertAfterBlockId?: string;
  pageStart?: number;
  pageEnd?: number;
  concurrency?: number;
};

export type ImportLocalPdfResult = {
  document: SessionDocument;
  pdfBlockId: string;
  assetPath: string;
  pageCount: number;
  recognitionQueued: boolean;
};

export type StagePdfRecognitionPageInput = {
  notebookId: string;
  sessionId: string;
  pdfBlockId: string;
  pageNumber: number;
  pngDataUrl: string;
};

export type StagePdfRecognitionPageResult = {
  pageNumber: number;
  assetPath: string;
  imagePath: string;
};

export type StartPdfRecognitionBatchInput = {
  notebookId: string;
  sessionId: string;
  pdfBlockId: string;
  pdfAssetPath: string;
  pageCount: number;
  concurrency: number;
  pages: StagePdfRecognitionPageResult[];
};

export type StartPdfRecognitionBatchResult = {
  batchId: string;
  jobIds: string[];
  document: SessionDocument;
};

export type PdfRecognitionBatchControlInput = {
  notebookId: string;
  sessionId: string;
  batchId: string;
};

export type PdfRecognitionBatchControlResult = {
  batchId: string;
  status: "running" | "pausing" | "cancelled";
};

export type EmbeddedImageImportInput = {
  notebookId: string;
  sessionId: string;
  filePath?: string;
};

export type EmbeddedImageImportResult =
  | {
      cancelled: true;
    }
  | {
      cancelled: false;
      assetPath: string;
      markdown: string;
    };

export type PickImageForAnnotationInput = {
  filePath?: string;
};

export type PickImageForAnnotationResult =
  | {
      cancelled: true;
    }
  | {
      cancelled: false;
      fileName: string;
      sourcePath: string;
      previewDataUrl: string;
    };

export type AnnotatedImageOperation = ImageTransformOperation;

export type SaveAnnotatedImageInput = {
  notebookId: string;
  sessionId: string;
  fileName: string;
  pngDataUrl: string;
  sourcePath: string;
  operations: AnnotatedImageOperation[];
  annotations: ImageAnnotationObject[];
  createdAt?: string;
};

export type SaveAnnotatedImageResult = {
  assetPath: string;
  metadataPath: string;
  markdown: string;
};

export type LoadRecognitionTasksInput = {
  notebookId: string;
  sessionId: string;
};

export type RetryRecognitionTaskInput = {
  notebookId: string;
  sessionId: string;
  recognitionJobId: string;
};

export type CancelRecognitionTaskInput = RetryRecognitionTaskInput;

export type RunAssistantTaskInput = {
  taskId: string;
  notebookId: string;
  sessionId: string;
  scope: "selection" | "block" | "session";
  activeBlockId?: string;
  selectedText?: string;
  focusLabel?: string;
  mode: AssistantMode;
  question?: string;
};

export type AssistantSessionInput = {
  notebookId: string;
  sessionId: string;
};

export type AssistantRemarkInput = AssistantSessionInput & {
  remarkId: string;
};

export type CancelAssistantTaskInput = {
  taskId: string;
};

export type WindowControlAction = "minimize" | "toggleMaximize" | "close";

export type WindowDragInput = {
  screenX: number;
  screenY: number;
};

export type MathNotesApi = {
  appName: string;
  loadCurrentSession(): Promise<SessionDocument>;
  loadNotebooks(): Promise<NotebookSummary[]>;
  loadNotebookSessions(input: { notebookId: string }): Promise<NotebookSessionSummary[]>;
  openSession(input: OpenSessionInput): Promise<SessionDocument>;
  renameSession(input: RenameSessionInput): Promise<SessionDocument>;
  deleteSession(input: DeleteSessionInput): Promise<DeleteSessionResult>;
  loadUserSettings(): Promise<UserSettings>;
  saveUserSettings(input: UserSettings): Promise<UserSettings>;
  loadConnectionDiagnostics(): Promise<ConnectionDiagnosticReport>;
  loadProviderConfig(): Promise<RecognitionProviderConfig>;
  saveProviderConfig(input: RecognitionProviderConfigInput): Promise<RecognitionProviderConfig>;
  loadAssistantProviderConfig(): Promise<AssistantProviderConfig>;
  saveAssistantProviderConfig(input: SaveAssistantProviderConfigInput): Promise<AssistantProviderConfig>;
  loadPromptTemplateConfig(): Promise<PromptTemplateConfig>;
  savePromptTemplateConfig(input: PromptTemplateConfig): Promise<PromptTemplateConfig>;
  loadNotationProfileConfig(): Promise<NotationProfileConfig>;
  saveNotationProfileConfig(input: NotationProfileConfig): Promise<NotationProfileConfig>;
  previewNotationPrompt(input: NotationPreviewInput): Promise<NotationPromptPreview>;
  checkProviderHealth(): Promise<ProviderHealthReport>;
  runProviderSelfTest(input: ProviderSelfTestInput): Promise<ProviderSelfTestResult>;
  exportUserDiagnosticReport(input?: ExportUserDiagnosticReportInput): Promise<ExportUserDiagnosticReportResult>;
  loadCodexRuntimeState(): Promise<CodexRuntimeState>;
  startCodexRuntime(): Promise<CodexRuntimeState>;
  stopCodexRuntime(): Promise<CodexRuntimeState>;
  loadRecognitionTasks(input: LoadRecognitionTasksInput): Promise<RecognitionTaskSummary[]>;
  retryRecognitionTask(input: RetryRecognitionTaskInput): Promise<RecognitionTaskSummary>;
  cancelRecognitionTask(input: CancelRecognitionTaskInput): Promise<RecognitionTaskSummary>;
  runAssistantTask(input: RunAssistantTaskInput): Promise<AssistantTaskSummary>;
  cancelAssistantTask(input: CancelAssistantTaskInput): Promise<{ taskId: string; cancelled: boolean }>;
  loadAssistantRemarks(input: AssistantSessionInput): Promise<AssistantRemark[]>;
  promoteAssistantRemark(input: AssistantRemarkInput): Promise<SessionDocument>;
  deleteAssistantRemark(input: AssistantRemarkInput): Promise<{ deleted: boolean }>;
  createNotebook(input: CreateNotebookInput): Promise<SessionDocument>;
  createSession(input?: CreateSessionInput): Promise<SessionDocument>;
  createMarkdownBlock(input: CreateMarkdownBlockInput): Promise<SessionDocument>;
  proposeSelectionEdit(input: ProposeSelectionEditInput): Promise<SelectionEditProposal>;
  applySelectionEdit(input: SelectionEditProposalCommand): Promise<SessionDocument>;
  cancelSelectionEdit(input: SelectionEditProposalCommand): Promise<SelectionEditProposal>;
  saveMarkdownBlock(input: SaveMarkdownBlockInput): Promise<SessionDocument>;
  saveSessionSource(input: SaveSessionSourceInput): Promise<SessionDocument>;
  setMarkdownBlockLock(input: SetMarkdownBlockLockInput): Promise<SessionDocument>;
  deleteMarkdownBlock(input: DeleteMarkdownBlockInput): Promise<DeleteMarkdownBlockResult>;
  restoreDeletedMarkdownBlock(input: RestoreDeletedMarkdownBlockInput): Promise<SessionDocument>;
  reorderSessionBlocks(input: ReorderSessionBlocksInput): Promise<SessionDocument>;
  transferSessionBlocks(input: TransferSessionBlocksInput): Promise<TransferSessionBlocksResult>;
  exportCurrentSession(input: ExportCurrentSessionInput): Promise<ExportCurrentSessionResult>;
  revealPath(input: RevealPathInput): Promise<RevealPathResult>;
  pickDirectory(input?: PickDirectoryInput): Promise<PickDirectoryResult>;
  createNotesBackup(): Promise<CreateNotesBackupResult>;
  importLocalPhoto(input: LocalPhotoImportInput): Promise<LocalPhotoImportResult>;
  pickLocalPdf(input?: PickLocalPdfInput): Promise<PickLocalPdfResult>;
  importLocalPdf(input: ImportLocalPdfInput): Promise<ImportLocalPdfResult>;
  stagePdfRecognitionPage(input: StagePdfRecognitionPageInput): Promise<StagePdfRecognitionPageResult>;
  startPdfRecognitionBatch(input: StartPdfRecognitionBatchInput): Promise<StartPdfRecognitionBatchResult>;
  pausePdfRecognitionBatch(input: PdfRecognitionBatchControlInput): Promise<PdfRecognitionBatchControlResult>;
  resumePdfRecognitionBatch(input: PdfRecognitionBatchControlInput): Promise<PdfRecognitionBatchControlResult>;
  cancelPdfRecognitionBatch(input: PdfRecognitionBatchControlInput): Promise<PdfRecognitionBatchControlResult>;
  importEmbeddedImage(input: EmbeddedImageImportInput): Promise<EmbeddedImageImportResult>;
  pickImageForAnnotation(input?: PickImageForAnnotationInput): Promise<PickImageForAnnotationResult>;
  saveAnnotatedImage(input: SaveAnnotatedImageInput): Promise<SaveAnnotatedImageResult>;
  windowControl(action: WindowControlAction): Promise<{ action: WindowControlAction; maximized?: boolean }>;
  onWindowCloseRequested(callback: () => void): () => void;
  beginWindowDrag(input: WindowDragInput): Promise<void>;
  updateWindowDrag(input: WindowDragInput): Promise<void>;
  endWindowDrag(): Promise<void>;
  loadIngestServerState(): Promise<IngestServerState>;
  startIngestServer(): Promise<IngestServerState>;
  refreshIngestAddresses(): Promise<IngestServerState>;
  refreshDevicePairing(): Promise<IngestServerState>;
  revokePairedDevice(deviceId: string): Promise<IngestServerState>;
  setIngestDisplayHost(host: string | null): Promise<IngestServerState>;
  updatePairingToken(input: UpdatePairingTokenInput): Promise<IngestServerState>;
  stopIngestServer(): Promise<IngestServerState>;
  onCompanionUploadActivity(callback: (event: CompanionUploadActivityEvent) => void): () => void;
  onUploadCompleted(callback: (event: UploadCompletedEvent) => void): () => void;
  onRecognitionJobChanged(callback: (event: RecognitionJobChangedEvent) => void): () => void;
  onRecognitionRuntimeEvent(callback: (event: RecognitionRuntimeEvent) => void): () => void;
  onCodexRuntimeStateChanged(callback: (event: CodexRuntimeState) => void): () => void;
};

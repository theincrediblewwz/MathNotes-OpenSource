import { contextBridge, ipcRenderer } from "electron";
import type {
  CodexRuntimeState,
  CompanionUploadActivityEvent,
  MathNotesApi,
  RecognitionJobChangedEvent,
  RecognitionRuntimeEvent,
  UploadCompletedEvent
} from "../src/types/mathNotesApi";

const api: MathNotesApi = {
  appName: "Math Notes",
  loadCurrentSession: () => ipcRenderer.invoke("mathnotes:load-current-session"),
  loadNotebooks: () => ipcRenderer.invoke("mathnotes:load-notebooks"),
  loadNotebookSessions: (input) => ipcRenderer.invoke("mathnotes:load-notebook-sessions", input),
  openSession: (input) => ipcRenderer.invoke("mathnotes:open-session", input),
  renameSession: (input) => ipcRenderer.invoke("mathnotes:rename-session", input),
  deleteSession: (input) => ipcRenderer.invoke("mathnotes:delete-session", input),
  loadUserSettings: () => ipcRenderer.invoke("mathnotes:load-user-settings"),
  saveUserSettings: (input) => ipcRenderer.invoke("mathnotes:save-user-settings", input),
  loadConnectionDiagnostics: () => ipcRenderer.invoke("mathnotes:load-connection-diagnostics"),
  loadProviderConfig: () => ipcRenderer.invoke("mathnotes:load-provider-config"),
  saveProviderConfig: (input) => ipcRenderer.invoke("mathnotes:save-provider-config", input),
  loadAssistantProviderConfig: () => ipcRenderer.invoke("mathnotes:load-assistant-provider-config"),
  saveAssistantProviderConfig: (input) => ipcRenderer.invoke("mathnotes:save-assistant-provider-config", input),
  loadPromptTemplateConfig: () => ipcRenderer.invoke("mathnotes:load-prompt-template-config"),
  savePromptTemplateConfig: (input) => ipcRenderer.invoke("mathnotes:save-prompt-template-config", input),
  loadNotationProfileConfig: () => ipcRenderer.invoke("mathnotes:load-notation-profile-config"),
  saveNotationProfileConfig: (input) => ipcRenderer.invoke("mathnotes:save-notation-profile-config", input),
  previewNotationPrompt: (input) => ipcRenderer.invoke("mathnotes:preview-notation-prompt", input),
  checkProviderHealth: () => ipcRenderer.invoke("mathnotes:check-provider-health"),
  runProviderSelfTest: (input) => ipcRenderer.invoke("mathnotes:run-provider-self-test", input),
  exportUserDiagnosticReport: (input) => ipcRenderer.invoke("mathnotes:export-user-diagnostic-report", input),
  loadCodexRuntimeState: () => ipcRenderer.invoke("mathnotes:load-codex-runtime-state"),
  startCodexRuntime: () => ipcRenderer.invoke("mathnotes:start-codex-runtime"),
  stopCodexRuntime: () => ipcRenderer.invoke("mathnotes:stop-codex-runtime"),
  loadRecognitionTasks: (input) => ipcRenderer.invoke("mathnotes:load-recognition-tasks", input),
  retryRecognitionTask: (input) => ipcRenderer.invoke("mathnotes:retry-recognition-task", input),
  cancelRecognitionTask: (input) => ipcRenderer.invoke("mathnotes:cancel-recognition-task", input),
  runAssistantTask: (input) => ipcRenderer.invoke("mathnotes:run-assistant-task", input),
  cancelAssistantTask: (input) => ipcRenderer.invoke("mathnotes:cancel-assistant-task", input),
  loadAssistantRemarks: (input) => ipcRenderer.invoke("mathnotes:load-assistant-remarks", input),
  promoteAssistantRemark: (input) => ipcRenderer.invoke("mathnotes:promote-assistant-remark", input),
  deleteAssistantRemark: (input) => ipcRenderer.invoke("mathnotes:delete-assistant-remark", input),
  createNotebook: (input) => ipcRenderer.invoke("mathnotes:create-notebook", input),
  createSession: (input) => ipcRenderer.invoke("mathnotes:create-session", input),
  createMarkdownBlock: (input) => ipcRenderer.invoke("mathnotes:create-markdown-block", input),
  saveMarkdownBlock: (input) => ipcRenderer.invoke("mathnotes:save-markdown-block", input),
  saveSessionSource: (input) => ipcRenderer.invoke("mathnotes:save-session-source", input),
  setMarkdownBlockLock: (input) => ipcRenderer.invoke("mathnotes:set-markdown-block-lock", input),
  deleteMarkdownBlock: (input) => ipcRenderer.invoke("mathnotes:delete-markdown-block", input),
  restoreDeletedMarkdownBlock: (input) => ipcRenderer.invoke("mathnotes:restore-deleted-markdown-block", input),
  reorderSessionBlocks: (input) => ipcRenderer.invoke("mathnotes:reorder-session-blocks", input),
  transferSessionBlocks: (input) => ipcRenderer.invoke("mathnotes:transfer-session-blocks", input),
  exportCurrentSession: (input) => ipcRenderer.invoke("mathnotes:export-current-session", input),
  revealPath: (input) => ipcRenderer.invoke("mathnotes:reveal-path", input),
  pickDirectory: (input) => ipcRenderer.invoke("mathnotes:pick-directory", input),
  createNotesBackup: () => ipcRenderer.invoke("mathnotes:create-notes-backup"),
  importLocalPhoto: (input) => ipcRenderer.invoke("mathnotes:import-local-photo", input),
  pickLocalPdf: (input) => ipcRenderer.invoke("mathnotes:pick-local-pdf", input),
  importLocalPdf: (input) => ipcRenderer.invoke("mathnotes:import-local-pdf", input),
  stagePdfRecognitionPage: (input) => ipcRenderer.invoke("mathnotes:stage-pdf-recognition-page", input),
  startPdfRecognitionBatch: (input) => ipcRenderer.invoke("mathnotes:start-pdf-recognition-batch", input),
  pausePdfRecognitionBatch: (input) => ipcRenderer.invoke("mathnotes:pause-pdf-recognition-batch", input),
  resumePdfRecognitionBatch: (input) => ipcRenderer.invoke("mathnotes:resume-pdf-recognition-batch", input),
  cancelPdfRecognitionBatch: (input) => ipcRenderer.invoke("mathnotes:cancel-pdf-recognition-batch", input),
  importEmbeddedImage: (input) => ipcRenderer.invoke("mathnotes:import-embedded-image", input),
  pickImageForAnnotation: (input) => ipcRenderer.invoke("mathnotes:pick-image-for-annotation", input),
  saveAnnotatedImage: (input) => ipcRenderer.invoke("mathnotes:save-annotated-image", input),
  windowControl: (action) => ipcRenderer.invoke("mathnotes:window-control", action),
  beginWindowDrag: (input) => ipcRenderer.invoke("mathnotes:begin-window-drag", input),
  updateWindowDrag: (input) => ipcRenderer.invoke("mathnotes:update-window-drag", input),
  endWindowDrag: () => ipcRenderer.invoke("mathnotes:end-window-drag"),
  onWindowCloseRequested: (callback) => {
    const listener = () => {
      callback();
    };

    ipcRenderer.on("mathnotes:window-close-requested", listener);
    return () => ipcRenderer.off("mathnotes:window-close-requested", listener);
  },
  loadIngestServerState: () => ipcRenderer.invoke("mathnotes:load-ingest-server-state"),
  startIngestServer: () => ipcRenderer.invoke("mathnotes:start-ingest-server"),
  refreshIngestAddresses: () => ipcRenderer.invoke("mathnotes:refresh-ingest-addresses"),
  refreshDevicePairing: () => ipcRenderer.invoke("mathnotes:refresh-device-pairing"),
  revokePairedDevice: (deviceId: string) => ipcRenderer.invoke("mathnotes:revoke-paired-device", deviceId),
  setIngestDisplayHost: (host) => ipcRenderer.invoke("mathnotes:set-ingest-display-host", host),
  updatePairingToken: (input) => ipcRenderer.invoke("mathnotes:update-pairing-token", input),
  stopIngestServer: () => ipcRenderer.invoke("mathnotes:stop-ingest-server"),
  onCompanionUploadActivity: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CompanionUploadActivityEvent) => {
      callback(payload);
    };

    ipcRenderer.on("mathnotes:companion-upload-activity", listener);
    return () => ipcRenderer.off("mathnotes:companion-upload-activity", listener);
  },
  onUploadCompleted: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UploadCompletedEvent) => {
      callback(payload);
    };

    ipcRenderer.on("mathnotes:upload-completed", listener);
    return () => ipcRenderer.off("mathnotes:upload-completed", listener);
  },
  onRecognitionJobChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RecognitionJobChangedEvent) => {
      callback(payload);
    };

    ipcRenderer.on("mathnotes:recognition-job-changed", listener);
    return () => ipcRenderer.off("mathnotes:recognition-job-changed", listener);
  },
  onRecognitionRuntimeEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RecognitionRuntimeEvent) => {
      callback(payload);
    };

    ipcRenderer.on("mathnotes:recognition-runtime-event", listener);
    return () => ipcRenderer.off("mathnotes:recognition-runtime-event", listener);
  },
  onCodexRuntimeStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CodexRuntimeState) => {
      callback(payload);
    };

    ipcRenderer.on("mathnotes:codex-runtime-state-changed", listener);
    return () => ipcRenderer.off("mathnotes:codex-runtime-state-changed", listener);
  }
};

contextBridge.exposeInMainWorld("mathNotes", api);

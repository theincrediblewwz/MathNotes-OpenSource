import { BookOpen, BrainCircuit, FileUp, ImagePlus, ListChecks, Menu, Minus, PanelLeftOpen, Plus, Save, Search, Smartphone, Square, Upload, X } from "lucide-react";
import { startTransition, type FormEvent, type MouseEvent, type PointerEvent, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FloatingButton } from "./ui/components/FloatingButton";
import { MoreDrawer, NotebookDrawer, SettingsModal } from "./ui/components/Drawers";
import { ExportPopover, type ExportOptions, SearchPopover } from "./ui/components/Popovers";
import { PreviewPane, type PreviewSourceLocationInput } from "./ui/components/PreviewPane";
import { SessionSourceEditor, type SourceDocumentProjectionChange } from "./ui/components/SessionSourceEditor";
import { ImageAnnotationEditor, type ImageAnnotationConfirmInput, type ImageAnnotationDraft } from "./ui/components/ImageAnnotationEditor";
import { PdfImportDialog, type PdfImportConfirmInput, type PdfImportDraft } from "./ui/components/PdfImportDialog";
import { PdfDocumentPreview } from "./ui/components/PdfDocumentPreview";
import { type AssistantWorkspaceSubmitInput } from "./ui/components/AssistantWorkspace";
import { AssistantWorkspaceWithRuntime, TaskPopoverWithEvents } from "./ui/components/RuntimeEventConsumers";
import { appendRecognitionRuntimeEvent, clearRecognitionRuntimeEvents } from "./ui/runtimeEventStore";
import { RenderCommitProbe, useRenderCommitProbe } from "./ui/performance/RenderCommitProbe";
import { recordRecognitionTimeline } from "./ui/performance/RecognitionTimelineProbe";
import type { AssistantRemark } from "./core/assistantRemarkStore";
import type { SelectionEditProposal } from "@mathnotes/core-server";
import { providerRuntimeProgressTitle, providerRuntimeStateForProvider } from "./ui/providerRuntimeState";
import { type AssetPreviewReference, resolveSessionAssetPreview } from "./ui/assetReferences";
import type { RenderBlock, SessionDocument } from "./common/sessionDocument";
import {
  createSessionLivePreviewProjector,
  renderBlocksFromSessionSourceText,
  type SessionMarkdownProjection
} from "./common/sessionLivePreview";
import { parseSessionSourceText, type SessionSourceDocument, type SessionSourceMarkdownBlock } from "./common/sessionSourceDocument";
import {
  markdownDropRenderBlocks,
  markdownDropTitle,
  readMarkdownDropFiles,
  type MarkdownDropDocument
} from "./common/markdownDrop";
import { searchSessionSource } from "./common/sessionSearch";
import type { RecognitionTaskSummary } from "./core/uploadTaskLog";
import { defaultMathPromptTemplate } from "./common/promptTemplates";
import { createEmptyNotationProfileConfig } from "./common/notationProfiles";
import { defaultAssistantFontFamily, defaultPreviewFontFamily, defaultSourceFontFamily } from "./common/defaultUserSettings";
import { defaultLocaleId, defaultThemeId } from "./common/appearanceSettings";
import { getRecognitionProviderCapability } from "./core/providerCapabilities";
import { renderPdfPagesForRecognition } from "./ui/pdfRecognitionRenderer";
import type {
  ConnectionDiagnosticReport,
  CodexRuntimeState,
  CompanionUploadActivityEvent,
  DeletedMarkdownBlockSnapshot,
  ExportCurrentSessionResult,
  IngestServerState,
  NotebookSessionSummary,
  NotebookSummary,
  NotationPreviewInput,
  NotationProfileConfig,
  NotationPromptPreview,
  ProviderRuntimeState,
  ProviderHealthReport,
  PromptTemplateConfig,
  AssistantProviderConfig,
  RecognitionProviderConfig,
  RecognitionProviderConfigInput,
  UserSettings
} from "./types/mathNotesApi";

export function exceedsWindowDragThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold = 6
) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}
import {
  renderBlocks as sampleRenderBlocks,
  sourceDocument as sampleSourceDocument
} from "./ui/sampleSession";

type Layer = "notebook" | "more" | "search" | "task" | "export" | null;
type SourceSaveState = "saved" | "dirty" | "saving" | "error";
type SessionTitlePromptRequest = {
  title: string;
  defaultValue: string;
  confirmLabel: string;
  resolve: (value: string | null) => void;
};
type SessionDeletePromptRequest = {
  session: NotebookSessionSummary;
  resolve: (confirmed: boolean) => void;
};
type MarkdownDropChoice = {
  documents: MarkdownDropDocument[];
};
type BlockTransferTarget = {
  key: string;
  notebookId: string;
  notebookTitle: string;
  sessionId: string;
  sessionTitle: string;
};
type BlockTransferRequest = {
  blockIds: string[];
  mode: "copy" | "move";
  targets: BlockTransferTarget[];
};
type AppUndoAction =
  | {
      type: "restoreDeletedBlock";
      notebookId: string;
      sessionId: string;
      snapshot: DeletedMarkdownBlockSnapshot;
    };
type LocateSourceRequest = PreviewSourceLocationInput & {
  nonce: number;
};
type ScrollPositionSnapshot = {
  nearBottom: boolean;
  scrollTop: number;
};

type SessionViewportSnapshot = {
  preview?: ScrollPositionSnapshot;
  source?: ScrollPositionSnapshot;
};

type PreviewProjectionSnapshot = {
  blockIds: string;
  sourceText: string;
  markdownByBlockId: SessionMarkdownProjection;
};

export type SelectionEditDraft = {
  blockId: string;
  from: number;
  to: number;
  selectedText: string;
  instruction: string;
  proposal: SelectionEditProposal | null;
  status: "idle" | "generating" | "applying";
  error?: string;
};

const previewProjectionLabStorageKey = "mathnotes:preview-projection-lab";

function createPreviewProjectionSnapshot(document: SessionSourceDocument): PreviewProjectionSnapshot {
  const parsed = new Map(parseSessionSourceText(document.text).map((update) => [update.blockId, update.markdown]));
  return {
    blockIds: document.markdownBlocks.map((block) => block.blockId).join("\u0000"),
    sourceText: document.text,
    markdownByBlockId: Object.fromEntries(
      document.markdownBlocks.map((block) => [block.blockId, parsed.get(block.blockId) ?? ""])
    )
  };
}

export function App() {
  useRenderCommitProbe("app-root");
  const hasNativeApi = Boolean(window.mathNotes);
  const [openLayer, setOpenLayer] = useState<Layer>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const [sourceWidth, setSourceWidth] = useState(50);
  const [currentSession, setCurrentSession] = useState({ notebookId: "functional_analysis", sessionId: "lecture", title: "泛函分析 第 3 讲" });
  const [nativeSessionLoaded, setNativeSessionLoaded] = useState(!hasNativeApi);
  const [previewSessionLoaded, setPreviewSessionLoaded] = useState(!hasNativeApi);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [notebookSessions, setNotebookSessions] = useState<NotebookSessionSummary[]>([]);
  const [blockTransferRequest, setBlockTransferRequest] = useState<BlockTransferRequest | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [sourceDocument, setSourceDocument] = useState<SessionSourceDocument>(sampleSourceDocument);
  const [sourceText, setSourceText] = useState(sampleSourceDocument.text);
  const [previewProjectionLabEnabled] = useState(
    () => window.localStorage?.getItem(previewProjectionLabStorageKey) !== "legacy"
  );
  const [previewProjection, setPreviewProjection] = useState<PreviewProjectionSnapshot>(
    () => createPreviewProjectionSnapshot(sampleSourceDocument)
  );
  const [sessionDir, setSessionDir] = useState<string | undefined>(undefined);
  const [activeSourceBlock, setActiveSourceBlock] = useState<SessionSourceMarkdownBlock | null>(null);
  const [selectionLockable, setSelectionLockable] = useState(false);
  const [protectedSpanUnlockable, setProtectedSpanUnlockable] = useState(false);
  const [lockSelectionRequest, setLockSelectionRequest] = useState(0);
  const [unlockProtectedSpanRequest, setUnlockProtectedSpanRequest] = useState(0);
  const [insertMarkdownRequest, setInsertMarkdownRequest] = useState<{ id: number; markdown: string } | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [sourceSaveState, setSourceSaveState] = useState<SourceSaveState>("saved");
  const [backgroundRefreshPending, setBackgroundRefreshPending] = useState(false);
  const [lastExportResult, setLastExportResult] = useState<ExportCurrentSessionResult | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [recognitionTasks, setRecognitionTasks] = useState<RecognitionTaskSummary[]>([]);
  const [companionUploadActivities, setCompanionUploadActivities] = useState<CompanionUploadActivityEvent[]>([]);
  const [renderBlocks, setRenderBlocks] = useState<RenderBlock[]>(sampleRenderBlocks);
  const [ingestServer, setIngestServer] = useState<IngestServerState>({ running: false });
  const [connectionDiagnostics, setConnectionDiagnostics] = useState<ConnectionDiagnosticReport | null>(null);
  const [providerConfig, setProviderConfig] = useState<RecognitionProviderConfig | null>(null);
  const [assistantProviderConfig, setAssistantProviderConfig] = useState<AssistantProviderConfig | null>(null);
  const [promptConfig, setPromptConfig] = useState<PromptTemplateConfig | null>(null);
  const [notationConfig, setNotationConfig] = useState<NotationProfileConfig | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealthReport | null>(null);
  const [codexRuntimeState, setCodexRuntimeState] = useState<CodexRuntimeState>({
    status: "stopped",
    progress: 0,
    detail: "Codex CLI runtime 未启动。",
    updatedAt: new Date(0).toISOString()
  });
  const [codexRuntimeProgressVisible, setCodexRuntimeProgressVisible] = useState(false);
  const [locatingRequest, setLocatingRequest] = useState<LocateSourceRequest | null>(null);
  const [toastQueue, setToastQueue] = useState<string[]>([]);
  const toast = toastQueue[0] ?? "";
  const [sessionTitlePrompt, setSessionTitlePrompt] = useState<SessionTitlePromptRequest | null>(null);
  const [sessionDeletePrompt, setSessionDeletePrompt] = useState<SessionDeletePromptRequest | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [markdownDropChoice, setMarkdownDropChoice] = useState<MarkdownDropChoice | null>(null);
  const [temporaryMarkdownDocuments, setTemporaryMarkdownDocuments] = useState<MarkdownDropDocument[] | null>(null);
  const [markdownArchiveOpen, setMarkdownArchiveOpen] = useState(false);
  const [markdownDropBusy, setMarkdownDropBusy] = useState(false);
  const [markdownDragActive, setMarkdownDragActive] = useState(false);
  const [undoAction, setUndoAction] = useState<AppUndoAction | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [imageAnnotationDraft, setImageAnnotationDraft] = useState<ImageAnnotationDraft | null>(null);
  const [pdfImportDraft, setPdfImportDraft] = useState<PdfImportDraft | null>(null);
  const [assetPreview, setAssetPreview] = useState<AssetPreviewReference | null>(null);
  const [assistantWorkspaceOpen, setAssistantWorkspaceOpen] = useState(false);
  const [assistantRemarks, setAssistantRemarks] = useState<AssistantRemark[]>([]);
  const [selectedAssistantRemarkId, setSelectedAssistantRemarkId] = useState<string | null>(null);
  const [runningAssistantTaskId, setRunningAssistantTaskId] = useState<string | null>(null);
  const [assistantLastError, setAssistantLastError] = useState<string | null>(null);
  const [selectionEditDraft, setSelectionEditDraft] = useState<SelectionEditDraft | null>(null);
  const [sourceCreateMenuOpen, setSourceCreateMenuOpen] = useState(false);
  const [hoverTip, setHoverTip] = useState<{ visible: boolean; x: number; y: number; text: string }>({
    visible: false,
    x: 0,
    y: 0,
    text: ""
  });
  const draggingRef = useRef(false);
  const manualWindowDraggingRef = useRef(false);
  const manualWindowDragCandidateRef = useRef<{
    pointerId: number;
    element: HTMLElement;
    startScreenX: number;
    startScreenY: number;
    startClientX: number;
    startClientY: number;
    sourceEditorClick: boolean;
  } | null>(null);
  const manualWindowDragBeginPromiseRef = useRef<Promise<unknown> | null>(null);
  const windowDragFrameRef = useRef<number | null>(null);
  const pendingWindowDragPositionRef = useRef<{ screenX: number; screenY: number } | null>(null);
  const sourceWidthRef = useRef(sourceWidth);
  const runtimePreviewRefreshTimerRef = useRef<number | null>(null);
  const runtimePreviewRefreshTraceRef = useRef<string | null>(null);
  const pendingRecognitionCommitTraceRef = useRef<string | null>(null);
  const viewportRestoreFrameRef = useRef<number | null>(null);
  const viewportIntentEpochRef = useRef(0);
  const previewApplyFrameRef = useRef<number | null>(null);
  const previewApplyTokenRef = useRef(0);
  const appliedSessionIdentityRef = useRef(`${currentSession.notebookId}:${currentSession.sessionId}`);
  const sourceSaveStateRef = useRef<SourceSaveState>("saved");
  const sourceTextRef = useRef(sourceText);
  const livePreviewProjectorRef = useRef(createSessionLivePreviewProjector());
  const pendingBackgroundRefreshRef = useRef(false);
  const locatingClearTimerRef = useRef<number | null>(null);
  const locatingNonceRef = useRef(0);

  const clearRuntimeEvents = useCallback(() => {
    clearRecognitionRuntimeEvents();
  }, []);
  const deferredPreviewSourceText = useDeferredValue(sourceText);
  const deferredPreviewProjection = useDeferredValue(previewProjection);
  const previewProjectionBlockIds = sourceDocument.markdownBlocks.map((block) => block.blockId).join("\u0000");
  const effectivePreviewProjection =
    deferredPreviewProjection.blockIds === previewProjectionBlockIds
      ? deferredPreviewProjection
      : previewProjection;
  const livePreviewProjection = useMemo(() => {
    if (!previewSessionLoaded) {
      return { blocks: [], stats: null };
    }
    if (previewProjectionLabEnabled) {
      return livePreviewProjectorRef.current.project({
        markdownBlocks: sourceDocument.markdownBlocks,
        markdownByBlockId: effectivePreviewProjection.markdownByBlockId,
        sourceText: effectivePreviewProjection.sourceText
      });
    }
    return {
      blocks: renderBlocksFromSessionSourceText({
        markdownBlocks: sourceDocument.markdownBlocks,
        sourceText: deferredPreviewSourceText
      }),
      stats: null
    };
  }, [
    deferredPreviewSourceText,
    effectivePreviewProjection,
    previewSessionLoaded,
    previewProjectionLabEnabled,
    sourceDocument.markdownBlocks
  ]);
  const liveRenderBlocks = livePreviewProjection.blocks;
  const previewBlocks = useMemo(
    () =>
      [...renderBlocks.filter((block) => Boolean(block.pdf)), ...liveRenderBlocks].sort(
        (left, right) => left.sourceLine - right.sourceLine
      ),
    [liveRenderBlocks, renderBlocks]
  );
  const visiblePreviewBlocks = nativeSessionLoaded && previewSessionLoaded ? previewBlocks : [];
  const pendingTaskCount = recognitionTasks.filter((task) => task.recognitionStatus !== "succeeded" && task.recognitionStatus !== "cancelled").length;
  const receivingUploadCount = companionUploadActivities.filter((activity) => activity.status === "receiving").length;
  const providerRuntimeState = useMemo(
    () => providerRuntimeStateForProvider(providerConfig?.providerId, codexRuntimeState),
    [providerConfig?.providerId, codexRuntimeState]
  );
  const normalizedSearchQuery = searchQuery.trim();
  const blockMarkdowns = useMemo(() => {
    if (!normalizedSearchQuery) return new Map<string, string>();
    if (previewProjectionLabEnabled && previewProjection.sourceText === sourceText) {
      return new Map(
        sourceDocument.markdownBlocks.map((block) => [
          block.blockId,
          previewProjection.markdownByBlockId[block.blockId] ?? ""
        ])
      );
    }
    return new Map(parseSessionSourceText(sourceText).map((update) => [update.blockId, update.markdown]));
  }, [normalizedSearchQuery, previewProjection, previewProjectionLabEnabled, sourceDocument.markdownBlocks, sourceText]);
  const assistantContextBlocks = useMemo(() => {
    const markdownByBlockId = new Map(
      parseSessionSourceText(sourceText).map((update) => [update.blockId, update.markdown])
    );
    return sourceDocument.markdownBlocks
      .filter((block) => block.source !== "ai_explanation")
      .map((block) => ({
        id: block.blockId,
        source: block.source,
        markdown: markdownByBlockId.get(block.blockId) ?? ""
      }));
  }, [sourceDocument.markdownBlocks, sourceText]);
  const searchResults = useMemo(
    () => normalizedSearchQuery
      ? searchSessionSource({
          document: sourceDocument,
          blockMarkdowns,
          query: normalizedSearchQuery
        })
      : [],
    [blockMarkdowns, normalizedSearchQuery, sourceDocument]
  );
  const activeNotebook = useMemo(
    () => notebooks.find((notebook) => notebook.notebookId === currentSession.notebookId),
    [currentSession.notebookId, notebooks]
  );
  useWorkspaceLayoutAnchorPreservation(
    isWorkspaceLayoutAnchorLabEnabled(),
    `${currentSession.notebookId}:${currentSession.sessionId}:${nativeSessionLoaded}:${previewSessionLoaded}`
  );

  const applySessionDocument = useCallback((
    document: SessionDocument,
    options: { deferPreview?: boolean; preserveViewport?: boolean; recognitionTraceId?: string } = {}
  ) => {
    recordRecognitionTimeline(options.recognitionTraceId, "document-apply-start");
    const viewport = options.preserveViewport ? captureSessionViewport() : undefined;
    setHoverTip((current) => ({ ...current, visible: false }));
    if (!options.preserveViewport) {
      setLocatingRequest(null);
    }
    setCurrentSession({
      notebookId: document.notebookId,
      sessionId: document.sessionId,
      title: document.title
    });
    const sessionIdentity = `${document.notebookId}:${document.sessionId}`;
    const deferPreview = options.deferPreview ?? appliedSessionIdentityRef.current !== sessionIdentity;
    appliedSessionIdentityRef.current = sessionIdentity;
    const previewToken = previewApplyTokenRef.current + 1;
    previewApplyTokenRef.current = previewToken;
    if (previewApplyFrameRef.current !== null) {
      window.cancelAnimationFrame(previewApplyFrameRef.current);
      previewApplyFrameRef.current = null;
    }
    setSourceDocument(document.sourceDocument);
    setSourceText(document.sourceDocument.text);
    livePreviewProjectorRef.current.reset();
    sourceTextRef.current = document.sourceDocument.text;
    setSessionDir(document.sessionDir);
    setSourceSaveState("saved");
    sourceSaveStateRef.current = "saved";
    pendingBackgroundRefreshRef.current = false;
    setBackgroundRefreshPending(false);
    pendingRecognitionCommitTraceRef.current = options.recognitionTraceId ?? null;
    if (!options.preserveViewport) {
      setActiveSourceBlock(null);
      setSelectionLockable(false);
      setProtectedSpanUnlockable(false);
    }
    setNativeSessionLoaded(true);
    const applyPreview = () => {
      const projection = createPreviewProjectionSnapshot(document.sourceDocument);
      startTransition(() => {
        if (previewApplyTokenRef.current !== previewToken) return;
        setRenderBlocks(document.renderBlocks);
        setPreviewProjection(projection);
        setPreviewSessionLoaded(true);
      });
    };
    if (deferPreview) {
      setPreviewSessionLoaded(false);
      previewApplyFrameRef.current = window.requestAnimationFrame(() => {
        previewApplyFrameRef.current = null;
        applyPreview();
      });
    } else {
      applyPreview();
    }
    if (viewport) {
      if (viewportRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportRestoreFrameRef.current);
      }
      const intentEpoch = viewportIntentEpochRef.current;
      viewportRestoreFrameRef.current = window.requestAnimationFrame(() => {
        viewportRestoreFrameRef.current = window.requestAnimationFrame(() => {
          viewportRestoreFrameRef.current = null;
          if (viewportIntentEpochRef.current !== intentEpoch) return;
          restoreSessionViewport(viewport);
        });
      });
    }
    recordRecognitionTimeline(options.recognitionTraceId, "document-apply-end");
  }, []);

  useLayoutEffect(() => {
    const traceId = pendingRecognitionCommitTraceRef.current;
    if (!traceId) return;
    pendingRecognitionCommitTraceRef.current = null;
    recordRecognitionTimeline(traceId, "react-layout-commit");
    window.requestAnimationFrame(() => {
      recordRecognitionTimeline(traceId, "next-paint");
    });
  });

  const loadNotebooks = useCallback(async () => {
    if (!window.mathNotes) {
      setNotebooks([]);
      return;
    }
    setNotebooks(await window.mathNotes.loadNotebooks());
  }, []);

  const loadNotebookSessions = useCallback(async (notebookId = currentSession.notebookId) => {
    if (!window.mathNotes) {
      setNotebookSessions([]);
      return;
    }
    const sessions = await window.mathNotes.loadNotebookSessions({
      notebookId
    });
    setNotebookSessions(sessions);
  }, [currentSession.notebookId]);

  const loadCurrentSession = useCallback(async () => {
    if (!window.mathNotes) {
      setNativeSessionLoaded(true);
      return;
    }

    const document = await window.mathNotes.loadCurrentSession();
    applySessionDocument(document, { deferPreview: true });
  }, [applySessionDocument]);

  const refreshCurrentSessionWhenSafe = useCallback(async (recognitionTraceId?: string) => {
    if (!window.mathNotes) {
      return;
    }
    if (sourceSaveStateRef.current !== "saved") {
      pendingBackgroundRefreshRef.current = true;
      setBackgroundRefreshPending(true);
      return;
    }

    const sourceAtStart = sourceTextRef.current;
    recordRecognitionTimeline(recognitionTraceId, "session-load-start");
    const document = await window.mathNotes.loadCurrentSession();
    recordRecognitionTimeline(recognitionTraceId, "session-load-end");
    if (sourceSaveStateRef.current !== "saved" || sourceTextRef.current !== sourceAtStart) {
      pendingBackgroundRefreshRef.current = true;
      setBackgroundRefreshPending(true);
      return;
    }
    pendingBackgroundRefreshRef.current = false;
    setBackgroundRefreshPending(false);
    applySessionDocument(document, { preserveViewport: true, recognitionTraceId });
  }, [applySessionDocument]);

  useEffect(() => {
    const cancelPendingViewportRestore = () => {
      viewportIntentEpochRef.current += 1;
      if (viewportRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportRestoreFrameRef.current);
        viewportRestoreFrameRef.current = null;
      }
    };
    window.addEventListener("wheel", cancelPendingViewportRestore, { capture: true, passive: true });
    window.addEventListener("pointerdown", cancelPendingViewportRestore, { capture: true, passive: true });
    return () => {
      window.removeEventListener("wheel", cancelPendingViewportRestore, { capture: true });
      window.removeEventListener("pointerdown", cancelPendingViewportRestore, { capture: true });
      if (viewportRestoreFrameRef.current !== null) window.cancelAnimationFrame(viewportRestoreFrameRef.current);
      if (previewApplyFrameRef.current !== null) window.cancelAnimationFrame(previewApplyFrameRef.current);
    };
  }, []);

  const loadAssistantRemarks = useCallback(async () => {
    if (!window.mathNotes || !nativeSessionLoaded) {
      setAssistantRemarks([]);
      return;
    }
    try {
      setAssistantRemarks(await window.mathNotes.loadAssistantRemarks({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId
      }));
    } catch {
      setAssistantRemarks([]);
    }
  }, [currentSession.notebookId, currentSession.sessionId, nativeSessionLoaded]);

  useEffect(() => {
    void loadAssistantRemarks();
  }, [loadAssistantRemarks]);

  useEffect(() => {
    setAssistantLastError(null);
    setSelectedAssistantRemarkId(null);
  }, [currentSession.notebookId, currentSession.sessionId]);

  const scheduleRuntimePreviewRefresh = useCallback((eventId: string) => {
    if (runtimePreviewRefreshTimerRef.current !== null) {
      recordRecognitionTimeline(runtimePreviewRefreshTraceRef.current ?? undefined, "refresh-coalesced");
      return;
    }

    runtimePreviewRefreshTraceRef.current = eventId;
    recordRecognitionTimeline(eventId, "refresh-scheduled");
    runtimePreviewRefreshTimerRef.current = window.setTimeout(() => {
      runtimePreviewRefreshTimerRef.current = null;
      const traceId = runtimePreviewRefreshTraceRef.current ?? undefined;
      runtimePreviewRefreshTraceRef.current = null;
      recordRecognitionTimeline(traceId, "refresh-timer-fired");
      void refreshCurrentSessionWhenSafe(traceId);
    }, 120);
  }, [refreshCurrentSessionWhenSafe]);

  const loadSystemState = useCallback(async () => {
    if (!window.mathNotes) {
      setConnectionDiagnostics(null);
      setProviderConfig({
        providerId: "mock",
        model: "mock-faithful-markdown",
        apiKeyEnvVar: "OPENAI_API_KEY",
        status: "configured"
      });
      setAssistantProviderConfig({
        providerId: "mock",
        model: "mock-faithful-markdown",
        apiKeyEnvVar: "OPENAI_API_KEY",
        status: "configured",
        purpose: "assistant",
        inherited: true
      });
      setCodexRuntimeState({
        status: "stopped",
        progress: 0,
        detail: "浏览器预览模式未启动 Codex CLI runtime。",
        updatedAt: new Date().toISOString()
      });
      setUserSettings({
        notesRootDir: "",
        defaultExportDir: "",
        sourceFontFamily: defaultSourceFontFamily,
        sourceFontSize: 13,
        previewFontFamily: defaultPreviewFontFamily,
        previewFontSize: 16,
        assistantFontFamily: defaultAssistantFontFamily,
        assistantFontSize: 16,
        themeId: defaultThemeId,
        locale: defaultLocaleId,
        showCodexAssistant: true,
        assistantOnlineEnabled: true
      });
      setPromptConfig({
        activeTemplateId: defaultMathPromptTemplate.id,
        templates: [defaultMathPromptTemplate]
      });
      setNotationConfig(createEmptyNotationProfileConfig());
      return;
    }

    const [diagnostics, config, assistantConfig, promptTemplates, notationProfiles, settings, codexRuntime, currentIngestServer] = await Promise.all([
      window.mathNotes.loadConnectionDiagnostics(),
      window.mathNotes.loadProviderConfig(),
      window.mathNotes.loadAssistantProviderConfig(),
      window.mathNotes.loadPromptTemplateConfig(),
      window.mathNotes.loadNotationProfileConfig(),
      window.mathNotes.loadUserSettings(),
      window.mathNotes.loadCodexRuntimeState(),
      window.mathNotes.loadIngestServerState()
    ]);
    setConnectionDiagnostics(diagnostics);
    setProviderConfig(config);
    setAssistantProviderConfig(assistantConfig);
    setPromptConfig(promptTemplates);
    setNotationConfig(notationProfiles);
    setUserSettings(settings);
    setCodexRuntimeState(codexRuntime);
    setIngestServer(currentIngestServer);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = userSettings?.themeId ?? defaultThemeId;
    root.lang = userSettings?.locale ?? defaultLocaleId;
  }, [userSettings?.locale, userSettings?.themeId]);

  const saveSourceDocument = useCallback(async (options: { revealExport?: boolean } = {}) => {
    const revealExport = options.revealExport ?? true;
    if (!window.mathNotes) {
      setSourceSaveState("saved");
      showToast("浏览器预览模式：源码编辑已暂存");
      return true;
    }

    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      const document = await window.mathNotes.saveSessionSource({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        sourceText
      });
      const namedDocument = await ensureSessionNamed(document);
      if (!namedDocument) {
        setSourceSaveState("dirty");
        return false;
      }
      applySessionDocument(namedDocument);
      const exportResult = await window.mathNotes.exportCurrentSession({
        notebookId: namedDocument.notebookId,
        sessionId: namedDocument.sessionId,
        includeMetadataComments: false
      });
      setLastExportResult(exportResult);
      if (revealExport) {
        await window.mathNotes.revealPath({ path: exportResult.outPath });
      }
      showToast(`已保存并更新合并 Markdown：${exportResult.outPath}`);
      return true;
    } catch (error) {
      setSourceSaveState("error");
      showToast(`保存失败：${error instanceof Error ? error.message : "unknown error"}`);
      return false;
    } finally {
      setSavingSource(false);
    }
  }, [applySessionDocument, currentSession.notebookId, currentSession.sessionId, sourceText]);

  const loadRecognitionTasks = useCallback(async () => {
    if (!window.mathNotes) {
      setRecognitionTasks([]);
      return;
    }

    setLoadingTasks(true);
    try {
      const tasks = await window.mathNotes.loadRecognitionTasks({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId
      });
      setRecognitionTasks(tasks);
    } catch (error) {
      showToast(`任务读取失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setLoadingTasks(false);
    }
  }, [currentSession.notebookId, currentSession.sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenLayer(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveSourceDocument();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey && undoAction && !isInsideCodeMirror(event.target)) {
        event.preventDefault();
        void undoLastAction();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createSession();
      }
      if ((event.ctrlKey || event.metaKey) && ["f", "k"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        setOpenLayer("search");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveSourceDocument, undoAction]);

  useEffect(() => {
    void loadCurrentSession();
  }, [loadCurrentSession]);

  useEffect(() => {
    void loadSystemState();
  }, [loadSystemState]);

  useEffect(() => {
    void loadNotebookSessions();
  }, [loadNotebookSessions, currentSession.sessionId]);

  useEffect(() => {
    void loadNotebooks();
  }, [loadNotebooks, currentSession.notebookId, currentSession.sessionId]);

  useEffect(() => {
    void loadRecognitionTasks();
  }, [loadRecognitionTasks]);

  useEffect(() => {
    sourceSaveStateRef.current = sourceSaveState;
    sourceTextRef.current = sourceText;
    if (sourceSaveState === "saved" && pendingBackgroundRefreshRef.current) {
      void refreshCurrentSessionWhenSafe();
    }
  }, [refreshCurrentSessionWhenSafe, sourceSaveState, sourceText]);

  useEffect(() => {
    if (!window.mathNotes) {
      return;
    }

    return window.mathNotes.onCompanionUploadActivity((event) => {
      setCompanionUploadActivities((current) => upsertCompanionUploadActivity(current, event));
      if (event.status === "accepted") {
        queueStatusToast(`已接收 ${event.fileName ?? "手机素材"} · ${formatByteCount(event.receivedBytes)}`);
      }
    });
  }, []);

  useEffect(() => {
    if (!window.mathNotes) {
      return;
    }

    return window.mathNotes.onUploadCompleted((event) => {
      if (event.materialType === "pdf") {
        setPdfImportDraft({
          cancelled: false,
          sourcePath: event.sourcePath,
          fileName: event.fileName,
          byteLength: event.byteLength,
          pageCount: event.pageCount,
          notebookId: event.notebookId,
          sessionId: event.sessionId
        });
        queueStatusToast(event.duplicate ? `重复 PDF 已存在：${event.fileName}` : `已收到 PDF：${event.fileName}`);
        return;
      }
      void refreshCurrentSessionWhenSafe();
      void loadRecognitionTasks();
      const fileName = event.assetPath.split("/").at(-1) ?? event.assetPath;
      queueStatusToast(event.duplicate ? `重复照片已忽略：${fileName}` : `已收到识别素材：${fileName}`);
    });
  }, [loadRecognitionTasks, refreshCurrentSessionWhenSafe]);

  useEffect(() => {
    if (!window.mathNotes) {
      return;
    }

    return window.mathNotes.onRecognitionJobChanged((event) => {
      setRecognitionTasks((current) => upsertTaskSummary(current, event));
      if (event.recognitionStatus === "running") {
        queueStatusToast(`正在识别：${event.fileName}`);
      }
      if (event.recognitionStatus === "failed") {
        queueStatusToast(`${recognitionTaskToastTitle(event)}：${event.fileName}`);
      }
      if (event.recognitionStatus === "cancelled") {
        void refreshCurrentSessionWhenSafe();
        queueStatusToast(`识别已中断：${event.fileName}`);
      }
      if (event.recognitionStatus === "succeeded") {
        void refreshCurrentSessionWhenSafe();
        queueStatusToast(`识别完成：${event.fileName}`);
      }
    });
  }, [refreshCurrentSessionWhenSafe]);

  useEffect(() => {
    if (!window.mathNotes) {
      return;
    }

    return window.mathNotes.onRecognitionRuntimeEvent((event) => {
      appendRecognitionRuntimeEvent(event);
      if (event.previewChanged) {
        recordRecognitionTimeline(event.id, "runtime-event-received");
        scheduleRuntimePreviewRefresh(event.id);
      }
    });
  }, [scheduleRuntimePreviewRefresh]);

  useEffect(() => {
    if (!window.mathNotes) {
      return;
    }

    return window.mathNotes.onCodexRuntimeStateChanged((state) => {
      setCodexRuntimeState(state);
    });
  }, []);

  useEffect(() => {
    if (!window.mathNotes) {
      return;
    }

    return window.mathNotes.onWindowCloseRequested(() => {
      if (savingSource) {
        showToast("正在保存，完成后再关闭");
        return;
      }
      if (["dirty", "error"].includes(sourceSaveState)) {
        setCloseConfirmOpen(true);
        return;
      }
      if (temporaryMarkdownDocuments && !window.confirm("临时 Session 尚未保存到 Notebook。确定放弃并关闭吗？")) return;
      void performWindowControl("close");
    });
  }, [savingSource, sourceSaveState, temporaryMarkdownDocuments]);

  useEffect(() => {
    if (!window.mathNotes || providerConfig?.providerId !== "codex_cli") {
      return;
    }
    if (codexRuntimeState.status === "ready" || codexRuntimeState.status === "starting") {
      return;
    }

    void window.mathNotes.startCodexRuntime().then(setCodexRuntimeState).catch((error) => {
      showToast(`Codex CLI 启动失败：${error instanceof Error ? error.message : "unknown error"}`);
    });
  }, [codexRuntimeState.status, providerConfig?.providerId]);

  useEffect(() => {
    if (providerConfig?.providerId !== "codex_cli") {
      setCodexRuntimeProgressVisible(false);
      return;
    }

    if (codexRuntimeState.status === "starting") {
      setCodexRuntimeProgressVisible(true);
      return;
    }
    if (codexRuntimeState.status === "ready") {
      setCodexRuntimeProgressVisible(true);
      const timer = window.setTimeout(() => setCodexRuntimeProgressVisible(false), 2200);
      return () => window.clearTimeout(timer);
    }
    if (codexRuntimeState.status === "error") {
      setCodexRuntimeProgressVisible(true);
    }
  }, [codexRuntimeState.status, providerConfig?.providerId]);

  useEffect(
    () => () => {
      if (runtimePreviewRefreshTimerRef.current !== null) {
        window.clearTimeout(runtimePreviewRefreshTimerRef.current);
      }
      runtimePreviewRefreshTraceRef.current = null;
      if (locatingClearTimerRef.current !== null) {
        window.clearTimeout(locatingClearTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToastQueue((current) => current.slice(1)), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (openLayer !== "more" || !ingestServer.running) return;
    void refreshIngestAddresses({ silent: true });
    const timer = window.setInterval(() => void refreshIngestAddresses({ silent: true }), 5_000);
    return () => window.clearInterval(timer);
  }, [openLayer, ingestServer.running]);

  function hideHoverTip() {
    setHoverTip((current) => (current.visible ? { ...current, visible: false } : current));
  }

  function toggleLayer(layer: Exclude<Layer, null>) {
    hideHoverTip();
    setOpenLayer((current) => (current === layer ? null : layer));
  }

  function dismissLayerFromMainSurface(event: PointerEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) {
      return;
    }

    if (sourceCreateMenuOpen && !event.target.closest(".source-create-menu")) {
      setSourceCreateMenuOpen(false);
    }
    if (!openLayer) return;

    const persistentSurface = event.target.closest(
      [
        ".drawer",
        ".drawer-context-menu",
        ".popover",
        ".floating-group",
        ".settings-modal-layer",
        ".session-title-prompt-layer",
        ".close-confirm-layer",
        ".assistant-workspace",
        ".source-create-menu",
        ".screen-toast",
        ".hover-tip",
        ".split-handle",
      ].join(", ")
    );
    if (!persistentSurface) {
      setOpenLayer(null);
    }
  }

  function showToast(message: string) {
    setToastQueue(message ? [message] : []);
  }

  function queueStatusToast(message: string) {
    setToastQueue((current) => enqueueToastMessage(current, message));
  }

  function requestSessionTitle(args: Omit<SessionTitlePromptRequest, "resolve">): Promise<string | null> {
    return new Promise((resolve) => {
      setSessionTitlePrompt({ ...args, resolve });
    });
  }

  function completeSessionTitlePrompt(value: string | null) {
    const request = sessionTitlePrompt;
    if (!request) {
      return;
    }
    setSessionTitlePrompt(null);
    request.resolve(value?.trim() ? value.trim() : null);
  }

  function requestSessionDeleteConfirmation(session: NotebookSessionSummary): Promise<boolean> {
    return new Promise((resolve) => {
      setSessionDeletePrompt({ session, resolve });
    });
  }

  function completeSessionDeletePrompt(confirmed: boolean) {
    const request = sessionDeletePrompt;
    if (!request) {
      return;
    }
    setSessionDeletePrompt(null);
    request.resolve(confirmed);
  }

  async function startIngestServer() {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能启动接收服务");
      return;
    }

    const state = await window.mathNotes.startIngestServer();
    setIngestServer(state);
    void loadSystemState();
    showToast(`接收服务已启动：${state.url}`);
  }

  async function stopIngestServer() {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能停止接收服务");
      return;
    }

    const state = await window.mathNotes.stopIngestServer();
    setIngestServer(state);
    void loadSystemState();
    showToast("接收服务已停止");
  }

  async function refreshIngestAddresses(options: { silent?: boolean } = {}) {
    if (!window.mathNotes || !ingestServer.running) return;
    try {
      const state = await window.mathNotes.refreshIngestAddresses();
      setIngestServer(state);
      void loadSystemState();
      if (!options.silent) showToast(`网络地址已刷新：${state.url}`);
    } catch (error) {
      if (!options.silent) {
        showToast(`刷新网络地址失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function refreshDevicePairing() {
    if (!window.mathNotes || !ingestServer.running) return;
    try {
      const state = await window.mathNotes.refreshDevicePairing();
      setIngestServer(state);
      showToast("新设备配对二维码已刷新");
    } catch (error) {
      showToast(`刷新配对二维码失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function revokePairedDevice(deviceId: string) {
    if (!window.mathNotes || !ingestServer.running) return;
    try {
      const state = await window.mathNotes.revokePairedDevice(deviceId);
      setIngestServer(state);
      showToast("设备访问已撤销");
    } catch (error) {
      showToast(`撤销设备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function copyPairingToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      showToast("配对令牌已复制");
    } catch (error) {
      showToast(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function copyConnectionValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast("连接信息已复制");
    } catch (error) {
      showToast(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function updatePairingToken(input: { token: string; confirmation: string }): Promise<void> {
    if (!window.mathNotes) {
      throw new Error("配对令牌只能在桌面应用中更新。");
    }
    const state = await window.mathNotes.updatePairingToken(input);
    setIngestServer(state);
    void loadSystemState();
    showToast("配对令牌已更新，旧设备需要重新配对");
  }

  async function setIngestDisplayHost(host: string | null) {
    if (!window.mathNotes) return;
    try {
      const state = await window.mathNotes.setIngestDisplayHost(host);
      setIngestServer(state);
      void loadSystemState();
      showToast(host ? `配对地址已固定：${state.url}` : `已恢复自动选择：${state.url}`);
    } catch (error) {
      showToast(`切换地址失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function saveProviderConfig(input: RecognitionProviderConfigInput) {
    if (!window.mathNotes) {
      setProviderConfig({
        ...input,
        status: "configured"
      });
      showToast("浏览器预览模式：识别服务设置已暂存");
      return;
    }

    try {
      const config = await window.mathNotes.saveProviderConfig(input);
      setProviderConfig(config);
      if (assistantProviderConfig?.inherited) {
        setAssistantProviderConfig(await window.mathNotes.loadAssistantProviderConfig());
      }
      setCodexRuntimeState(await window.mathNotes.loadCodexRuntimeState());
      setProviderHealth(null);
      showToast(config.status === "configured" ? "识别服务设置已保存" : "识别服务设置已保存：等待 API 密钥");
    } catch (error) {
      showToast(`识别服务设置失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function saveAssistantProviderConfig(input: RecognitionProviderConfigInput | null) {
    if (!window.mathNotes) {
      if (input === null) {
        setAssistantProviderConfig(providerConfig ? { ...providerConfig, purpose: "assistant", inherited: true } : null);
        showToast("浏览器预览模式：对话模型已恢复继承识别模型");
      } else {
        setAssistantProviderConfig({ ...input, status: "configured", purpose: "assistant", inherited: false });
        showToast("浏览器预览模式：对话模型设置已暂存");
      }
      return;
    }

    try {
      const config = await window.mathNotes.saveAssistantProviderConfig(input);
      setAssistantProviderConfig(config);
      setCodexRuntimeState(await window.mathNotes.loadCodexRuntimeState());
      showToast(config.inherited ? "对话模型已恢复继承识别模型" : "对话模型设置已保存");
    } catch (error) {
      showToast(`对话模型设置失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function checkCurrentProviderHealth() {
    if (!window.mathNotes) {
      setProviderHealth({
        providerId: providerConfig?.providerId ?? "mock",
        ok: true,
        summary: "浏览器预览模式",
        detail: "Provider 诊断需要 Electron 模式。",
        checks: [
          {
            id: "native_api",
            label: "Electron API",
            status: "attention",
            detail: "当前是浏览器预览，未连接本机 Provider。"
          }
        ]
      });
      showToast("浏览器预览模式：无法检查本机 Provider");
      return;
    }

    try {
      const report = await window.mathNotes.checkProviderHealth();
      setProviderHealth(report);
      showToast(report.ok ? "识别服务检查通过" : `识别服务检查未通过：${report.summary}`);
    } catch (error) {
      showToast(`识别服务检查失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function savePromptTemplateConfig(input: PromptTemplateConfig) {
    if (!window.mathNotes) {
      setPromptConfig(input);
      showToast("浏览器预览模式：提示词设置已暂存");
      return;
    }

    try {
      const saved = await window.mathNotes.savePromptTemplateConfig(input);
      setPromptConfig(saved);
      showToast("提示词设置已保存");
    } catch (error) {
      showToast(`提示词设置失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function reloadSession() {
    await loadCurrentSession();
    showToast("当前 Session 已刷新");
  }

  async function ensureSessionNamed(document: SessionDocument): Promise<SessionDocument | null> {
    if (document.title.trim() && document.title.trim() !== "未命名") {
      return document;
    }
    if (!window.mathNotes) {
      return document;
    }

    const nextTitle = await requestSessionTitle({
      title: "保存前命名 Session",
      defaultValue: "",
      confirmLabel: "命名并保存"
    });
    if (!nextTitle) {
      showToast("已取消保存：Session 需要命名");
      return null;
    }

    const renamed = await window.mathNotes.renameSession({
      notebookId: document.notebookId,
      sessionId: document.sessionId,
      title: nextTitle
    });
    await loadNotebookSessions();
    return renamed;
  }

  async function openNotebookSession(session: NotebookSessionSummary) {
    if (!window.mathNotes) {
      showToast(`浏览器预览模式：打开 ${session.title}`);
      return;
    }
    if (session.sessionId === currentSession.sessionId) {
      setOpenLayer(null);
      return;
    }

    setSavingSource(true);
    try {
      if (sourceSaveState !== "saved") {
        await window.mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText
        });
      }
      const document = await window.mathNotes.openSession({
        notebookId: session.notebookId,
        sessionId: session.sessionId
      });
      applySessionDocument(document);
      setOpenLayer(null);
      setUndoAction(null);
      setRecognitionTasks([]);
      clearRuntimeEvents();
      await loadNotebookSessions();
      showToast(`已打开 Session：${document.title}`);
    } catch (error) {
      showToast(`打开 Session 失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function renameNotebookSession(session: NotebookSessionSummary) {
    if (!window.mathNotes) {
      showToast("浏览器预览模式：重命名需要 Electron");
      return;
    }

    const title = await requestSessionTitle({
      title: "重命名 Session",
      defaultValue: session.title === "未命名" ? "" : session.title,
      confirmLabel: "保存名称"
    });
    if (!title) {
      return;
    }

    try {
      const document = await window.mathNotes.renameSession({
        notebookId: session.notebookId,
        sessionId: session.sessionId,
        title
      });
      if (session.sessionId === currentSession.sessionId) {
        applySessionDocument(document);
      }
      await loadNotebookSessions();
      showToast(`已重命名：${title}`);
    } catch (error) {
      showToast(`重命名失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function deleteNotebookSession(session: NotebookSessionSummary) {
    if (!window.mathNotes) {
      showToast("浏览器预览模式：删除需要 Electron");
      return;
    }

    const confirmed = await requestSessionDeleteConfirmation(session);
    if (!confirmed) {
      return;
    }

    setSavingSource(true);
    try {
      const result = await window.mathNotes.deleteSession({
        notebookId: session.notebookId,
        sessionId: session.sessionId
      });
      setOpenLayer(null);
      setUndoAction(null);
      setRecognitionTasks([]);
      clearRuntimeEvents();
      setLastExportResult(null);

      if (session.sessionId === currentSession.sessionId) {
        const nextSession = result.remainingSessions[0];
        const document = nextSession
          ? await window.mathNotes.openSession({
              notebookId: nextSession.notebookId,
              sessionId: nextSession.sessionId
            })
          : await window.mathNotes.createSession({
              notebookId: session.notebookId
            });
        applySessionDocument(document);
      }

      await loadNotebookSessions();
      showToast(`已删除 Session：${session.title || session.sessionId}`);
    } catch (error) {
      showToast(`删除 Session 失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function saveUserSettings(settings: UserSettings) {
    window.dispatchEvent(new Event("mathnotes:layout-anchor-start"));
    if (!window.mathNotes) {
      setUserSettings(settings);
      finishWorkspaceLayoutAnchorTransition();
      showToast("浏览器预览模式：设置已暂存");
      return;
    }

    try {
      const saved = await window.mathNotes.saveUserSettings(settings);
      setUserSettings(saved);
      finishWorkspaceLayoutAnchorTransition();
      showToast("设置已保存");
      await loadSystemState();
    } catch (error) {
      window.dispatchEvent(new Event("mathnotes:layout-anchor-end"));
      showToast(`设置保存失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function pickDirectory(args: { currentPath: string; title: string }): Promise<string | undefined> {
    if (!window.mathNotes) {
      return undefined;
    }
    const result = await window.mathNotes.pickDirectory({
      defaultPath: args.currentPath,
      title: args.title
    });
    return result.cancelled ? undefined : result.path;
  }

  async function saveNotationProfiles(input: NotationProfileConfig) {
    if (!window.mathNotes) {
      setNotationConfig(input);
      showToast("浏览器预览模式：领域记号设置已暂存");
      return;
    }
    try {
      const saved = await window.mathNotes.saveNotationProfileConfig(input);
      setNotationConfig(saved);
      showToast("领域记号设置已保存");
    } catch (error) {
      showToast(`领域记号设置失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function previewNotationPrompt(input: NotationPreviewInput): Promise<NotationPromptPreview> {
    if (!window.mathNotes) {
      return {
        selection: {
          schemaVersion: "nh1-v1",
          query: input.query,
          rules: [],
          conflicts: [],
          omittedByBudget: 0,
          characterCount: 0,
          selectionHash: "browser-preview",
          promptFragment: ""
        },
        fullPrompt: defaultMathPromptTemplate.content
      };
    }
    return window.mathNotes.previewNotationPrompt(input);
  }

  async function createNotesBackup() {
    if (!window.mathNotes) {
      showToast("浏览器预览模式：备份需要 Electron");
      return;
    }
    try {
      const result = await window.mathNotes.createNotesBackup();
      if (result.cancelled) return;
      showToast(`备份完成：${result.fileCount} 个文件`);
      await window.mathNotes.revealPath({ path: result.manifestPath });
    } catch (error) {
      showToast(`备份失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function createSession() {
    if (!window.mathNotes) {
      showToast("浏览器预览模式：新建 Session 需要 Electron");
      return;
    }

    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      if (sourceSaveState !== "saved") {
        await window.mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText
        });
      }
      const document = await window.mathNotes.createSession({
        notebookId: currentSession.notebookId
      });
      applySessionDocument(document);
      setOpenLayer(null);
      setUndoAction(null);
      setRecognitionTasks([]);
      clearRuntimeEvents();
      setLastExportResult(null);
      await Promise.all([loadNotebookSessions(document.notebookId), loadNotebooks()]);
      showToast(`已新建 Session：${document.title}`);
    } catch (error) {
      setSourceSaveState("error");
      showToast(`新建 Session 失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function undoLastAction() {
    if (!undoAction) {
      return;
    }
    if (undoAction.type === "restoreDeletedBlock") {
      if (!window.mathNotes) {
        showToast(`浏览器预览模式：已恢复 block ${undoAction.snapshot.block.id}`);
        setUndoAction(null);
        return;
      }

      setSavingSource(true);
      setSourceSaveState("saving");
      try {
        const document = await window.mathNotes.restoreDeletedMarkdownBlock({
          notebookId: undoAction.notebookId,
          sessionId: undoAction.sessionId,
          snapshot: undoAction.snapshot
        });
        applySessionDocument(document);
        setUndoAction(null);
        showToast(`已撤销删除：block ${undoAction.snapshot.block.id}`);
      } catch (error) {
        setSourceSaveState("error");
        showToast(`撤销失败：${error instanceof Error ? error.message : "unknown error"}`);
      } finally {
        setSavingSource(false);
      }
    }
  }

  async function importLocalPhoto() {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能导入本机照片");
      return;
    }

    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      await window.mathNotes.saveSessionSource({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        sourceText
      });
      const result = await window.mathNotes.importLocalPhoto({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        insertAfterBlockId: activeSourceBlock?.blockId
      });
      if (result.cancelled) {
        setSourceSaveState("saved");
        return;
      }
      await loadCurrentSession();
    } catch (error) {
      setSourceSaveState("error");
      showToast(`导入失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function createNotebookEntry() {
    if (!window.mathNotes) {
      showToast("浏览器预览模式：新建 Notebook 需要 Electron");
      return;
    }
    const title = await requestSessionTitle({
      title: "新建 Notebook",
      defaultValue: "",
      confirmLabel: "创建 Notebook"
    });
    if (!title) return;

    setSavingSource(true);
    try {
      if (sourceSaveState !== "saved") {
        await window.mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText
        });
      }
      const document = await window.mathNotes.createNotebook({ title });
      applySessionDocument(document);
      setOpenLayer(null);
      setUndoAction(null);
      setRecognitionTasks([]);
      clearRuntimeEvents();
      setLastExportResult(null);
      await Promise.all([loadNotebooks(), loadNotebookSessions(document.notebookId)]);
      showToast(`已新建 Notebook：${title}`);
    } catch (error) {
      showToast(`新建 Notebook 失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function openNotebook(notebook: NotebookSummary) {
    if (!window.mathNotes) return;
    if (notebook.notebookId === currentSession.notebookId) {
      setOpenLayer(null);
      return;
    }
    setSavingSource(true);
    try {
      if (sourceSaveState !== "saved") {
        await window.mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText
        });
      }
      const sessions = await window.mathNotes.loadNotebookSessions({ notebookId: notebook.notebookId });
      const document = sessions[0]
        ? await window.mathNotes.openSession({ notebookId: notebook.notebookId, sessionId: sessions[0].sessionId })
        : await window.mathNotes.createSession({ notebookId: notebook.notebookId });
      applySessionDocument(document);
      setNotebookSessions(sessions.length > 0 ? sessions : await window.mathNotes.loadNotebookSessions({ notebookId: notebook.notebookId }));
      setOpenLayer(null);
      setRecognitionTasks([]);
      clearRuntimeEvents();
      showToast(`已打开 Notebook：${notebook.title}`);
    } catch (error) {
      showToast(`打开 Notebook 失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function pickLocalPdf() {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能导入 PDF");
      return;
    }

    hideHoverTip();
    try {
      const result = await window.mathNotes.pickLocalPdf();
      if (!result.cancelled) {
        setPdfImportDraft(result);
      }
    } catch (error) {
      showToast(`读取 PDF 失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function confirmPdfImport(input: PdfImportConfirmInput) {
    const mathNotes = window.mathNotes;
    if (!mathNotes || !pdfImportDraft) {
      return;
    }

    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      const { notebookId: targetNotebookId, sessionId: targetSessionId } = resolvePdfImportTarget(
        pdfImportDraft,
        currentSession
      );
      const targetsOpenSession = targetNotebookId === currentSession.notebookId && targetSessionId === currentSession.sessionId;
      if (input.destination === "current_session" && targetsOpenSession) {
        await mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText
        });
      }
      const result = await mathNotes.importLocalPdf({
        notebookId: targetNotebookId,
        sessionId: targetSessionId,
        sourcePath: pdfImportDraft.sourcePath,
        mode: input.mode,
        destination: input.destination,
        newSessionTitle: input.newSessionTitle,
        insertAfterBlockId: targetsOpenSession ? activeSourceBlock?.blockId : undefined,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        concurrency: input.concurrency
      });
      applySessionDocument(result.document);
      setPdfImportDraft(null);
      setUndoAction(null);
      let recognizedPages = 0;
      if (input.mode !== "read_only") {
        const source = resolveSessionAssetPreview({ sessionDir: result.document.sessionDir, target: result.assetPath });
        if (!source) {
          throw new Error("无法定位已保存的 PDF 素材");
        }
        const pageNumbers = Array.from(
          { length: Math.max(0, input.pageEnd - input.pageStart + 1) },
          (_, index) => input.pageStart + index
        );
        const stagedPages: Awaited<ReturnType<typeof mathNotes.stagePdfRecognitionPage>>[] = [];
        showToast(`正在准备 ${pageNumbers.length} 页识别素材`);
        await renderPdfPagesForRecognition({
          sourceUrl: source.previewUrl,
          pageNumbers,
          renderConcurrency: 2,
          onPage: async ({ pageNumber, pngDataUrl }) => {
            stagedPages.push(
              await mathNotes.stagePdfRecognitionPage({
                notebookId: result.document.notebookId,
                sessionId: result.document.sessionId,
                pdfBlockId: result.pdfBlockId,
                pageNumber,
                pngDataUrl
              })
            );
          }
        });
        const batch = await mathNotes.startPdfRecognitionBatch({
          notebookId: result.document.notebookId,
          sessionId: result.document.sessionId,
          pdfBlockId: result.pdfBlockId,
          pdfAssetPath: result.assetPath,
          pageCount: result.pageCount,
          concurrency: input.concurrency,
          pages: stagedPages
        });
        recognizedPages = batch.jobIds.length;
        applySessionDocument(batch.document);
        setOpenLayer("task");
        await loadRecognitionTasks();
      }
      await loadNotebookSessions();
      showToast(
        recognizedPages > 0
          ? `已导入 PDF，并排队识别 ${recognizedPages} 页`
          : `已导入 PDF：${pdfImportDraft.fileName}（${result.pageCount} 页）`
      );
    } catch (error) {
      setSourceSaveState("error");
      showToast(`导入 PDF 失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function createUserTextBlock(insertAfterBlockId = activeSourceBlock?.blockId) {
    if (!window.mathNotes) {
      showToast("浏览器预览模式：已新建文本块");
      return;
    }

    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      await window.mathNotes.saveSessionSource({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        sourceText
      });
      const document = await window.mathNotes.createMarkdownBlock({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        insertAfterBlockId
      });
      applySessionDocument(document, { preserveViewport: true });
      const created = document.sourceDocument.markdownBlocks.find(
        (block) => !sourceDocument.markdownBlocks.some((existing) => existing.blockId === block.blockId)
      );
      if (created) {
        locateSource(sourceLocationFromBlock(created), 1400);
      }
      showToast("已新建文本块");
    } catch (error) {
      setSourceSaveState("error");
      showToast(`新建文本块失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  function openSelectionEdit(input: { blockId: string; from: number; to: number; selectedText: string }) {
    const block = sourceDocument.markdownBlocks.find((candidate) => candidate.blockId === input.blockId);
    if (block?.locked) {
      showToast("这个块已固定，AI 不能修改");
      return;
    }
    setSelectionEditDraft({ ...input, instruction: "", proposal: null, status: "idle" });
  }

  async function generateSelectionEdit() {
    const draft = selectionEditDraft;
    if (!draft || !draft.instruction.trim()) return;
    if (!window.mathNotes) {
      setSelectionEditDraft({ ...draft, error: "浏览器预览模式不能调用 AI。" });
      return;
    }
    setSelectionEditDraft({ ...draft, proposal: null, status: "generating", error: undefined });
    try {
      if (sourceSaveStateRef.current !== "saved") {
        const saved = await window.mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText: sourceTextRef.current
        });
        applySessionDocument(saved, { preserveViewport: true });
      }
      const proposal = await window.mathNotes.proposeSelectionEdit({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        blockId: draft.blockId,
        from: draft.from,
        to: draft.to,
        selectedText: draft.selectedText,
        instruction: draft.instruction
      });
      setSelectionEditDraft((current) => current ? { ...current, proposal, status: "idle", error: undefined } : null);
    } catch (error) {
      setSelectionEditDraft((current) => current ? {
        ...current,
        status: "idle",
        error: `生成失败：${error instanceof Error ? error.message : "unknown error"}`
      } : null);
    }
  }

  async function applySelectionEditProposal() {
    const draft = selectionEditDraft;
    if (!draft?.proposal || !window.mathNotes) return;
    setSelectionEditDraft({ ...draft, status: "applying", error: undefined });
    try {
      const document = await window.mathNotes.applySelectionEdit({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        proposalId: draft.proposal.id
      });
      applySessionDocument(document, { preserveViewport: true });
      setSelectionEditDraft(null);
      showToast("已应用 AI 修改；可用 Ctrl+Z 撤销");
    } catch (error) {
      setSelectionEditDraft((current) => current ? {
        ...current,
        status: "idle",
        error: `应用冲突：${error instanceof Error ? error.message : "unknown error"}。候选已保留。`
      } : null);
    }
  }

  async function cancelSelectionEdit() {
    const proposal = selectionEditDraft?.proposal;
    setSelectionEditDraft(null);
    if (!proposal || proposal.status !== "proposed" || !window.mathNotes) return;
    await window.mathNotes.cancelSelectionEdit({
      notebookId: proposal.notebookId,
      sessionId: proposal.sessionId,
      proposalId: proposal.id
    }).catch(() => undefined);
  }

  async function insertEmbeddedImage() {
    if (!activeSourceBlock) {
      showToast("先把光标放到要插图的 Markdown 块里");
      return;
    }
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能插入本机图片");
      return;
    }

    try {
      const result = await window.mathNotes.pickImageForAnnotation();
      if (result.cancelled) {
        return;
      }
      setImageAnnotationDraft(result);
    } catch (error) {
      showToast(`选择图片失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function confirmAnnotatedImage(input: ImageAnnotationConfirmInput) {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能保存图片");
      return;
    }

    try {
      const result = await window.mathNotes.saveAnnotatedImage({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        fileName: input.fileName,
        sourcePath: input.sourcePath,
        pngDataUrl: input.pngDataUrl,
        operations: input.operations,
        annotations: input.annotations
      });
      setInsertMarkdownRequest({
        id: Date.now(),
        markdown: result.markdown
      });
      setImageAnnotationDraft(null);
      setSourceSaveState("dirty");
      showToast(`已插入图片引用：${result.assetPath}`);
    } catch (error) {
      showToast(`插入图片失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function retryRecognitionTask(recognitionJobId: string) {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能重试识别");
      return;
    }

    setLoadingTasks(true);
    clearRuntimeEvents();
    setOpenLayer("task");
    try {
      const task = await window.mathNotes.retryRecognitionTask({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        recognitionJobId
      });
      await loadCurrentSession();
      await loadRecognitionTasks();
      showToast(task.recognitionStatus === "succeeded" ? `识别重试完成：${task.fileName}` : `识别重试失败：${task.fileName}`);
    } catch (error) {
      showToast(`重试失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setLoadingTasks(false);
    }
  }

  async function cancelRecognitionTask(recognitionJobId: string) {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能中断识别");
      return;
    }

    try {
      const task = await window.mathNotes.cancelRecognitionTask({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        recognitionJobId
      });
      setRecognitionTasks((current) => upsertTaskSummary(current, task));
      showToast(`已中断识别：${task.fileName}`);
      await loadCurrentSession();
      await loadRecognitionTasks();
    } catch (error) {
      showToast(`中断失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function runLearningAssistant(input: AssistantWorkspaceSubmitInput) {
    if (!window.mathNotes || runningAssistantTaskId) return;
    if (["dirty", "error"].includes(sourceSaveState)) {
      const saved = await saveSourceDocument({ revealExport: false });
      if (!saved) return;
    }
    const taskId = `assistant_${Date.now()}`;
    setAssistantLastError(null);
    setRunningAssistantTaskId(taskId);
    try {
      const result = await window.mathNotes.runAssistantTask({
        taskId,
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        scope: input.focus.kind,
        activeBlockId: input.focus.blockId,
        selectedText: input.focus.excerpt,
        focusLabel: input.focus.label,
        mode: input.mode,
        question: input.question
      });
      await loadAssistantRemarks();
      if (result.status === "failed") {
        setAssistantLastError(result.error ?? "模型没有返回可用内容，请检查 Provider 设置后重试。");
      }
      showToast(
        result.status === "succeeded"
          ? "AI 学习旁注已生成，主笔记未修改"
          : result.status === "cancelled"
            ? "AI 学习助手已中断"
            : `AI 学习助手失败：${result.error ?? "unknown error"}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      setAssistantLastError(message);
      showToast(`AI 学习助手失败：${message}`);
    } finally {
      setRunningAssistantTaskId(null);
    }
  }

  async function promoteAssistantRemark(remarkId: string) {
    if (!window.mathNotes) return;
    try {
      const document = await window.mathNotes.promoteAssistantRemark({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        remarkId
      });
      applySessionDocument(document, { preserveViewport: true });
      showToast("旁注已转为独立笔记块");
    } catch (error) {
      showToast(`转为笔记块失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function deleteAssistantRemark(remarkId: string) {
    if (!window.mathNotes) return;
    try {
      await window.mathNotes.deleteAssistantRemark({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        remarkId
      });
      setSelectedAssistantRemarkId((current) => current === remarkId ? null : current);
      await loadAssistantRemarks();
    } catch (error) {
      showToast(`删除旁注失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function cancelLearningAssistant() {
    if (!window.mathNotes || !runningAssistantTaskId) return;
    const result = await window.mathNotes.cancelAssistantTask({ taskId: runningAssistantTaskId });
    showToast(result.cancelled ? "正在中断 AI 学习助手" : "当前学习助手任务已经结束");
  }

  async function controlPdfRecognitionBatch(action: "pause" | "resume" | "cancel", batchId: string) {
    if (!window.mathNotes) {
      showToast("浏览器预览模式暂不能控制 PDF 识别批次");
      return;
    }
    const input = {
      notebookId: currentSession.notebookId,
      sessionId: currentSession.sessionId,
      batchId
    };
    try {
      if (action === "pause") await window.mathNotes.pausePdfRecognitionBatch(input);
      if (action === "resume") await window.mathNotes.resumePdfRecognitionBatch(input);
      if (action === "cancel") await window.mathNotes.cancelPdfRecognitionBatch(input);
      showToast(action === "pause" ? "正在安全暂停 PDF 识别批次" : action === "resume" ? "已继续 PDF 识别批次" : "已中断 PDF 识别批次");
      window.setTimeout(() => void loadRecognitionTasks(), 250);
    } catch (error) {
      showToast(`批次操作失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function exportCurrentSession(options: ExportOptions) {
    if (!window.mathNotes) {
      setLastExportResult({
        outPath: "lecture_03.md",
        exportedBlocks: sourceDocument.markdownBlocks.length,
        packageDir: options.packageMode === "share" ? "lecture_03_share" : undefined,
        copiedAssets: options.packageMode === "share" ? [] : undefined
      });
      showToast(options.packageMode === "share" ? "浏览器预览模式：已导出分享包：lecture_03_share" : "浏览器预览模式：已导出 Markdown：lecture_03.md");
      return;
    }

    try {
      if (sourceSaveState !== "saved") {
        setSavingSource(true);
        setSourceSaveState("saving");
        const document = await window.mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText
        });
        applySessionDocument(document);
        setSavingSource(false);
      }
      const result = await window.mathNotes.exportCurrentSession({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        includeMetadataComments: options.includeMetadataComments,
        includeAssistantRemarks: options.includeAssistantRemarks,
        packageMode: options.packageMode
      });
      setLastExportResult(result);
      if (options.packageMode === "share" && result.packageDir) {
        await window.mathNotes.revealPath({ path: result.packageDir });
      }
      showToast(options.packageMode === "share" ? `已导出分享包：${result.packageDir ?? result.outPath}` : `已导出 Markdown：${result.outPath}`);
    } catch (error) {
      setSourceSaveState(sourceSaveState === "saved" ? "saved" : "error");
      showToast(`导出失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function revealExportPath(outPath: string) {
    if (!window.mathNotes) {
      showToast(`浏览器预览模式：定位导出文件 ${outPath}`);
      return;
    }

    try {
      await window.mathNotes.revealPath({ path: outPath });
      showToast("已定位导出文件");
    } catch (error) {
      showToast(`定位失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  function openAssetPreview(reference: { target: string; assetPath?: string; sourcePageNumber?: number }) {
    const preview = resolveSessionAssetPreview({
      sessionDir,
      target: reference.assetPath ?? reference.target,
      pageNumber: reference.sourcePageNumber
    });
    if (!preview) {
      showToast(`暂时找不到可预览素材：${reference.target}`);
      return;
    }
    setAssetPreview(preview);
    setHoverTip((current) => ({ ...current, visible: false }));
  }

  async function setActiveBlockLock(block: SessionSourceMarkdownBlock, locked: boolean) {
    if (!window.mathNotes) {
      showToast(locked ? "浏览器预览模式：已固定整块" : "浏览器预览模式：已解除整块固定");
      return;
    }

    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      await window.mathNotes.saveSessionSource({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        sourceText
      });
      const document = await window.mathNotes.setMarkdownBlockLock({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        blockId: block.blockId,
        locked
      });
      applySessionDocument(document);
      showToast(locked ? `已固定整块：${block.blockId}` : `已解除整块固定：${block.blockId}`);
    } catch (error) {
      setSourceSaveState("error");
      showToast(`整块固定失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function deleteMarkdownBlock(blockId: string) {
    if (!window.mathNotes) {
      showToast(`浏览器预览模式：已删除 block ${blockId}`);
      return;
    }

    const deletedIndex = sourceDocument.markdownBlocks.findIndex((block) => block.blockId === blockId);
    if (deletedIndex === -1) {
      setSavingSource(true);
      setSourceSaveState("saving");
      try {
        const document = await window.mathNotes.saveSessionSource({
          notebookId: currentSession.notebookId,
          sessionId: currentSession.sessionId,
          sourceText
        });
        applySessionDocument(document);
        showToast(`已清理失效 source header：${blockId}`);
      } catch (error) {
        setSourceSaveState("error");
        showToast(`清理失败：${error instanceof Error ? error.message : "unknown error"}`);
      } finally {
        setSavingSource(false);
      }
      return;
    }

    const nextVisibleBlock =
      deletedIndex > -1 ? sourceDocument.markdownBlocks[deletedIndex + 1] ?? sourceDocument.markdownBlocks[deletedIndex - 1] : undefined;

    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      await window.mathNotes.saveSessionSource({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        sourceText
      });
      const result = await window.mathNotes.deleteMarkdownBlock({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        blockId
      });
      const { document } = result;
      applySessionDocument(document, { preserveViewport: true });
      setUndoAction({
        type: "restoreDeletedBlock",
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        snapshot: result.undo
      });
      const targetBlock = nextVisibleBlock
        ? document.sourceDocument.markdownBlocks.find((block) => block.blockId === nextVisibleBlock.blockId)
        : undefined;
      if (targetBlock) {
        locateSource(sourceLocationFromBlock(targetBlock), 900);
      }
      showToast(`已删除 block：${blockId}，按 Ctrl+Z 可撤销`);
    } catch (error) {
      setSourceSaveState("error");
      showToast(`删除失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  function rerecognizeBlock(blockId: string) {
    const task = recognitionTasks.find((candidate) =>
      candidate.transcriptBlockId === blockId || candidate.imageBlockId === blockId
    );
    if (!task) {
      showToast(`block ${blockId} 没有关联的原始识别任务，无法安全重新识别`);
      return;
    }
    if (task.recognitionStatus === "running" || task.recognitionStatus === "pending") {
      showToast(`block ${blockId} 的识别任务仍在进行中`);
      return;
    }
    void retryRecognitionTask(task.recognitionJobId);
  }

  async function reorderSessionBlocks(blockIds: string[], direction: "up" | "down") {
    if (!window.mathNotes || blockIds.length === 0) return;
    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      await window.mathNotes.saveSessionSource({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        sourceText
      });
      const document = await window.mathNotes.reorderSessionBlocks({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        blockIds,
        direction
      });
      applySessionDocument(document, { preserveViewport: true });
      showToast(`已将 ${blockIds.length} 个块${direction === "up" ? "上移" : "下移"}，块编号按新顺序显示`);
    } catch (error) {
      setSourceSaveState("error");
      showToast(`调整顺序失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function openBlockTransfer(blockIds: string[], mode: "copy" | "move") {
    const mathNotes = window.mathNotes;
    if (!mathNotes || blockIds.length === 0) return;
    try {
      const catalog = await mathNotes.loadNotebooks();
      const groups = await Promise.all(catalog.map(async (notebook) => ({
        notebook,
        sessions: await mathNotes.loadNotebookSessions({ notebookId: notebook.notebookId })
      })));
      const targets = groups.flatMap(({ notebook, sessions }) => sessions
        .filter((session) => !(
          session.notebookId === currentSession.notebookId &&
          session.sessionId === currentSession.sessionId
        ))
        .map((session) => ({
          key: `${session.notebookId}\u0000${session.sessionId}`,
          notebookId: session.notebookId,
          notebookTitle: notebook.title,
          sessionId: session.sessionId,
          sessionTitle: session.title
        })));
      if (targets.length === 0) {
        showToast("请先新建另一个 Session，再移动或复制块");
        return;
      }
      setBlockTransferRequest({ blockIds, mode, targets });
    } catch (error) {
      showToast(`读取目标笔记失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function confirmBlockTransfer(target: BlockTransferTarget) {
    const request = blockTransferRequest;
    if (!window.mathNotes || !request) return;
    setSavingSource(true);
    setSourceSaveState("saving");
    try {
      await window.mathNotes.saveSessionSource({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        sourceText
      });
      const result = await window.mathNotes.transferSessionBlocks({
        sourceNotebookId: currentSession.notebookId,
        sourceSessionId: currentSession.sessionId,
        targetNotebookId: target.notebookId,
        targetSessionId: target.sessionId,
        blockIds: request.blockIds,
        mode: request.mode
      });
      applySessionDocument(result.document, { preserveViewport: request.mode === "copy" });
      setBlockTransferRequest(null);
      setNotebookSessions(await window.mathNotes.loadNotebookSessions({ notebookId: currentSession.notebookId }));
      if (result.sourceCleanupPending) {
        showToast("目标笔记已收到副本；来源清理未完成，为避免丢失已保留原块");
      } else {
        showToast(`已${request.mode === "copy" ? "复制" : "移动"} ${request.blockIds.length} 个块到「${target.sessionTitle}」`);
      }
    } catch (error) {
      setSourceSaveState("error");
      showToast(`${request.mode === "copy" ? "复制" : "移动"}失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSavingSource(false);
    }
  }

  function locateSource(location: PreviewSourceLocationInput, durationMs = 1800) {
    setOpenLayer(null);
    if (locatingClearTimerRef.current !== null) {
      window.clearTimeout(locatingClearTimerRef.current);
      locatingClearTimerRef.current = null;
    }
    const request = {
      ...location,
      nonce: (locatingNonceRef.current += 1)
    };
    setLocatingRequest(request);
    locatingClearTimerRef.current = window.setTimeout(() => {
      setLocatingRequest((current) => (current?.nonce === request.nonce ? null : current));
      locatingClearTimerRef.current = null;
    }, durationMs);
  }

  function locateSourceBySourceId(sourceId: string, durationMs = 1800) {
    const block = sourceDocument.markdownBlocks.find((candidate) => candidate.sourceId === sourceId);
    if (!block) {
      showToast(`没有找到对应源码块：${sourceId}`);
      return;
    }
    locateSource(sourceLocationFromBlock(block), durationMs);
  }

  function handleHover(event: MouseEvent<HTMLElement>, block: RenderBlock, location: PreviewSourceLocationInput) {
    const sourceLabel = block.sourceLabel ? `source: ${block.sourceLabel}` : "source";
    const blockLabel = block.sourceBlockId ? `block: ${block.sourceBlockId}` : block.sourceId;
    const lineLabel = location.lineInBlock ? `块内约第 ${location.lineInBlock} 行` : "块内位置";
    setHoverTip({
      visible: true,
      x: Math.min(event.clientX + 18, window.innerWidth - 260),
      y: Math.min(event.clientY + 18, window.innerHeight - 72),
      text: `${sourceLabel}\n${blockLabel} · ${lineLabel}`
    });
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    window.dispatchEvent(new Event("mathnotes:layout-anchor-start"));
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const minPaneWidth = 180;
    const clampedX = Math.max(minPaneWidth, Math.min(window.innerWidth - minPaneWidth, event.clientX));
    const nextWidth = (clampedX / window.innerWidth) * 100;
    sourceWidthRef.current = nextWidth;
    event.currentTarget.parentElement?.style.setProperty("--source-width", `${nextWidth}%`);
    window.dispatchEvent(new Event("mathnotes:layout-anchor-update"));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = "";
    setSourceWidth(sourceWidthRef.current);
    window.dispatchEvent(new Event("mathnotes:layout-anchor-end"));
  }

  async function controlWindow(action: "minimize" | "toggleMaximize" | "close") {
    if (action === "close" && temporaryMarkdownDocuments && !window.confirm("临时 Session 尚未保存到 Notebook。确定放弃并关闭吗？")) return;
    if (action === "close" && ["dirty", "error"].includes(sourceSaveState)) {
      setCloseConfirmOpen(true);
      return;
    }
    if (action === "close" && savingSource) {
      showToast("正在保存，完成后再关闭");
      return;
    }

    await performWindowControl(action);
  }

  async function performWindowControl(action: "minimize" | "toggleMaximize" | "close") {
    if (!window.mathNotes) {
      showToast(`浏览器预览模式：${windowControlLabel(action)}`);
      return;
    }

    try {
      await window.mathNotes.windowControl(action);
    } catch (error) {
      showToast(`窗口操作失败：${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async function saveAndCloseWindow() {
    setCloseConfirmOpen(false);
    const saved = await saveSourceDocument({ revealExport: false });
    if (saved) {
      await performWindowControl("close");
    }
  }

  function beginManualWindowDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || event.clientY > 40 || !window.mathNotes || openLayer) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, input, textarea, select, [role='button']")) return;
    manualWindowDragCandidateRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startClientX: event.clientX,
      startClientY: event.clientY,
      sourceEditorClick: Boolean(target?.closest(".source-window-drag-region"))
    };
  }

  function updateManualWindowDrag(event: PointerEvent<HTMLElement>) {
    const candidate = manualWindowDragCandidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId || !window.mathNotes) return;
    if (!manualWindowDraggingRef.current) {
      if (
        !exceedsWindowDragThreshold(
          { x: candidate.startClientX, y: candidate.startClientY },
          { x: event.clientX, y: event.clientY }
        )
      ) return;
      candidate.element.setPointerCapture(event.pointerId);
      manualWindowDraggingRef.current = true;
      manualWindowDragBeginPromiseRef.current = window.mathNotes.beginWindowDrag({
        screenX: candidate.startScreenX,
        screenY: candidate.startScreenY
      });
    }
    pendingWindowDragPositionRef.current = { screenX: event.screenX, screenY: event.screenY };
    if (windowDragFrameRef.current !== null) return;
    windowDragFrameRef.current = window.requestAnimationFrame(() => {
      windowDragFrameRef.current = null;
      const position = pendingWindowDragPositionRef.current;
      pendingWindowDragPositionRef.current = null;
      if (position && manualWindowDraggingRef.current && window.mathNotes) {
        void (manualWindowDragBeginPromiseRef.current ?? Promise.resolve()).then(() => window.mathNotes?.updateWindowDrag(position));
      }
    });
  }

  function endManualWindowDrag(event: PointerEvent<HTMLElement>, cancelled = false) {
    const candidate = manualWindowDragCandidateRef.current;
    if (!candidate || candidate.pointerId !== event.pointerId) return;
    manualWindowDragCandidateRef.current = null;
    const wasDragging = manualWindowDraggingRef.current;
    manualWindowDraggingRef.current = false;
    if (windowDragFrameRef.current !== null) {
      window.cancelAnimationFrame(windowDragFrameRef.current);
      windowDragFrameRef.current = null;
    }
    const finalPosition = pendingWindowDragPositionRef.current ?? { screenX: event.screenX, screenY: event.screenY };
    pendingWindowDragPositionRef.current = null;
    if (candidate.element.hasPointerCapture(event.pointerId)) {
      candidate.element.releasePointerCapture(event.pointerId);
    }
    if (!wasDragging || !window.mathNotes) {
      manualWindowDragBeginPromiseRef.current = null;
      if (!cancelled && candidate.sourceEditorClick) {
        window.dispatchEvent(
          new CustomEvent("mathnotes:source-top-edge-click", {
            detail: { clientX: event.clientX, clientY: event.clientY }
          })
        );
      }
      return;
    }
    const beginPromise = manualWindowDragBeginPromiseRef.current ?? Promise.resolve();
    manualWindowDragBeginPromiseRef.current = null;
    void beginPromise
      .then(() => window.mathNotes?.updateWindowDrag(finalPosition))
      .finally(() => window.mathNotes?.endWindowDrag());
  }

  async function handleMarkdownDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    setMarkdownDragActive(false);
    if (markdownDropBusy) return;
    setMarkdownDropBusy(true);
    try {
      const documents = await readMarkdownDropFiles(event.dataTransfer.files);
      if (temporaryMarkdownDocuments) {
        setTemporaryMarkdownDocuments([...temporaryMarkdownDocuments, ...documents]);
        showToast(`已向临时 Session 添加 ${documents.length} 个文本块`);
        return;
      }
      const hasPersistedSession = Boolean(
        window.mathNotes && nativeSessionLoaded && currentSession.notebookId && currentSession.sessionId
      );
      if (!hasPersistedSession) {
        setMarkdownDropChoice({ documents });
        return;
      }
      await appendMarkdownDocumentsToCurrentSession(documents);
    } catch (error) {
      showToast(`Markdown 导入失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setMarkdownDropBusy(false);
    }
  }

  async function appendMarkdownDocumentsToCurrentSession(documents: readonly MarkdownDropDocument[]) {
    if (!window.mathNotes) {
      setTemporaryMarkdownDocuments([...documents]);
      return;
    }
    if (sourceSaveStateRef.current !== "saved") {
      const saved = await saveSourceDocument({ revealExport: false });
      if (!saved) throw new Error("请先处理当前 Session 的未保存修改。");
    }
    let document: SessionDocument | undefined;
    for (const item of documents) {
      document = await window.mathNotes.createMarkdownBlock({
        notebookId: currentSession.notebookId,
        sessionId: currentSession.sessionId,
        markdown: item.markdown,
        sourceName: item.name
      });
    }
    if (document) applySessionDocument(document, { preserveViewport: true });
    await Promise.all([loadNotebookSessions(currentSession.notebookId), loadNotebooks()]);
    showToast(`已导入 ${documents.length} 个 Markdown 文本块`);
  }

  async function archiveMarkdownDocuments(
    documents: readonly MarkdownDropDocument[],
    destination: { kind: "existing"; notebookId: string } | { kind: "new"; title: string }
  ) {
    if (!window.mathNotes || documents.length === 0) return;
    setMarkdownDropBusy(true);
    try {
      const sessionTitle = markdownDropTitle(documents);
      let document = destination.kind === "existing"
        ? await window.mathNotes.createSession({ notebookId: destination.notebookId, title: sessionTitle })
        : await window.mathNotes.createNotebook({ title: destination.title });
      if (destination.kind === "new") {
        document = await window.mathNotes.renameSession({
          notebookId: document.notebookId,
          sessionId: document.sessionId,
          title: sessionTitle
        });
      }
      const starterBlock = document.editableBlocks[0]?.id;
      for (const item of documents) {
        document = await window.mathNotes.createMarkdownBlock({
          notebookId: document.notebookId,
          sessionId: document.sessionId,
          markdown: item.markdown,
          sourceName: item.name
        });
      }
      if (starterBlock) {
        document = (await window.mathNotes.deleteMarkdownBlock({
          notebookId: document.notebookId,
          sessionId: document.sessionId,
          blockId: starterBlock
        })).document;
      }
      applySessionDocument(document);
      setTemporaryMarkdownDocuments(null);
      setMarkdownDropChoice(null);
      setMarkdownArchiveOpen(false);
      await Promise.all([loadNotebooks(), loadNotebookSessions(document.notebookId)]);
      showToast(`已归档 ${documents.length} 个 Markdown 文本块`);
    } catch (error) {
      showToast(`Markdown 归档失败：${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setMarkdownDropBusy(false);
    }
  }

  const appStyle = {
    "--source-width": `${sourceWidthRef.current}%`,
    "--source-font-family": userSettings?.sourceFontFamily,
    "--source-font-size": userSettings ? `${userSettings.sourceFontSize}px` : undefined,
    "--preview-font-family": userSettings?.previewFontFamily,
    "--preview-font-size": userSettings ? `${userSettings.previewFontSize}px` : undefined
  } as React.CSSProperties;

  return (
    <main
      className={`app-shell ${openLayer ? "has-open-layer" : ""} ${readingMode ? "reading-only" : ""}`}
      onPointerCancelCapture={(event) => endManualWindowDrag(event, true)}
      onPointerDownCapture={(event) => {
        dismissLayerFromMainSurface(event);
        beginManualWindowDrag(event);
      }}
      onPointerMoveCapture={updateManualWindowDrag}
      onPointerUpCapture={endManualWindowDrag}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setMarkdownDragActive(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMarkdownDragActive(false);
      }}
      onDrop={(event) => void handleMarkdownDrop(event)}
      data-preview-projection-lab={previewProjectionLabEnabled ? "block-map" : "legacy"}
      data-preview-projection-reparsed={livePreviewProjection.stats?.reparsedBlockCount ?? ""}
      data-preview-projection-relocated={livePreviewProjection.stats?.relocatedBlockCount ?? ""}
      data-preview-projection-reused={livePreviewProjection.stats?.reusedBlockCount ?? ""}
      style={appStyle}
    >
      {markdownDragActive ? (
        <div className="markdown-drop-target" aria-hidden="true">
          <FileUp />
          <strong>放开以导入 Markdown</strong>
          <span>每个文件会成为一个独立文本块</span>
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="window-drag-region source-window-drag-region"
      />
      <div
        aria-hidden="true"
        className="window-drag-region preview-window-drag-region"
      />
      <section aria-label="Markdown source" className="split source-pane">
        <div
          aria-label="Primary controls"
          className="floating-group top-left"
          onPointerCancel={(event) => endManualWindowDrag(event, true)}
          onPointerDown={beginManualWindowDrag}
          onPointerMove={updateManualWindowDrag}
          onPointerUp={endManualWindowDrag}
        >
          <FloatingButton aria-label="笔记目录" icon={<Menu />} onClick={() => toggleLayer("notebook")} title="笔记目录" />
          <FloatingButton
            aria-label="保存"
            icon={<Save />}
            onClick={() => void saveSourceDocument()}
            title="保存"
          />
          <FloatingButton aria-label="搜索" icon={<Search />} onClick={() => toggleLayer("search")} title="搜索" />
        </div>

        {activeSourceBlock ? (
          <div className="source-context-bar" data-testid="source-context-bar">
            <button
              className="lock-selection-button"
              data-testid="block-lock-button"
              onClick={() => void setActiveBlockLock(activeSourceBlock, !activeSourceBlock.locked)}
              type="button"
            >
              {activeSourceBlock.locked ? "解除整块" : "固定整块"}
            </button>
            {selectionLockable ? (
              <button
                className="lock-selection-button"
                data-testid="lock-selection-button"
                onClick={() => setLockSelectionRequest((current) => current + 1)}
                type="button"
              >
                固定选区
              </button>
            ) : null}
            {protectedSpanUnlockable ? (
              <button
                className="lock-selection-button"
                data-testid="unlock-span-button"
                onClick={() => setUnlockProtectedSpanRequest((current) => current + 1)}
                type="button"
              >
                解除固定
              </button>
            ) : null}
            <em className={`source-save-state ${sourceSaveState}`}>{sourceSaveLabel(sourceSaveState)}</em>
            <span>块</span>
            <strong title={`${activeSourceBlock.blockId} · ${activeSourceBlock.header}`}>{`${activeSourceBlock.blockId} · ${activeSourceBlock.header}`}</strong>
          </div>
        ) : null}
        {backgroundRefreshPending ? (
          <RecognitionRefreshPending
            onSave={() => void saveSourceDocument()}
            saving={savingSource}
          />
        ) : null}
        {nativeSessionLoaded ? (
          <RenderCommitProbe id="source-editor">
            <SessionSourceEditor
              assistantRemarks={assistantRemarks}
              document={sourceDocument}
              insertMarkdownRequest={insertMarkdownRequest}
              key={`source-${currentSession.notebookId}-${currentSession.sessionId}`}
              locatingRequest={locatingRequest}
              lockSelectionRequest={lockSelectionRequest}
              onActiveBlockChange={setActiveSourceBlock}
              onAssistantRemarkOpen={(remarkId) => {
                setSelectedAssistantRemarkId(remarkId);
                setAssistantWorkspaceOpen(true);
              }}
              onChange={(text, projection?: SourceDocumentProjectionChange) => {
                sourceTextRef.current = text;
                setSourceText(text);
                if (previewProjectionLabEnabled) {
                  setPreviewProjection({
                    blockIds: sourceDocument.markdownBlocks.map((block) => block.blockId).join("\u0000"),
                    sourceText: text,
                    markdownByBlockId:
                      projection?.markdownByBlockId ?? createPreviewProjectionSnapshot({ ...sourceDocument, text }).markdownByBlockId
                  });
                }
                const nextSaveState = text === sourceDocument.text ? "saved" : "dirty";
                sourceSaveStateRef.current = nextSaveState;
                setSourceSaveState(nextSaveState);
              }}
              onProtectedSpanUnlockableChange={setProtectedSpanUnlockable}
              onProtectedSpanUnlocked={() => showToast("已解除选区固定，保存后更新 lock metadata")}
              onSelectionLockableChange={setSelectionLockable}
              onSelectionLocked={() => showToast("已固定选区，保存后写入 lock metadata")}
              onSourceReferenceClick={openAssetPreview}
              onDeleteBlockRequest={(blockId) => void deleteMarkdownBlock(blockId)}
              onCreateBlockAfterRequest={(blockId) => void createUserTextBlock(blockId)}
              onAiSelectionEditRequest={openSelectionEdit}
              onReorderBlocksRequest={(blockIds, direction) => void reorderSessionBlocks(blockIds, direction)}
              onRerecognizeBlockRequest={rerecognizeBlock}
              onTransferBlocksRequest={(blockIds, mode) => void openBlockTransfer(blockIds, mode)}
              assistantOpen={assistantWorkspaceOpen}
              unlockProtectedSpanRequest={unlockProtectedSpanRequest}
              value={sourceText}
            />
          </RenderCommitProbe>
        ) : (
          <div className="session-source-loading" data-testid="session-source-loading">
            正在加载当前 Session
          </div>
        )}

        <FloatingButton
          aria-label="任务与块信息"
          badge={pendingTaskCount + receivingUploadCount > 0 ? String(pendingTaskCount + receivingUploadCount) : undefined}
          className="task-button"
          icon={<ListChecks />}
          onClick={() => toggleLayer("task")}
          title="任务与块信息"
        />
        <div className={`source-create-menu ${sourceCreateMenuOpen ? "open" : ""}`}>
          <div className="source-create-options" role="menu">
            <button onClick={() => { setSourceCreateMenuOpen(false); void createUserTextBlock(); }} role="menuitem" type="button"><Plus /> 新建文本块</button>
            <button onClick={() => { setSourceCreateMenuOpen(false); void insertEmbeddedImage(); }} role="menuitem" type="button"><ImagePlus /> 插入图片</button>
            <button onClick={() => { setSourceCreateMenuOpen(false); void pickLocalPdf(); }} role="menuitem" type="button"><FileUp /> 导入 PDF</button>
          </div>
          <FloatingButton
            aria-expanded={sourceCreateMenuOpen}
            aria-label="添加内容"
            icon={sourceCreateMenuOpen ? <X /> : <Plus />}
            onClick={() => setSourceCreateMenuOpen((current) => !current)}
            title="添加内容"
          />
        </div>

        {codexRuntimeProgressVisible && providerRuntimeState ? (
          <ProviderRuntimeProgressToast state={providerRuntimeState} stacked={false} />
        ) : null}
      </section>

      <div
        aria-label="调整左右栏宽度"
        aria-orientation="vertical"
        className="split-handle"
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="separator"
      >
        <span />
      </div>

      <section aria-label="Rendered markdown preview" className="split preview-pane" data-testid="preview-pane">
        <div aria-label="阅读视图" className="floating-group preview-reading-controls top-left">
          {readingMode ? (
            <FloatingButton aria-label="笔记目录" icon={<Menu />} onClick={() => toggleLayer("notebook")} title="笔记目录" />
          ) : null}
          <FloatingButton
            aria-label={readingMode ? "退出阅读模式" : "进入阅读模式"}
            icon={readingMode ? <PanelLeftOpen /> : <BookOpen />}
            onClick={() => setReadingMode((current) => !current)}
            title={readingMode ? "显示 Markdown 源码区" : "收起源码区，只看渲染结果"}
          />
        </div>
        <div
          aria-label="Window controls"
          className="floating-group top-right"
          onPointerCancel={(event) => endManualWindowDrag(event, true)}
          onPointerDown={beginManualWindowDrag}
          onPointerMove={updateManualWindowDrag}
          onPointerUp={endManualWindowDrag}
        >
          <FloatingButton aria-label="最小化" icon={<Minus />} onClick={() => void controlWindow("minimize")} title="最小化" variant="small" />
          <FloatingButton aria-label="最大化" icon={<Square />} onClick={() => void controlWindow("toggleMaximize")} title="最大化" variant="small" />
          <FloatingButton aria-label="关闭" icon={<X />} onClick={() => void controlWindow("close")} title="关闭" variant="small" />
        </div>

        {previewSessionLoaded ? (
          <RenderCommitProbe id="preview-pane">
            <PreviewPane
              blocks={visiblePreviewBlocks}
              key={`preview-${currentSession.notebookId}-${currentSession.sessionId}`}
              sessionDir={sessionDir}
              onHover={handleHover}
              onLeave={() => setHoverTip((current) => ({ ...current, visible: false }))}
              onLocateSource={locateSource}
            />
          </RenderCommitProbe>
        ) : (
          <div className="session-preview-loading" data-testid="session-preview-loading" role="status">
            <span />
            正在渲染笔记
          </div>
        )}

        <div aria-label="Export and more" className="floating-group bottom-right">
          <FloatingButton aria-label="导出 Markdown" icon={<Upload />} onClick={() => toggleLayer("export")} title="导出 Markdown" />
          <FloatingButton aria-label="手机连接" icon={<Smartphone />} onClick={() => toggleLayer("more")} title="手机连接" variant="dark" />
        </div>
      </section>

      <NotebookDrawer
        notebookId={currentSession.notebookId}
        notebookTitle={activeNotebook?.title ?? currentSession.notebookId}
        notebooks={notebooks}
        onClose={() => setOpenLayer(null)}
        onCreateNotebook={() => void createNotebookEntry()}
        onCreateSession={() => void createSession()}
        onDeleteSession={(session) => void deleteNotebookSession(session)}
        onOpenSettings={() => {
          setOpenLayer(null);
          hideHoverTip();
          setSettingsOpen(true);
        }}
        onOpenSession={(session) => void openNotebookSession(session)}
        onOpenNotebook={(notebook) => void openNotebook(notebook)}
        onRenameSession={(session) => void renameNotebookSession(session)}
        openLayer={openLayer}
        sessions={notebookSessions}
        sessionId={currentSession.sessionId}
        sessionTitle={currentSession.title}
      />
      <MoreDrawer
        hasNativeApi={hasNativeApi}
        connectionDiagnostics={connectionDiagnostics}
        ingestServer={ingestServer}
        onClose={() => setOpenLayer(null)}
        onImportLocalPhoto={importLocalPhoto}
        onReloadSession={reloadSession}
        onCopyConnectionValue={(value) => void copyConnectionValue(value)}
        onCopyPairingToken={(token) => void copyPairingToken(token)}
        onRefreshIngestAddresses={() => void refreshIngestAddresses()}
        onRefreshDevicePairing={() => void refreshDevicePairing()}
        onRevokePairedDevice={(deviceId) => void revokePairedDevice(deviceId)}
        onStartIngest={startIngestServer}
        onSelectIngestHost={(host) => void setIngestDisplayHost(host)}
        onStopIngest={stopIngestServer}
        openLayer={openLayer}
      />
      <SettingsModal
        assistantProviderConfig={assistantProviderConfig}
        hasNativeApi={hasNativeApi}
        ingestServer={ingestServer}
        onCheckProviderHealth={checkCurrentProviderHealth}
        onClose={() => setSettingsOpen(false)}
        onCreateBackup={() => void createNotesBackup()}
        onPickDirectory={pickDirectory}
        onSaveProviderConfig={(input) => void saveProviderConfig(input)}
        onSaveAssistantProviderConfig={(input) => void saveAssistantProviderConfig(input)}
        onSavePromptConfig={(input) => void savePromptTemplateConfig(input)}
        onSaveNotationConfig={(input) => void saveNotationProfiles(input)}
        onUpdatePairingToken={updatePairingToken}
        onPreviewNotation={previewNotationPrompt}
        onPickProviderSelfTestImage={async () => {
          if (!window.mathNotes) {
            return { cancelled: true };
          }
          return window.mathNotes.pickImageForAnnotation();
        }}
        onRunProviderSelfTest={async (input) => {
          if (!window.mathNotes) {
            throw new Error("桌面诊断仅在 Electron 应用中可用。");
          }
          const result = await window.mathNotes.runProviderSelfTest(input);
          showToast(result.status === "succeeded" ? "单图识别管线自检通过" : `单图自检未通过：${result.status}`);
          return result;
        }}
        onExportDiagnosticReport={async () => {
          if (!window.mathNotes) {
            throw new Error("桌面诊断仅在 Electron 应用中可用。");
          }
          const result = await window.mathNotes.exportUserDiagnosticReport();
          if (!result.cancelled) {
            showToast("脱敏诊断报告已导出");
          }
          return result;
        }}
        onSave={(settings) => void saveUserSettings(settings)}
        open={settingsOpen}
        promptConfig={promptConfig}
        notationConfig={notationConfig}
        providerConfig={providerConfig}
        providerHealth={providerHealth}
        settings={userSettings}
      />
      <SearchPopover
        onClose={() => setOpenLayer(null)}
        onExport={() => showToast("已导出 Markdown：lecture_03.md")}
        onJump={locateSourceBySourceId}
        onQueryChange={setSearchQuery}
        openLayer={openLayer}
        query={searchQuery}
        results={searchResults}
      />
      <TaskPopoverWithEvents
        uploadActivities={companionUploadActivities}
        runtimeState={providerRuntimeState}
        loading={loadingTasks}
        onClose={() => setOpenLayer(null)}
        onExport={() => showToast("已导出 Markdown：lecture_03.md")}
        onJump={locateSourceBySourceId}
        onRetry={(recognitionJobId) => void retryRecognitionTask(recognitionJobId)}
        onCancelTask={(recognitionJobId) => void cancelRecognitionTask(recognitionJobId)}
        onPausePdfBatch={(batchId) => void controlPdfRecognitionBatch("pause", batchId)}
        onResumePdfBatch={(batchId) => void controlPdfRecognitionBatch("resume", batchId)}
        onCancelPdfBatch={(batchId) => void controlPdfRecognitionBatch("cancel", batchId)}
        openLayer={openLayer}
        tasks={recognitionTasks}
      />
      <AssistantWorkspaceWithRuntime
        answerFontFamily={userSettings?.assistantFontFamily}
        answerFontSize={userSettings?.assistantFontSize}
        error={assistantLastError}
        key={`${currentSession.notebookId}/${currentSession.sessionId}`}
        onlineEnabled={userSettings?.assistantOnlineEnabled !== false}
        onCancel={() => void cancelLearningAssistant()}
        onClose={() => setAssistantWorkspaceOpen(false)}
        onDeleteRemark={(remarkId) => void deleteAssistantRemark(remarkId)}
        onPromoteRemark={(remarkId) => void promoteAssistantRemark(remarkId)}
        onSelectedRemarkChange={setSelectedAssistantRemarkId}
        onEditSelection={(input) => {
          setAssistantWorkspaceOpen(false);
          openSelectionEdit(input);
        }}
        onSubmit={(input) => void runLearningAssistant(input)}
        open={assistantWorkspaceOpen}
        providerLabel={
          assistantProviderConfig
            ? getRecognitionProviderCapability(assistantProviderConfig.providerId).label
            : "未配置"
        }
        remarks={assistantRemarks}
        runtimeTaskId={runningAssistantTaskId}
        selectedRemarkId={selectedAssistantRemarkId}
        running={Boolean(runningAssistantTaskId)}
        contextBlocks={assistantContextBlocks}
        sessionDir={sessionDir}
      />
      <SelectionEditDialog
        draft={selectionEditDraft}
        onApply={() => void applySelectionEditProposal()}
        onCancel={() => void cancelSelectionEdit()}
        onGenerate={() => void generateSelectionEdit()}
        onInstructionChange={(instruction) => setSelectionEditDraft((current) => current ? {
          ...current, instruction, error: undefined
        } : null)}
        onRetry={() => {
          const proposal = selectionEditDraft?.proposal;
          if (proposal && window.mathNotes) {
            void window.mathNotes.cancelSelectionEdit({
              notebookId: proposal.notebookId,
              sessionId: proposal.sessionId,
              proposalId: proposal.id
            }).catch(() => undefined);
          }
          setSelectionEditDraft((current) => current ? { ...current, proposal: null, error: undefined } : null);
          void generateSelectionEdit();
        }}
      />
      <CloseConfirmPrompt
        onCancel={() => setCloseConfirmOpen(false)}
        onDiscard={() => {
          setCloseConfirmOpen(false);
          void performWindowControl("close");
        }}
        onSave={() => void saveAndCloseWindow()}
        open={closeConfirmOpen}
      />
      <MarkdownDropChoiceDialog
        busy={markdownDropBusy}
        request={markdownDropChoice}
        onCancel={() => setMarkdownDropChoice(null)}
        onCreate={() => {
          const documents = markdownDropChoice?.documents;
          if (documents) void archiveMarkdownDocuments(documents, { kind: "new", title: markdownDropTitle(documents) });
        }}
        onTemporary={() => {
          setTemporaryMarkdownDocuments(markdownDropChoice?.documents ?? []);
          setMarkdownDropChoice(null);
        }}
      />
      <TemporaryMarkdownReader
        documents={temporaryMarkdownDocuments}
        busy={markdownDropBusy}
        onClose={() => {
          if (window.confirm("临时 Session 尚未保存。确定放弃这些 Markdown 文本块吗？")) {
            setTemporaryMarkdownDocuments(null);
          }
        }}
        onSave={() => setMarkdownArchiveOpen(true)}
      />
      <MarkdownArchiveDialog
        busy={markdownDropBusy}
        documents={markdownArchiveOpen ? temporaryMarkdownDocuments : null}
        notebooks={notebooks}
        onCancel={() => setMarkdownArchiveOpen(false)}
        onConfirm={(destination) => {
          if (temporaryMarkdownDocuments) void archiveMarkdownDocuments(temporaryMarkdownDocuments, destination);
        }}
      />
      <SessionTitlePrompt
        onCancel={() => completeSessionTitlePrompt(null)}
        onConfirm={completeSessionTitlePrompt}
        request={sessionTitlePrompt}
      />
      <SessionDeleteConfirmPrompt
        onCancel={() => completeSessionDeletePrompt(false)}
        onConfirm={() => completeSessionDeletePrompt(true)}
        session={sessionDeletePrompt?.session ?? null}
      />
      <BlockTransferDialog
        busy={savingSource}
        onCancel={() => setBlockTransferRequest(null)}
        onConfirm={(target) => void confirmBlockTransfer(target)}
        request={blockTransferRequest}
      />
      <ExportPopover
        lastExportResult={lastExportResult}
        onClose={() => setOpenLayer(null)}
        onExport={(options) => {
          void exportCurrentSession(options);
        }}
        onRevealExport={(outPath) => void revealExportPath(outPath)}
        openLayer={openLayer}
      />
      {imageAnnotationDraft ? (
        <ImageAnnotationEditor
          draft={imageAnnotationDraft}
          onCancel={() => setImageAnnotationDraft(null)}
          onConfirm={(input) => void confirmAnnotatedImage(input)}
        />
      ) : null}
      {pdfImportDraft ? (
        <PdfImportDialog
          draft={pdfImportDraft}
          providerLabel={getRecognitionProviderCapability(providerConfig?.providerId).label}
          onCancel={() => setPdfImportDraft(null)}
          onConfirm={(input) => void confirmPdfImport(input)}
        />
      ) : null}
      <FloatingButton
        aria-label="AI 学习助手"
        className={`assistant-learning-button ${runningAssistantTaskId ? "active" : ""}`}
        icon={<BrainCircuit />}
        onClick={() => setAssistantWorkspaceOpen((current) => !current)}
        title="AI 学习助手"
      />
      <AssetPreviewOverlay
        preview={assetPreview}
        onClose={() => setAssetPreview(null)}
        onReveal={(path) => void revealExportPath(path)}
      />

      <div className="hover-tip" data-testid="hover-tip" style={{ display: hoverTip.visible ? "block" : "none", left: hoverTip.x, top: hoverTip.y }}>
        <span className="hover-tip-text" title={hoverTip.text}>{hoverTip.text}</span>
        <br />
        <span>点击定位源码</span>
      </div>
      <div className={`screen-toast ${toast ? "show" : ""}`} data-testid="screen-toast">
        {toast}
      </div>
      <div className={`scrim ${openLayer === "notebook" ? "open" : ""}`} onClick={() => setOpenLayer(null)} />
    </main>
  );
}

export function resolvePdfImportTarget(
  draft: Pick<PdfImportDraft, "notebookId" | "sessionId">,
  current: Pick<SessionDocument, "notebookId" | "sessionId">
): { notebookId: string; sessionId: string } {
  return {
    notebookId: draft.notebookId ?? current.notebookId,
    sessionId: draft.sessionId ?? current.sessionId
  };
}

export function enqueueToastMessage(current: string[], message: string): string[] {
  if (!message || current.at(-1) === message) {
    return current;
  }
  return [...current, message];
}

export function AssetPreviewOverlay({
  onClose,
  onReveal,
  preview
}: {
  onClose: () => void;
  onReveal: (path: string) => void;
  preview: AssetPreviewReference | null;
}) {
  return (
    <div className={`asset-preview-layer ${preview ? "open" : ""}`} data-testid={preview ? "asset-preview" : undefined}>
      {preview ? (
        <section aria-label="素材预览" className="asset-preview-card" role="dialog">
          <div className="asset-preview-head">
            <div>
              <span>素材预览</span>
              <strong>{preview.label}</strong>
            </div>
            <button aria-label="关闭素材预览" onClick={onClose} type="button">
              <X />
            </button>
          </div>
          <div className="asset-preview-body">
            {preview.mediaType === "pdf" ? (
              <PdfDocumentPreview
                label={preview.label}
                pageCount={1}
                pageNumbers={preview.pageNumber ? [preview.pageNumber] : undefined}
                sourceUrl={preview.previewUrl}
              />
            ) : (
              <img alt={preview.label} src={preview.previewUrl} />
            )}
          </div>
          <div className="asset-preview-actions">
            <code>{preview.assetPath}</code>
            <button onClick={() => onReveal(preview.absolutePath)} type="button">
              在文件夹中显示
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function SelectionEditDialog({
  draft,
  onApply,
  onCancel,
  onGenerate,
  onInstructionChange,
  onRetry
}: {
  draft: SelectionEditDraft | null;
  onApply: () => void;
  onCancel: () => void;
  onGenerate: () => void;
  onInstructionChange: (instruction: string) => void;
  onRetry: () => void;
}) {
  if (!draft) return null;
  const busy = draft.status !== "idle";
  return (
    <div className="selection-edit-layer" data-testid="selection-edit-dialog">
      <section aria-label="AI 修改选中文字" aria-modal="true" className="selection-edit-dialog" role="dialog">
        <header>
          <div><span>AI SELECTION EDIT</span><strong>修改 block {draft.blockId} 的精确选区</strong></div>
          <button aria-label="取消 AI 修改" disabled={busy} onClick={onCancel} type="button"><X /></button>
        </header>
        <label>
          修改要求
          <textarea
            autoFocus={!draft.proposal}
            disabled={busy || Boolean(draft.proposal)}
            onChange={(event) => onInstructionChange(event.target.value)}
            placeholder="例如：修正语病，但保留公式和原意"
            rows={3}
            value={draft.instruction}
          />
        </label>
        <div className="selection-edit-diff">
          <article>
            <span>原选区</span>
            <pre>{draft.selectedText}</pre>
          </article>
          <article>
            <span>AI 替换候选</span>
            <pre>{draft.proposal?.replacementMarkdown ?? (draft.status === "generating" ? "正在生成候选…" : "生成后将在这里显示；此时不会修改笔记。")}</pre>
          </article>
        </div>
        {draft.error ? <p className="selection-edit-error" role="alert">{draft.error}</p> : null}
        <footer>
          <button disabled={busy} onClick={onCancel} type="button">取消</button>
          {draft.proposal ? (
            <>
              <button disabled={busy} onClick={onRetry} type="button">重新生成</button>
              <button className="primary" disabled={busy} onClick={onApply} type="button">
                {draft.status === "applying" ? "正在应用…" : "应用修改"}
              </button>
            </>
          ) : (
            <button className="primary" disabled={busy || !draft.instruction.trim()} onClick={onGenerate} type="button">
              {draft.status === "generating" ? "正在生成…" : "生成修改候选"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function CloseConfirmPrompt({
  onCancel,
  onDiscard,
  onSave,
  open
}: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  open: boolean;
}) {
  return (
    <div className={`close-confirm-layer ${open ? "open" : ""}`} data-testid={open ? "close-confirm-prompt" : undefined}>
      <section aria-label="关闭前保存确认" className="close-confirm" role="dialog">
        <div className="close-confirm-head">
          <span>UNSAVED CHANGES</span>
          <button aria-label="取消关闭" onClick={onCancel} type="button">
            <X />
          </button>
        </div>
        <h2>关闭前保存吗？</h2>
        <p>当前 Session 还有未保存修改。保存会更新 block 文件，并同步生成合并 Markdown。</p>
        <div className="close-confirm-actions">
          <button onClick={onDiscard} type="button">
            不保存
          </button>
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary" onClick={onSave} type="button">
            保存并关闭
          </button>
        </div>
      </section>
    </div>
  );
}

function MarkdownDropChoiceDialog({
  busy,
  onCancel,
  onCreate,
  onTemporary,
  request
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: () => void;
  onTemporary: () => void;
  request: MarkdownDropChoice | null;
}) {
  return (
    <div className={`close-confirm-layer ${request ? "open" : ""}`} data-testid={request ? "markdown-drop-choice" : undefined}>
      <section aria-label="选择 Markdown 导入方式" className="close-confirm" role="dialog">
        <div className="close-confirm-head"><span>MARKDOWN IMPORT</span></div>
        <h2>当前没有打开 Session</h2>
        <p>已读取 {request?.documents.length ?? 0} 个 Markdown 文件。可以立即新建 Notebook 和 Session，也可以先进入不落盘的临时 Session 阅读。</p>
        <div className="close-confirm-actions">
          <button disabled={busy} onClick={onCancel} type="button">取消</button>
          <button disabled={busy} onClick={onTemporary} type="button">暂存阅读</button>
          <button className="primary" disabled={busy} onClick={onCreate} type="button">新建并归档</button>
        </div>
      </section>
    </div>
  );
}

function TemporaryMarkdownReader({
  busy,
  documents,
  onClose,
  onSave
}: {
  busy: boolean;
  documents: MarkdownDropDocument[] | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const blocks = useMemo(() => markdownDropRenderBlocks(documents ?? []), [documents]);
  if (!documents) return null;
  return (
    <section className="temporary-markdown-session" aria-label="临时 Markdown Session" data-testid="temporary-markdown-session">
      <header>
        <div>
          <span>TEMPORARY SESSION</span>
          <h2>{markdownDropTitle(documents)}</h2>
          <p>尚未归入任何 Notebook · {documents.length} 个文本块</p>
        </div>
        <div className="temporary-markdown-actions">
          <button disabled={busy} onClick={onClose} type="button">放弃</button>
          <button className="primary" disabled={busy} onClick={onSave} type="button"><Save /> 保存到笔记</button>
        </div>
      </header>
      <div className="temporary-markdown-preview">
        <PreviewPane
          blocks={blocks}
          forceStatic
          onHover={() => undefined}
          onLeave={() => undefined}
          onLocateSource={() => undefined}
        />
      </div>
    </section>
  );
}

function MarkdownArchiveDialog({
  busy,
  documents,
  notebooks,
  onCancel,
  onConfirm
}: {
  busy: boolean;
  documents: MarkdownDropDocument[] | null;
  notebooks: NotebookSummary[];
  onCancel: () => void;
  onConfirm: (destination: { kind: "existing"; notebookId: string } | { kind: "new"; title: string }) => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [notebookId, setNotebookId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  useEffect(() => {
    setNotebookId(notebooks[0]?.notebookId ?? "");
    setNewTitle(documents ? markdownDropTitle(documents) : "");
    setMode(notebooks.length ? "existing" : "new");
  }, [documents, notebooks]);
  return (
    <div className={`close-confirm-layer ${documents ? "open" : ""}`} data-testid={documents ? "markdown-archive-dialog" : undefined}>
      <section aria-label="选择临时 Session 所属笔记" className="close-confirm markdown-archive-dialog" role="dialog">
        <div className="close-confirm-head"><span>ARCHIVE SESSION</span></div>
        <h2>保存到哪个 Notebook？</h2>
        <p>保存后会创建「{documents ? markdownDropTitle(documents) : ""}」Session，每个文件仍是一个独立文本块。</p>
        <label><input checked={mode === "existing"} disabled={!notebooks.length} onChange={() => setMode("existing")} type="radio" /> 现有 Notebook</label>
        <select disabled={busy || mode !== "existing"} onChange={(event) => setNotebookId(event.target.value)} value={notebookId}>
          {notebooks.map((notebook) => <option key={notebook.notebookId} value={notebook.notebookId}>{notebook.title}</option>)}
        </select>
        <label><input checked={mode === "new"} onChange={() => setMode("new")} type="radio" /> 新建 Notebook</label>
        <input disabled={busy || mode !== "new"} onChange={(event) => setNewTitle(event.target.value)} value={newTitle} />
        <div className="close-confirm-actions">
          <button disabled={busy} onClick={onCancel} type="button">取消</button>
          <button className="primary" disabled={busy || (mode === "existing" ? !notebookId : !newTitle.trim())} onClick={() => onConfirm(mode === "existing" ? { kind: "existing", notebookId } : { kind: "new", title: newTitle.trim() })} type="button">{busy ? "正在保存" : "保存 Session"}</button>
        </div>
      </section>
    </div>
  );
}

function SessionTitlePrompt({
  onCancel,
  onConfirm,
  request
}: {
  onCancel: () => void;
  onConfirm: (value: string) => void;
  request: SessionTitlePromptRequest | null;
}) {
  const [value, setValue] = useState(request?.defaultValue ?? "");

  useEffect(() => {
    setValue(request?.defaultValue ?? "");
  }, [request?.defaultValue, request?.title]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm(value);
  }

  return (
    <div className={`session-title-prompt-layer ${request ? "open" : ""}`} data-testid={request ? "session-title-prompt" : undefined}>
      <form aria-label={request?.title ?? "Session 命名"} className="session-title-prompt" onSubmit={submit} role="dialog">
        <div className="session-title-prompt-head">
          <span>SESSION</span>
          <button aria-label="关闭命名弹窗" onClick={onCancel} type="button">
            <X />
          </button>
        </div>
        <h2>{request?.title ?? "命名 Session"}</h2>
        <label>
          <span>名称</span>
          <input
            autoFocus={Boolean(request)}
            onChange={(event) => setValue(event.target.value)}
            placeholder="输入一个便于回溯的名字"
            value={value}
          />
        </label>
        <div className="session-title-prompt-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button disabled={!value.trim()} type="submit">
            {request?.confirmLabel ?? "确认"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SessionDeleteConfirmPrompt({
  onCancel,
  onConfirm,
  session
}: {
  onCancel: () => void;
  onConfirm: () => void;
  session: NotebookSessionSummary | null;
}) {
  return (
    <div className={`close-confirm-layer ${session ? "open" : ""}`} data-testid={session ? "session-delete-confirm" : undefined}>
      <section aria-label="删除 Session 确认" className="close-confirm session-delete-confirm" role="dialog">
        <div className="close-confirm-head">
          <span>DELETE SESSION</span>
          <button aria-label="取消删除" onClick={onCancel} type="button">
            <X />
          </button>
        </div>
        <h2>删除 Session？</h2>
        <p>这会删除该 Session 文件夹，包括 blocks、assets、exports。此操作暂不可撤销。</p>
        <dl className="delete-session-facts">
          <div>
            <dt>标题</dt>
            <dd>{session?.title || "未命名"}</dd>
          </div>
          <div>
            <dt>Session ID</dt>
            <dd>{session?.sessionId}</dd>
          </div>
        </dl>
        <div className="close-confirm-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="danger" onClick={onConfirm} type="button">
            确认删除
          </button>
        </div>
      </section>
    </div>
  );
}

export function upsertCompanionUploadActivity(
  current: CompanionUploadActivityEvent[],
  event: CompanionUploadActivityEvent
): CompanionUploadActivityEvent[] {
  const identity = `${event.notebookId}/${event.sessionId}/${event.captureId ?? event.fileName ?? "upload"}`;
  return [
    event,
    ...current.filter(
      (candidate) =>
        `${candidate.notebookId}/${candidate.sessionId}/${candidate.captureId ?? candidate.fileName ?? "upload"}` !== identity
    )
  ].slice(0, 20);
}

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function BlockTransferDialog({
  busy,
  onCancel,
  onConfirm,
  request
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (target: BlockTransferTarget) => void;
  request: BlockTransferRequest | null;
}) {
  const [targetKey, setTargetKey] = useState("");
  useEffect(() => {
    setTargetKey(request?.targets[0]?.key ?? "");
  }, [request]);
  const target = request?.targets.find((candidate) => candidate.key === targetKey);
  return (
    <div className={`close-confirm-layer ${request ? "open" : ""}`} data-testid={request ? "block-transfer-dialog" : undefined}>
      <section aria-label="选择目标笔记" className="close-confirm block-transfer-dialog" role="dialog">
        <div className="close-confirm-head">
          <span>{request?.mode === "move" ? "MOVE BLOCKS" : "COPY BLOCKS"}</span>
          <button aria-label="取消" disabled={busy} onClick={onCancel} type="button"><X /></button>
        </div>
        <h2>{request?.mode === "move" ? "移动到其他 Session" : "复制到其他 Session"}</h2>
        <p>
          已选 {request?.blockIds.length ?? 0} 个块。移动会先写入目标，再从当前 Session 移除，避免中途失败造成内容丢失。
        </p>
        <label className="block-transfer-target">
          <span>目标笔记</span>
          <select disabled={busy} onChange={(event) => setTargetKey(event.target.value)} value={targetKey}>
            {(request?.targets ?? []).map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.notebookTitle} / {candidate.sessionTitle}
              </option>
            ))}
          </select>
        </label>
        <div className="close-confirm-actions">
          <button disabled={busy} onClick={onCancel} type="button">取消</button>
          <button disabled={busy || !target} onClick={() => target && onConfirm(target)} type="button">
            {busy ? "正在写入" : request?.mode === "move" ? "确认移动" : "确认复制"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ProviderRuntimeProgressToast({ state, stacked }: { state: ProviderRuntimeState; stacked: boolean }) {
  return (
    <div className={`codex-runtime-progress ${state.status} ${stacked ? "stacked" : ""}`} data-testid="codex-runtime-progress">
      <div>
        <strong>{providerRuntimeProgressTitle(state)}</strong>
        <small>{state.detail}</small>
      </div>
      <div aria-label="Provider runtime ready progress" className="codex-runtime-progress-track">
        <span style={{ width: `${Math.max(0, Math.min(100, state.progress))}%` }} />
      </div>
    </div>
  );
}

type WorkspaceLayoutAnchor = {
  blockId: string;
  offsetTop: number;
  scrollTop: number;
  scrollRange: number;
};

function isWorkspaceLayoutAnchorLabEnabled(): boolean {
  try {
    return window.localStorage.getItem("mathnotes:layout-anchor-lab") !== "off";
  } catch {
    return false;
  }
}

function useWorkspaceLayoutAnchorPreservation(enabled: boolean, sessionKey: string) {
  useEffect(() => {
    if (!enabled) return;

    const surfaces = [
      {
        blockSelector: "[data-testid='source-block'][data-block-id]",
        scrollerSelector: "[data-testid='session-source-editor']"
      },
      {
        blockSelector: "[data-testid='render-block'][data-block-id]",
        scrollerSelector: ".preview-scroll"
      }
    ];
    const cleanups: Array<() => void> = [];

    for (const surface of surfaces) {
      const scroller = document.querySelector<HTMLElement>(surface.scrollerSelector);
      if (!scroller) continue;
      let anchor: WorkspaceLayoutAnchor | null = null;
      let correctionFrame: number | null = null;
      let correctionGeneration = 0;

      const cancelCorrection = () => {
        correctionGeneration += 1;
        if (correctionFrame !== null) {
          window.cancelAnimationFrame(correctionFrame);
          correctionFrame = null;
        }
      };
      const preserveAnchor = (finalCorrection = false) => {
        const preserved = anchor;
        if (!preserved) return;
        cancelCorrection();
        const generation = correctionGeneration;
        let remainingFrames = finalCorrection ? 36 : 12;
        let stableFrames = 0;

        const settle = () => {
          if (!scroller.isConnected || generation !== correctionGeneration || remainingFrames <= 0) {
            correctionFrame = null;
            if (finalCorrection) anchor = null;
            return;
          }
          const block = findWorkspaceAnchorBlock(scroller, surface.blockSelector, preserved.blockId);
          if (block) {
            const delta = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - preserved.offsetTop;
            if (Math.abs(delta) > 0.5) {
              scroller.scrollTop += delta;
              stableFrames = 0;
            } else {
              stableFrames += 1;
            }
          } else if (preserved.scrollRange > 0) {
            const currentRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            const scaledScrollTop = preserved.scrollTop * (currentRange / preserved.scrollRange);
            if (Math.abs(scroller.scrollTop - scaledScrollTop) > 0.5) {
              scroller.scrollTop = scaledScrollTop;
            }
          }
          remainingFrames -= 1;
          if (!finalCorrection && stableFrames >= 2) {
            correctionFrame = null;
            if (finalCorrection) anchor = null;
            return;
          }
          correctionFrame = window.requestAnimationFrame(settle);
        };
        correctionFrame = window.requestAnimationFrame(settle);
      };
      const beginTransition = () => {
        cancelCorrection();
        anchor = captureWorkspaceLayoutAnchor(scroller, surface.blockSelector);
        scroller.dataset.workspaceLayoutAnchorBlockId = anchor?.blockId ?? "";
        scroller.dataset.workspaceLayoutAnchorOffsetTop = anchor ? String(anchor.offsetTop) : "";
      };
      const updateTransition = () => preserveAnchor(false);
      const endTransition = () => preserveAnchor(true);
      const onUserIntent = () => {
        cancelCorrection();
        anchor = null;
      };

      scroller.addEventListener("wheel", onUserIntent, { passive: true });
      scroller.addEventListener("pointerdown", onUserIntent, { passive: true });
      window.addEventListener("mathnotes:layout-anchor-start", beginTransition);
      window.addEventListener("mathnotes:layout-anchor-update", updateTransition);
      window.addEventListener("mathnotes:layout-anchor-end", endTransition);
      cleanups.push(() => {
        cancelCorrection();
        delete scroller.dataset.workspaceLayoutAnchorBlockId;
        delete scroller.dataset.workspaceLayoutAnchorOffsetTop;
        scroller.removeEventListener("wheel", onUserIntent);
        scroller.removeEventListener("pointerdown", onUserIntent);
        window.removeEventListener("mathnotes:layout-anchor-start", beginTransition);
        window.removeEventListener("mathnotes:layout-anchor-update", updateTransition);
        window.removeEventListener("mathnotes:layout-anchor-end", endTransition);
      });
    }

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [enabled, sessionKey]);
}

function finishWorkspaceLayoutAnchorTransition() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("mathnotes:layout-anchor-end"));
    });
  });
}

function captureWorkspaceLayoutAnchor(scroller: HTMLElement, blockSelector: string): WorkspaceLayoutAnchor | null {
  const scrollerRect = scroller.getBoundingClientRect();
  const centerY = scrollerRect.top + scrollerRect.height / 2;
  let nearest: { block: HTMLElement; distance: number } | null = null;
  for (const block of scroller.querySelectorAll<HTMLElement>(blockSelector)) {
    const rect = block.getBoundingClientRect();
    if (rect.bottom < scrollerRect.top || rect.top > scrollerRect.bottom) continue;
    const distance = Math.abs((rect.top + rect.height / 2) - centerY);
    if (!nearest || distance < nearest.distance) nearest = { block, distance };
  }
  const blockId = nearest?.block.dataset.blockId;
  if (!nearest || !blockId) return null;
  return {
    blockId,
    offsetTop: nearest.block.getBoundingClientRect().top - scrollerRect.top,
    scrollTop: scroller.scrollTop,
    scrollRange: Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  };
}

function findWorkspaceAnchorBlock(scroller: HTMLElement, blockSelector: string, blockId: string): HTMLElement | null {
  for (const block of scroller.querySelectorAll<HTMLElement>(blockSelector)) {
    if (block.dataset.blockId === blockId) return block;
  }
  return null;
}

function captureSessionViewport(): SessionViewportSnapshot {
  return {
    source: captureScrollPosition(".session-source-editor"),
    preview: captureScrollPosition(".preview-scroll")
  };
}

function captureScrollPosition(selector: string): ScrollPositionSnapshot | undefined {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return undefined;
  const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
  const nearBottomThreshold = Math.max(72, Math.min(240, element.clientHeight * 0.2));
  return {
    nearBottom: distanceFromBottom <= nearBottomThreshold,
    scrollTop: element.scrollTop
  };
}

function restoreSessionViewport(snapshot: SessionViewportSnapshot) {
  restoreScrollPosition(".session-source-editor", snapshot.source);
  restoreScrollPosition(".preview-scroll", snapshot.preview);
}

function restoreScrollPosition(selector: string, snapshot: ScrollPositionSnapshot | undefined) {
  if (!snapshot) return;
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return;
  if (snapshot.nearBottom) {
    settleScrollAtBottom(element);
    return;
  }
  settleScrollTop(element, snapshot.scrollTop);
}

function settleScrollAtBottom(element: HTMLElement) {
  let remainingFrames = 36;
  let stableFrames = 0;
  let lastMaximumTop = -1;
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
    cleanup();
  };
  const cleanup = () => {
    element.removeEventListener("wheel", cancel);
    element.removeEventListener("pointerdown", cancel);
  };
  element.addEventListener("wheel", cancel, { passive: true });
  element.addEventListener("pointerdown", cancel, { passive: true });

  const settle = () => {
    if (!element.isConnected || cancelled || remainingFrames <= 0) {
      cleanup();
      return;
    }

    const maximumTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = maximumTop;
    stableFrames = Math.abs(maximumTop - lastMaximumTop) <= 0.5 ? stableFrames + 1 : 0;
    lastMaximumTop = maximumTop;
    remainingFrames -= 1;
    // The virtual preview can publish a delayed row measurement after the first
    // quiet frames. Keep following the bottom through a short quiet window so
    // that late measurements do not leave the viewport one row above the end.
    if (stableFrames < 12) window.requestAnimationFrame(settle);
    else cleanup();
  };

  settle();
}

function settleScrollTop(element: HTMLElement, desiredTop: number) {
  let remainingFrames = 24;
  let stableFrames = 0;
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
    cleanup();
  };
  const cleanup = () => {
    element.removeEventListener("wheel", cancel);
    element.removeEventListener("pointerdown", cancel);
  };
  element.addEventListener("wheel", cancel, { passive: true });
  element.addEventListener("pointerdown", cancel, { passive: true });

  const settle = () => {
    if (!element.isConnected || cancelled || remainingFrames <= 0) {
      cleanup();
      return;
    }
    const maximumTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextTop = Math.min(desiredTop, maximumTop);
    element.scrollTop = nextTop;
    stableFrames = Math.abs(element.scrollTop - desiredTop) <= 0.5 ? stableFrames + 1 : 0;
    remainingFrames -= 1;
    if (stableFrames < 2) window.requestAnimationFrame(settle);
    else cleanup();
  };

  settle();
}

function sourceSaveLabel(state: SourceSaveState): string {
  switch (state) {
    case "dirty":
      return "未保存";
    case "saving":
      return "保存中";
    case "error":
      return "保存失败";
    case "saved":
      return "已保存";
  }
}

export function recognitionTaskToastTitle(task: RecognitionTaskSummary): string {
  switch (task.recognitionStatus) {
    case "running":
      return "正在识别";
    case "failed":
      return task.failureKind === "output_anomaly" ? "异常输出已停止，可重试" : "识别失败，可重试";
    case "cancelled":
      return "识别已中断";
    case "pending":
      return "照片已进入队列";
    case "succeeded":
      return "最近照片已识别";
  }
}

export function RecognitionRefreshPending({
  saving,
  onSave
}: {
  saving: boolean;
  onSave(): void;
}) {
  return (
    <div className="recognition-refresh-pending" data-testid="recognition-refresh-pending" role="status">
      <span>
        <strong>新的识别结果已到达</strong>
        当前源码有未保存改动；为避免覆盖，保存后会自动载入新结果。
      </span>
      <button disabled={saving} onClick={onSave} type="button">
        {saving ? "正在保存" : "保存并载入"}
      </button>
    </div>
  );
}

function windowControlLabel(action: "minimize" | "toggleMaximize" | "close"): string {
  switch (action) {
    case "minimize":
      return "最小化";
    case "toggleMaximize":
      return "最大化/还原";
    case "close":
      return "关闭";
  }
}

function isInsideCodeMirror(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".cm-editor"));
}

function sourceLocationFromBlock(block: SessionSourceMarkdownBlock): PreviewSourceLocationInput {
  return {
    blockId: block.blockId,
    displayBlockId: block.blockId,
    sourceId: block.sourceId,
    lineInBlock: 1
  };
}

function upsertTaskSummary(tasks: RecognitionTaskSummary[], task: RecognitionTaskSummary): RecognitionTaskSummary[] {
  const nextTasks = tasks.filter((candidate) => candidate.recognitionJobId !== task.recognitionJobId);
  nextTasks.push(task);
  return nextTasks.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt)).slice(0, 20);
}

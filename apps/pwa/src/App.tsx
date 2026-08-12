import {
  BookOpenText,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  HardDrive,
  ImagePlus,
  Link2,
  LogOut,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Trash2,
  TriangleAlert,
  UploadCloud,
  WifiOff,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type TouchEvent
} from "react";
import { CompanionApiClient, CompanionApiError } from "./apiClient";
import { companionStorage, saveCapabilityReport } from "./appStorage";
import { readPwaCapabilities } from "./capabilities";
import { retainAvailableSelection, sameTarget } from "./catalogSelection";
import {
  applyCaptureEdit,
  createCaptureThumbnail,
  DEFAULT_CAPTURE_EDIT,
  rotateCapture,
  type CaptureCrop,
  type CaptureEdit
} from "./captureEditing";
import { createClientId } from "./clientId";
import type {
  CachedAsset,
  CachedCatalog,
  CachedSession,
  CompanionHostCapabilities,
  DeviceCredential,
  PairingTarget,
  UploadMaterialKind,
  UploadTask
} from "./domain";
import { sessionCacheKey } from "./domain";
import {
  credentialMatchesPageOrigin,
  migrateCredentialOrigin,
  normalizeCompanionOrigin
} from "./pairing";
import { registerMathNotesPwa, type PwaUpdateState } from "./pwaRegistration";
import { createReaderDocument } from "./readerDocument";
import { syncCatalog, syncSession, type SessionSyncStage } from "./sessionSync";
import type { SseMessage } from "./sse";
import {
  createUploadTask,
  ForegroundUploadQueue,
  isFullyComplete,
  migratePendingUploadTasks
} from "./uploadQueue";

type SyncState = "idle" | "syncing" | "live" | "offline" | "failed";
type PersistenceState = "unknown" | "granted" | "best-effort" | "unavailable";
const LEGACY_HOST_CAPABILITIES: CompanionHostCapabilities = {
  imageUpload: true,
  pdfUpload: false,
  recognitionStatus: false,
  recognitionRetry: false
};
const PWA_BUILD_LABEL = "2026.07.29.13";

export default function App() {
  const [booting, setBooting] = useState(true);
  const [credential, setCredential] = useState<DeviceCredential>();
  const [profileId, setProfileId] = useState("");
  const [catalog, setCatalog] = useState<CachedCatalog>();
  const [selected, setSelected] = useState<PairingTarget>();
  const [session, setSession] = useState<CachedSession>();
  const [assets, setAssets] = useState<CachedAsset[]>([]);
  const [readerHtml, setReaderHtml] = useState("");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [syncMessage, setSyncMessage] = useState("");
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string>();
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [pwaState, setPwaState] = useState<PwaUpdateState>({ offlineReady: false, updateReady: false });
  const [applyUpdate, setApplyUpdate] = useState<(() => Promise<void>) | undefined>();
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [persistenceState, setPersistenceState] = useState<PersistenceState>("unknown");
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileCaptureOpen, setMobileCaptureOpen] = useState(false);
  const requestGeneration = useRef(0);
  const touchStart = useRef<number | undefined>(undefined);
  const bootStarted = useRef(false);
  const lastReconcileAt = useRef(0);
  const uploadQueue = useRef<ForegroundUploadQueue | undefined>(undefined);
  const sessionRefreshFlight = useRef<{
    key: string;
    queued: boolean;
    promise: Promise<void>;
  } | undefined>(undefined);

  const loadUploadTasks = useCallback(async (activeProfileId: string) => {
    if (!activeProfileId) {
      setUploadTasks([]);
      return;
    }
    const tasks = await companionStorage.loadUploadTasks(activeProfileId);
    setUploadTasks(tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }, []);

  const loseAuthorization = useCallback(async (message = "配对已失效，请重新配对。") => {
    await companionStorage.clearCredential();
    setCredential(undefined);
    setSyncState("offline");
    setSyncMessage(message);
    setPairingOpen(true);
  }, []);

  const refreshCatalog = useCallback(async (activeCredential = credential) => {
    if (!activeCredential) return undefined;
    setSyncState("syncing");
    try {
      const api = new CompanionApiClient(activeCredential.origin);
      const next = await syncCatalog(api, companionStorage, activeCredential);
      setCatalog(next);
      setProfileId(activeCredential.deviceId);
      setSelected((current) => {
        return retainAvailableSelection(current, next.targets);
      });
      setSyncState("live");
      setSyncMessage("");
      setLastSuccessfulSyncAt(new Date().toISOString());
      return next;
    } catch (error) {
      if (isUnauthorized(error)) await loseAuthorization();
      else {
        setSyncState(navigator.onLine ? "failed" : "offline");
        setSyncMessage(userMessage(error, "目录暂时无法更新，正在显示离线缓存。"));
      }
      return undefined;
    }
  }, [credential, loseAuthorization]);

  const refreshSession = useCallback(async () => {
    if (!selected || !credential) return;
    const key = `${credential.deviceId}\u0000${selected.notebookId}\u0000${selected.sessionId}`;
    const active = sessionRefreshFlight.current;
    if (active?.key === key) {
      active.queued = true;
      return active.promise;
    }

    const generation = ++requestGeneration.current;
    const api = new CompanionApiClient(credential.origin);
    const flight = {
      key,
      queued: false,
      promise: Promise.resolve()
    };
    const run = async () => {
      do {
        flight.queued = false;
        setSyncState("syncing");
        setSyncMessage("正在更新笔记");
        try {
          const result = await syncSession({
            api,
            storage: companionStorage,
            credential,
            target: selected,
            onStage: (stage: SessionSyncStage, body) => {
              if (generation !== requestGeneration.current) return;
              if (body && stage === "body") setSession(body);
              setSyncMessage(stageLabel(stage));
            }
          });
          if (generation !== requestGeneration.current) return;
          setSession(result.session);
          setAssets(await companionStorage.loadSessionAssets(
            credential.deviceId,
            selected.notebookId,
            selected.sessionId
          ));
          setSyncState("live");
          setSyncMessage(result.assetFailures > 0 ? `${result.assetFailures} 张图片等待网络恢复` : "");
          setLastSuccessfulSyncAt(new Date().toISOString());
        } catch (error) {
          if (generation !== requestGeneration.current) return;
          if (flight.queued) continue;
          if (isUnauthorized(error)) await loseAuthorization();
          else if (isTargetUnavailable(error)) {
            setSelected(undefined);
            setSession(undefined);
            setAssets([]);
            await refreshCatalog(credential);
          } else {
            setSyncState(navigator.onLine ? "failed" : "offline");
            setSyncMessage(userMessage(error, "更新失败，正在显示离线缓存。"));
          }
        }
      } while (flight.queued && sessionRefreshFlight.current === flight);
    };
    flight.promise = run().finally(() => {
      if (sessionRefreshFlight.current === flight) sessionRefreshFlight.current = undefined;
    });
    sessionRefreshFlight.current = flight;
    return flight.promise;
  }, [credential, loseAuthorization, refreshCatalog, selected]);

  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    const apply = registerMathNotesPwa(setPwaState);
    setApplyUpdate(() => apply);
    const report = readPwaCapabilities();
    if (report.indexedDb === "available") void saveCapabilityReport(report);
    void (async () => {
      try {
        if (navigator.storage?.persisted) {
          setPersistenceState(await navigator.storage.persisted() ? "granted" : "best-effort");
        } else {
          setPersistenceState("unavailable");
        }
        const loadedCredential = await companionStorage.loadCredential();
        const storedCredential = loadedCredential
          ? migrateCredentialOrigin(loadedCredential, window.location.origin)
          : undefined;
        const activeCredential = storedCredential &&
          credentialMatchesPageOrigin(storedCredential, window.location.origin)
          ? storedCredential
          : undefined;
        if (loadedCredential && activeCredential && loadedCredential.origin !== activeCredential.origin) {
          await companionStorage.saveCredential(activeCredential);
        }
        if (storedCredential && !activeCredential) {
          await companionStorage.clearCredential();
          setPairingOpen(true);
          setSyncState("offline");
          setSyncMessage("上次凭据属于另一台电脑。请先打开目标电脑地址，再填写那台电脑显示的令牌。");
        }
        const storedProfileId = storedCredential?.deviceId ?? await companionStorage.loadLastProfileId() ?? "";
        setCredential(activeCredential);
        setProfileId(storedProfileId);
        if (storedProfileId) {
          const cachedCatalog = await companionStorage.loadCatalog(storedProfileId);
          setCatalog(cachedCatalog);
          setSelected(cachedCatalog?.activeTarget ?? cachedCatalog?.targets[0]);
        }
        if (activeCredential && navigator.onLine) await refreshCatalog(activeCredential);
      } catch (error) {
        setSyncState("failed");
        setSyncMessage(userMessage(error, "本地笔记缓存暂时不可用。"));
      } finally {
        setBooting(false);
      }
    })();
  }, [refreshCatalog]);

  useEffect(() => {
    void loadUploadTasks(profileId);
  }, [loadUploadTasks, profileId]);

  useEffect(() => {
    uploadQueue.current?.stop();
    uploadQueue.current = undefined;
    if (!credential) return;
    const api = new CompanionApiClient(credential.origin);
    const queue = new ForegroundUploadQueue({
      profileId: credential.deviceId,
      repository: companionStorage,
      transport: {
        upload: (task, signal) => api.uploadMaterial(
          credential.token,
          credential.deviceId,
          task,
          signal
        )
      },
      onChange: () => loadUploadTasks(credential.deviceId)
    });
    uploadQueue.current = queue;
    void queue.recover().then(() => navigator.onLine ? queue.drain() : undefined);
    return () => {
      queue.stop();
      if (uploadQueue.current === queue) uploadQueue.current = undefined;
    };
  }, [credential, loadUploadTasks]);

  useEffect(() => {
    if (!selected || !profileId) {
      setSession(undefined);
      setAssets([]);
      return;
    }
    const generation = ++requestGeneration.current;
    void (async () => {
      const cached = await companionStorage.loadSession(
        sessionCacheKey(profileId, selected.notebookId, selected.sessionId)
      );
      if (generation !== requestGeneration.current) return;
      setSession(cached);
      setAssets(await companionStorage.loadSessionAssets(profileId, selected.notebookId, selected.sessionId));
      if (credential && navigator.onLine) await refreshSession();
      else {
        setSyncState("offline");
        setSyncMessage(cached ? "离线阅读" : "这篇笔记尚未缓存在本机");
      }
    })();
  }, [credential, profileId, refreshSession, selected]);

  useEffect(() => {
    if (!session) {
      setReaderHtml("");
      return;
    }
    let active = true;
    let document: Awaited<ReturnType<typeof createReaderDocument>> | undefined;
    void (async () => {
      try {
        document = await createReaderDocument(
          session,
          assets.filter((asset) => asset.mimeType !== "application/pdf")
        );
        if (active) setReaderHtml(document.html);
        else document.dispose();
      } catch (error) {
        if (!active) return;
        setReaderHtml("");
        setSyncMessage(userMessage(error, "笔记正文暂时无法显示。"));
      }
    })();
    return () => {
      active = false;
      document?.dispose();
    };
  }, [assets, session]);

  useEffect(() => {
    if (!credential || !navigator.onLine) return;
    const controller = new AbortController();
    const api = new CompanionApiClient(credential.origin);
    const cursorKey = `${credential.deviceId}:catalog`;
    void (async () => {
      const initialLastEventId = await companionStorage.loadEventCursor(cursorKey);
      if (controller.signal.aborted) return;
      await reconnectingStream({
        api,
        path: "/api/v1/companion/catalog-events",
        token: credential.token,
        signal: controller.signal,
        initialLastEventId,
        saveLastEventId: (cursor) => companionStorage.saveEventCursor(cursorKey, cursor),
        onMessage: (message) => {
          if (message.event === "catalog-changed" || message.event === "resync-required") {
            void refreshCatalog(credential);
          }
        },
        onConnection: () => setSyncState("live"),
        onAuthorizationLost: () => void loseAuthorization()
      });
    })();
    return () => controller.abort();
  }, [credential, loseAuthorization, refreshCatalog]);

  useEffect(() => {
    if (!credential || !selected || !navigator.onLine) return;
    const controller = new AbortController();
    const api = new CompanionApiClient(credential.origin);
    const query = new URLSearchParams({
      notebookId: selected.notebookId,
      sessionId: selected.sessionId
    });
    const cursorKey = `${credential.deviceId}:session:${selected.notebookId}:${selected.sessionId}`;
    void (async () => {
      const initialLastEventId = await companionStorage.loadEventCursor(cursorKey);
      if (controller.signal.aborted) return;
      await reconnectingStream({
        api,
        path: `/api/v1/companion/events?${query}`,
        token: credential.token,
        signal: controller.signal,
        initialLastEventId,
        saveLastEventId: (cursor) => companionStorage.saveEventCursor(cursorKey, cursor),
        onMessage: (message) => {
          if (message.event === "session-changed" || message.event === "resync-required") {
            void refreshSession();
          }
          if (message.event === "session-deleted") {
            setSelected(undefined);
            setSession(undefined);
            void refreshCatalog(credential);
          }
        },
        onConnection: () => setSyncState("live"),
        onAuthorizationLost: () => void loseAuthorization()
      });
    })();
    return () => controller.abort();
  }, [credential, loseAuthorization, refreshCatalog, refreshSession, selected]);

  useEffect(() => {
    const online = () => {
      if (credential) {
        void refreshCatalog(credential);
        void uploadQueue.current?.drain();
      }
    };
    const offline = () => {
      setSyncState("offline");
      setSyncMessage("网络已断开，正在显示离线缓存");
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [credential, refreshCatalog]);

  useEffect(() => {
    const resumeUploads = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void uploadQueue.current?.drain();
      }
    };
    document.addEventListener("visibilitychange", resumeUploads);
    window.addEventListener("focus", resumeUploads);
    return () => {
      document.removeEventListener("visibilitychange", resumeUploads);
      window.removeEventListener("focus", resumeUploads);
    };
  }, []);

  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState !== "visible" || !credential || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastReconcileAt.current < 1_500) return;
      lastReconcileAt.current = now;
      if (selected) void refreshSession();
      else void refreshCatalog(credential);
    };
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("focus", reconcile);
    const timer = window.setInterval(reconcile, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("focus", reconcile);
      window.clearInterval(timer);
    };
  }, [credential, refreshCatalog, refreshSession, selected]);

  const handleTouchStart = (event: TouchEvent) => {
    if (event.currentTarget.scrollTop === 0) touchStart.current = event.touches[0]?.clientY;
  };
  const handleTouchMove = (event: TouchEvent) => {
    if (touchStart.current === undefined) return;
    setPullDistance(Math.min(92, Math.max(0, (event.touches[0]?.clientY ?? touchStart.current) - touchStart.current)));
  };
  const handleTouchEnd = () => {
    if (pullDistance >= 64) {
      if (selected) void refreshSession();
      else void refreshCatalog();
    }
    touchStart.current = undefined;
    setPullDistance(0);
  };

  const filteredTargets = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return catalog?.targets ?? [];
    return (catalog?.targets ?? []).filter((target) =>
      [target.notebookTitle, target.notebookId, target.title, target.sessionId]
        .some((value) => value?.toLocaleLowerCase().includes(query))
    );
  }, [catalog, searchQuery]);
  const groups = useMemo(() => groupTargets(filteredTargets), [filteredTargets]);
  const hostCapabilities = catalog?.capabilities ?? LEGACY_HOST_CAPABILITIES;
  const captureTarget = selected ?? catalog?.activeTarget ?? catalog?.targets[0];
  const showPairing = pairingOpen || (!credential && !catalog);

  const queueMaterials = useCallback(async (
    files: readonly File[],
    kind: UploadMaterialKind,
    target: PairingTarget
  ) => {
    if (!credential || files.length === 0) return;
    const persistenceRequest = requestPersistentStorage();
    for (const file of files) {
      const previewBytes = kind === "image" ? await createCaptureThumbnail(file) : undefined;
      await companionStorage.saveUploadTask(createUploadTask({
        profileId: credential.deviceId,
        kind,
        file,
        previewBytes,
        target
      }));
    }
    setPersistenceState(await persistenceRequest);
    await loadUploadTasks(credential.deviceId);
    if (navigator.onLine) void uploadQueue.current?.drain();
  }, [credential, loadUploadTasks]);

  const refreshRecognitionTasks = useCallback(async () => {
    if (!credential || !(catalog?.capabilities?.recognitionStatus)) return;
    const pending = (await companionStorage.loadUploadTasks(credential.deviceId)).filter((task) =>
      task.status === "succeeded" &&
      Boolean(task.uploadId) &&
      Boolean(task.recognitionJobId) &&
      (task.recognitionStatus === "pending" || task.recognitionStatus === "running")
    );
    if (pending.length === 0) return;
    const api = new CompanionApiClient(credential.origin);
    await Promise.all(pending.map(async (task) => {
      try {
        const result = await api.fetchUploadStatus(credential.token, task.uploadId!);
        await companionStorage.saveUploadTask({
          ...task,
          ...result,
          lastError: result.recognitionStatus === "failed" || result.recognitionStatus === "cancelled"
            ? result.recognitionWarnings?.[0] ?? "电脑端识别没有完成，可以重新识别。"
            : undefined,
          updatedAt: new Date().toISOString()
        });
      } catch (error) {
        if (isUnauthorized(error)) await loseAuthorization();
      }
    }));
    await loadUploadTasks(credential.deviceId);
  }, [catalog?.capabilities?.recognitionStatus, credential, loadUploadTasks, loseAuthorization]);

  const retryRecognition = useCallback(async (task: UploadTask) => {
    if (!credential || !task.uploadId) return;
    try {
      const api = new CompanionApiClient(credential.origin);
      const result = await api.retryRecognition(credential.token, task.uploadId);
      await companionStorage.saveUploadTask({
        ...task,
        ...result,
        lastError: undefined,
        updatedAt: new Date().toISOString()
      });
      await loadUploadTasks(credential.deviceId);
    } catch (error) {
      await companionStorage.saveUploadTask({
        ...task,
        lastError: userMessage(error, "识别重试没有开始。"),
        updatedAt: new Date().toISOString()
      });
      await loadUploadTasks(credential.deviceId);
    }
  }, [credential, loadUploadTasks]);

  useEffect(() => {
    if (!credential || !(catalog?.capabilities?.recognitionStatus)) return;
    void refreshRecognitionTasks();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void refreshRecognitionTasks();
      }
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [catalog?.capabilities?.recognitionStatus, credential, refreshRecognitionTasks]);

  if (booting) return <LoadingScreen />;

  return (
    <main className={`companion-app ${selected ? "session-open" : ""}`}>
      <header className="app-header">
        <img src="/icons/mathnotes-192.png" alt="" className="brand-mark" />
        <div className="brand-copy">
          <span>MathNotes</span>
          <strong>我的笔记</strong>
        </div>
        <ConnectionState
          expanded={connectionDetailsOpen}
          onToggle={() => setConnectionDetailsOpen((current) => !current)}
          state={syncState}
        />
        <button
          className="icon-button"
          type="button"
          onClick={() => selected ? void refreshSession() : void refreshCatalog()}
          title="立即刷新"
          aria-label="立即刷新"
        >
          <RefreshCw size={19} className={syncState === "syncing" ? "spinning" : ""} />
        </button>
      </header>
      {connectionDetailsOpen && (
        <ConnectionDetails
          lastSuccessfulSyncAt={lastSuccessfulSyncAt}
          message={syncMessage}
          onClose={() => setConnectionDetailsOpen(false)}
          onRetry={() => selected ? void refreshSession() : void refreshCatalog()}
          origin={credential?.origin}
          state={syncState}
        />
      )}

      {pwaState.updateReady && (
        <div className="update-banner">
          <Download size={17} />
          <span>新版本已准备好</span>
          <button type="button" onClick={() => void applyUpdate?.()}>更新</button>
        </div>
      )}

      <div
        className={`workspace ${pullDistance > 0 ? "pulling" : ""} ${pullDistance >= 64 ? "pull-ready" : ""}`}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className={`pull-indicator ${pullDistance >= 64 ? "ready" : ""}`}>
          <RefreshCw size={16} />
          {pullDistance >= 64 ? "松开刷新" : "下拉刷新"}
        </div>

        <aside className="catalog-pane" aria-label="笔记目录">
          {!credential && catalog && (
            <button className="offline-callout" type="button" onClick={() => setPairingOpen(true)}>
              <WifiOff size={18} />
              <span><strong>当前仅离线阅读</strong><small>重新配对以继续同步</small></span>
              <ChevronRight size={18} />
            </button>
          )}
          {credential && captureTarget && (
            <button
              className="catalog-capture-cta"
              type="button"
              onClick={() => setMobileCaptureOpen(true)}
            >
              <Camera size={20} />
              <span>
                <strong>采集到笔记</strong>
                <small>{captureTarget.notebookTitle} / {captureTarget.title}</small>
              </span>
              <ChevronRight size={18} />
            </button>
          )}
          {(catalog?.targets.length ?? 0) > 0 && (
            <label className="catalog-search">
              <Search size={17} />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索 Notebook 或 Session"
                aria-label="搜索 Notebook 或 Session"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery("")} aria-label="清除搜索">
                  <X size={15} />
                </button>
              )}
            </label>
          )}
          {groups.length === 0 ? (
            <div className="empty-state">
              <BookOpenText size={28} />
              <h2>{searchQuery ? "没有匹配的笔记" : "还没有可阅读的笔记"}</h2>
              <p>{searchQuery
                ? "换一个 Notebook、Session 名称或编号试试。"
                : credential ? "电脑目录为空，或尚未同步完成。" : "先与运行 MathNotes 的电脑配对。"}</p>
              {!credential && <button className="primary-button" type="button" onClick={() => setPairingOpen(true)}>开始配对</button>}
            </div>
          ) : (
            <div className="notebook-list">
              {groups.map((group) => (
                <section className="notebook-group" key={group.notebookId}>
                  <div className="notebook-heading">
                    <span>Notebook</span>
                    <h2>{group.title}</h2>
                    <small>{group.sessions.length} 个 Session</small>
                  </div>
                  <div className="session-list">
                    {group.sessions.map((target) => (
                      <button
                        type="button"
                        key={`${target.notebookId}/${target.sessionId}`}
                        className={selected && sameTarget(target, selected) ? "active" : ""}
                        onClick={() => setSelected(target)}
                      >
                        <span>{target.title}</span>
                        <small>{target.sessionId}</small>
                        <ChevronRight size={17} />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {credential && (catalog?.targets.length ?? 0) > 0 && (
            <CapturePanel
              targets={catalog?.targets ?? []}
              preferredTarget={selected ?? catalog?.activeTarget}
              tasks={uploadTasks}
              capabilities={hostCapabilities}
              persistenceState={persistenceState}
              onFiles={queueMaterials}
              onRetry={(id) => void uploadQueue.current?.retry(id)}
              onRetryRecognition={(task) => void retryRecognition(task)}
              onRemove={(id) => void uploadQueue.current?.remove(id)}
              onClearSucceeded={() => void uploadQueue.current?.clearSucceeded()}
            />
          )}
          <div className="catalog-actions">
            <button type="button" onClick={() => setPairingOpen(true)}><Link2 size={17} />重新配对</button>
            {credential && (
              <button type="button" onClick={() => void loseAuthorization("已退出同步，离线缓存仍保留。")}>
                <LogOut size={17} />退出同步
              </button>
            )}
            <span className="build-label">PWA {PWA_BUILD_LABEL}</span>
          </div>
        </aside>

        <section className="reader-pane" aria-label="笔记阅读">
          <div className="reader-toolbar">
            <button className="back-button" type="button" onClick={() => setSelected(undefined)}>
              <ChevronLeft size={19} />返回目录
            </button>
            <div>
              <strong>{selected?.title ?? "选择一篇笔记"}</strong>
              <small>{syncMessage || statusLabel(syncState)}</small>
            </div>
            {credential && selected && (
              <button
                className="reader-capture-button"
                type="button"
                onClick={() => setMobileCaptureOpen(true)}
              >
                <Camera size={17} />采集
              </button>
            )}
          </div>
          {assets.some((asset) => asset.mimeType === "application/pdf") && (
            <PdfAttachmentBar assets={assets.filter((asset) => asset.mimeType === "application/pdf")} />
          )}
          {session && readerHtml ? (
            <iframe
              className="reader-frame"
              title={session.title}
              srcDoc={readerHtml}
              sandbox=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="reader-empty">
              {syncState === "syncing" ? <RefreshCw className="spinning" size={26} /> : <BookOpenText size={30} />}
              <h2>{syncState === "syncing" ? "正在读取笔记" : "选择 Session 开始阅读"}</h2>
              <p>{syncMessage || "正文会保存在本机，断网后仍可重新打开。"}</p>
            </div>
          )}
        </section>
      </div>

      {mobileCaptureOpen && credential && captureTarget && (
        <div className="mobile-capture-layer" role="dialog" aria-modal="true" aria-label="采集到当前 Session">
          <button
            className="mobile-capture-backdrop"
            type="button"
            aria-label="关闭采集"
            onClick={() => setMobileCaptureOpen(false)}
          />
          <div className="mobile-capture-sheet">
            <div className="mobile-capture-title">
              <div>
                <strong>采集到当前 Session</strong>
                <small>{captureTarget.notebookTitle} / {captureTarget.title}</small>
              </div>
              <button type="button" onClick={() => setMobileCaptureOpen(false)} aria-label="关闭采集">
                <X size={18} />
              </button>
            </div>
            <CapturePanel
              targets={catalog?.targets ?? []}
              preferredTarget={captureTarget}
              tasks={uploadTasks}
              capabilities={hostCapabilities}
              persistenceState={persistenceState}
              onFiles={async (files, kind, target) => {
                await queueMaterials(files, kind, target);
              }}
              onRetry={(id) => void uploadQueue.current?.retry(id)}
              onRetryRecognition={(task) => void retryRecognition(task)}
              onRemove={(id) => void uploadQueue.current?.remove(id)}
              onClearSucceeded={() => void uploadQueue.current?.clearSucceeded()}
            />
          </div>
        </div>
      )}

      {showPairing && (
        <PairingSheet
          canClose={Boolean(catalog)}
          initialOrigin={credential?.origin ?? window.location.origin}
          onClose={() => setPairingOpen(false)}
          onPaired={async (nextCredential, nextCatalog) => {
            await migratePendingUploadTasks(
              companionStorage,
              profileId,
              nextCredential.deviceId,
              nextCatalog.targets
            );
            setCredential(nextCredential);
            setProfileId(nextCredential.deviceId);
            setCatalog(nextCatalog);
            setSelected(nextCatalog.activeTarget ?? nextCatalog.targets[0]);
            setPairingOpen(false);
            setSyncState("live");
            setSyncMessage("");
          }}
        />
      )}
      {pwaState.registrationError && (
        <div className="toast error"><TriangleAlert size={17} />离线组件暂不可用，在线阅读不受影响。</div>
      )}
    </main>
  );
}

function PairingSheet({
  canClose,
  initialOrigin,
  onClose,
  onPaired
}: {
  canClose: boolean;
  initialOrigin: string;
  onClose(): void;
  onPaired(credential: DeviceCredential, catalog: CachedCatalog): Promise<void>;
}) {
  const [pairingToken, setPairingToken] = useState("");
  const [serverAddress, setServerAddress] = useState(initialOrigin);
  const [customOriginOpen, setCustomOriginOpen] = useState(
    () => normalizeCompanionOrigin(initialOrigin, window.location.origin) !== window.location.origin
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const address = customOriginOpen ? serverAddress : window.location.origin;
      if (!address.trim()) {
        throw new Error("请输入电脑端显示的电脑地址。");
      }
      const origin = normalizeCompanionOrigin(address, window.location.origin);
      if (window.location.protocol === "https:" && origin.startsWith("http:")) {
        throw new Error(
          "当前页面使用 HTTPS，浏览器不能连接 HTTP 电脑地址。请使用电脑的 Tailscale HTTPS 地址，或从可信局域网的 HTTP 页面打开 MathNotes。"
        );
      }
      if (customOriginOpen) {
        window.location.assign(`${origin}/`);
        return;
      }
      const api = new CompanionApiClient(origin);
      const token = pairingToken.trim();
      if (!token) throw new Error("请输入电脑端显示的配对令牌。");
      await api.verify(token);
      const nextCredential: DeviceCredential = {
        id: "active",
        version: 1,
        origin,
        token,
        deviceId: createClientId("manual"),
        deviceLabel: deviceLabel(),
        verifiedAt: new Date().toISOString()
      };
      await companionStorage.saveCredential(nextCredential);
      const nextCatalog = await syncCatalog(api, companionStorage, nextCredential);
      await onPaired(nextCredential, nextCatalog);
    } catch (pairingError) {
      setError(userMessage(pairingError, "配对没有完成，请检查内容后重试。"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="sheet-backdrop" role="presentation">
      <section className="pairing-sheet" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        {canClose && (
          <button className="sheet-close" type="button" onClick={onClose} aria-label="关闭配对">
            <X size={20} />
          </button>
        )}
        <img src="/icons/mathnotes-192.png" alt="" className="pairing-mark" />
        <span className="eyebrow">只读同步</span>
        <h1 id="pairing-title">连接你的 MathNotes</h1>
        <p>当前电脑地址会自动使用。首次填写配对令牌后，刷新或重新打开都会自动恢复连接。</p>
        <form onSubmit={pair}>
          {!customOriginOpen ? (
            <div className="pairing-origin" aria-label="电脑地址">
              <span>电脑地址</span>
              <strong>{window.location.origin}</strong>
              <small>已自动使用当前打开的电脑地址</small>
            </div>
          ) : (
            <label>
              <span>其他电脑地址</span>
              <input
                type="text"
                value={serverAddress}
                onChange={(event) => setServerAddress(event.target.value)}
                placeholder="https://电脑名.tailnet.ts.net"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <small>将先打开这台电脑提供的 MathNotes 页面，再填写它显示的配对令牌。</small>
            </label>
          )}
          {!customOriginOpen && (
            <label>
              <span>配对令牌</span>
              <input
                type="password"
                value={pairingToken}
                onChange={(event) => setPairingToken(event.target.value)}
                required
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {error && <div className="form-error"><TriangleAlert size={16} />{error}</div>}
          <button className="primary-button" type="submit" disabled={pending}>
            {pending ? <RefreshCw className="spinning" size={18} /> : <Link2 size={18} />}
            {pending ? "正在处理" : customOriginOpen ? "打开这台电脑" : "连接电脑"}
          </button>
        </form>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setCustomOriginOpen((value) => !value);
            setError("");
          }}
        >
          {customOriginOpen ? "使用当前电脑地址" : "连接其他电脑"}
        </button>
        <small className="secure-note">地址与令牌只保存在本机；修改电脑令牌后只需重新输入一次。</small>
      </section>
    </div>
  );
}


export function CapturePanel({
  targets,
  preferredTarget,
  tasks,
  capabilities,
  persistenceState,
  onFiles,
  onRetry,
  onRetryRecognition,
  onRemove,
  onClearSucceeded
}: {
  targets: readonly PairingTarget[];
  preferredTarget?: PairingTarget | null;
  tasks: readonly UploadTask[];
  capabilities: CompanionHostCapabilities;
  persistenceState: PersistenceState;
  onFiles(files: readonly File[], kind: UploadMaterialKind, target: PairingTarget): Promise<void>;
  onRetry(id: string): void;
  onRetryRecognition(task: UploadTask): void;
  onRemove(id: string): void;
  onClearSucceeded(): void;
}) {
  const groups = useMemo(() => groupTargets(targets), [targets]);
  const initialTarget = preferredTarget && targets.some((target) => sameTarget(target, preferredTarget))
    ? preferredTarget
    : targets[0];
  const [notebookId, setNotebookId] = useState(initialTarget?.notebookId ?? "");
  const [sessionId, setSessionId] = useState(initialTarget?.sessionId ?? "");
  const [expanded, setExpanded] = useState(true);
  const [captureDrafts, setCaptureDrafts] = useState<CaptureDraft[]>([]);
  const [captureDraftIndex, setCaptureDraftIndex] = useState(0);
  const [captureError, setCaptureError] = useState("");
  const [isPreparingBatch, setIsPreparingBatch] = useState(false);
  const [editAfterCapture, setEditAfterCapture] = useState(false);
  const [batchEditorOpen, setBatchEditorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const uploadQueueElement = useRef<HTMLDivElement>(null);
  const imageHistory = tasks.filter((task) => task.kind === "image");
  const recentImageTask = imageHistory[0];
  const recentPreviewUrl = useBlobUrl(recentImageTask?.previewBytes ?? recentImageTask?.bytes);

  useEffect(() => {
    if (targets.some((target) => target.notebookId === notebookId && target.sessionId === sessionId)) return;
    setNotebookId(initialTarget?.notebookId ?? "");
    setSessionId(initialTarget?.sessionId ?? "");
  }, [initialTarget, notebookId, sessionId, targets]);

  const sessions = groups.find((group) => group.notebookId === notebookId)?.sessions ?? [];
  const target = targets.find((item) => item.notebookId === notebookId && item.sessionId === sessionId)
    ?? sessions[0]
    ?? initialTarget;
  const activeTasks = tasks.filter((task) => !isFullyComplete(task)).length;
  const succeededTasks = tasks.length - activeTasks;

  const selectNotebook = (nextNotebookId: string) => {
    const firstSession = groups.find((group) => group.notebookId === nextNotebookId)?.sessions[0];
    setNotebookId(nextNotebookId);
    setSessionId(firstSession?.sessionId ?? "");
  };

  const appendImageFiles = (files: readonly File[], openEditor: boolean) => {
    if (files.length === 0) return;
      const firstNewIndex = captureDrafts.length;
      setCaptureDrafts((current) => [
        ...current,
        ...files.map((file) => ({
          id: createClientId("capture-draft"),
          file,
          edit: DEFAULT_CAPTURE_EDIT
        }))
      ]);
      setCaptureDraftIndex(firstNewIndex);
      setBatchEditorOpen(openEditor);
      setCaptureError("");
  };

  const acceptFiles = async (event: ChangeEvent<HTMLInputElement>, kind: UploadMaterialKind) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!target || files.length === 0) return;
    if (kind === "image") {
      if (editAfterCapture) {
        appendImageFiles(files, true);
      } else {
        await onFiles(files, kind, target);
      }
      return;
    }
    await onFiles(files, kind, target);
  };

  const confirmCaptureBatch = async () => {
    if (!target || captureDrafts.length === 0) return;
    setIsPreparingBatch(true);
    setCaptureError("");
    try {
      const edited = await Promise.all(captureDrafts.map((draft) => applyCaptureEdit(draft.file, draft.edit)));
      await onFiles(edited, "image", target);
      setCaptureDrafts([]);
      setCaptureDraftIndex(0);
      setBatchEditorOpen(false);
    } catch (error) {
      setCaptureError(userMessage(error, "照片编辑结果没有保存，请重试。"));
    } finally {
      setIsPreparingBatch(false);
    }
  };

  return (
    <>
    <section className="capture-panel" aria-labelledby="capture-title">
      <button className="capture-heading" type="button" onClick={() => setExpanded((value) => !value)}>
        <span>
          <UploadCloud size={18} />
          <span>
            <strong id="capture-title">采集与上传</strong>
            <small>{activeTasks > 0 ? `${activeTasks} 项待完成` : "素材会先保存在本机"}</small>
          </span>
        </span>
        <ChevronRight className={expanded ? "expanded" : ""} size={18} />
      </button>
      {expanded && (
        <div className="capture-body">
          <div className="target-pickers">
            <label>
              <span>Notebook</span>
              <select value={notebookId} onChange={(event) => selectNotebook(event.target.value)}>
                {groups.map((group) => (
                  <option key={group.notebookId} value={group.notebookId}>{group.title}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Session</span>
              <select value={target?.sessionId ?? ""} onChange={(event) => setSessionId(event.target.value)}>
                {sessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>{session.title}</option>
                ))}
              </select>
            </label>
          </div>

          {capabilities.imageUpload && (
            <div className="capture-photo-row">
              <button
                type="button"
                className="capture-photo-button"
                onClick={() => cameraInput.current?.click()}
              >
                <Camera size={18} />
                <span>拍照</span>
              </button>
              <button
                type="button"
                className={`capture-edit-toggle ${editAfterCapture ? "active" : ""}`}
                role="switch"
                aria-checked={editAfterCapture}
                onClick={() => setEditAfterCapture((value) => !value)}
              >
                <span>拍后编辑</span>
                <strong>{editAfterCapture ? "开" : "关"}</strong>
              </button>
            </div>
          )}

          <div className="capture-actions-row">
            <div className="capture-actions">
            {capabilities.imageUpload && (
              <button type="button" onClick={() => galleryInput.current?.click()}>
                <ImagePlus size={18} /><span>相册</span>
              </button>
            )}
            {capabilities.pdfUpload && (
              <button type="button" onClick={() => pdfInput.current?.click()}>
                <FileText size={18} /><span>PDF</span>
              </button>
            )}
            </div>
            {recentImageTask && (
              <button
                className="recent-capture-thumbnail"
                type="button"
                aria-label="查看最近采集历史"
                onClick={() => setHistoryOpen(true)}
              >
                {recentPreviewUrl
                  ? <img src={recentPreviewUrl} alt="" />
                  : <CheckCircle2 size={22} />}
                <span>最近</span>
              </button>
            )}
          </div>
          {capabilities.imageUpload && (
            <small className="capture-system-note">
              使用手机系统相机与厂商防抖。浏览器返回后，点“拍照”继续下一张。
            </small>
          )}
          {captureDrafts.length > 0 && (
            <div className="capture-current-batch" aria-label="本次采集批次">
              <div className="capture-current-batch-heading">
                <span>
                  <strong>本次采集 {captureDrafts.length} 张</strong>
                  <small>点缩略图原地放大、左右切换或编辑</small>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setCaptureDrafts([]);
                    setCaptureDraftIndex(0);
                    setBatchEditorOpen(false);
                  }}
                  disabled={isPreparingBatch}
                >
                  清空
                </button>
              </div>
              <div className="capture-editor-thumbnails">
                {captureDrafts.map((draft, index) => (
                  <CaptureDraftThumbnail
                    key={draft.id}
                    draft={draft}
                    active={index === captureDraftIndex}
                    onClick={() => {
                      setCaptureDraftIndex(index);
                      setBatchEditorOpen(true);
                    }}
                  />
                ))}
                <button
                  className="capture-more-thumbnail"
                  type="button"
                  onClick={() => cameraInput.current?.click()}
                  aria-label="再拍一张"
                >
                  <Camera size={20} />
                </button>
              </div>
              {captureError && <p className="capture-editor-error">{captureError}</p>}
              <button
                className="capture-confirm-batch"
                type="button"
                onClick={() => void confirmCaptureBatch()}
                disabled={isPreparingBatch}
              >
                {isPreparingBatch ? "正在准备…" : `确认上传 ${captureDrafts.length} 张`}
              </button>
            </div>
          )}
          {(!capabilities.imageUpload || !capabilities.pdfUpload) && (
            <small className="capability-note">
              {!capabilities.imageUpload && !capabilities.pdfUpload
                ? "当前电脑版本没有开放手机采集；更新 Mac 主机后会自动出现。"
                : !capabilities.pdfUpload
                  ? "当前电脑版本尚未开放 PDF 入库；更新 Mac 主机后会自动出现。"
                  : "当前电脑版本尚未开放图片采集。"}
            </small>
          )}
          <input
            ref={cameraInput}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => void acceptFiles(event, "image")}
          />
          <input
            ref={galleryInput}
            className="visually-hidden"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => void acceptFiles(event, "image")}
          />
          <input
            ref={pdfInput}
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(event) => void acceptFiles(event, "pdf")}
          />

          <div className={`storage-note ${persistenceState}`}>
            <HardDrive size={15} />
            <span>{persistenceLabel(persistenceState)}</span>
          </div>

          {tasks.length > 0 && (
            <div className="upload-queue" ref={uploadQueueElement}>
              <div className="queue-heading">
                <strong>本机队列</strong>
                {succeededTasks > 0 && (
                  <button type="button" onClick={onClearSucceeded}>清除已完成</button>
                )}
              </div>
              <div className="upload-task-list">
                {tasks.map((task) => (
                  <UploadTaskCard
                    key={task.id}
                    task={task}
                    canRetryRecognition={capabilities.recognitionRetry}
                    onRetry={() => onRetry(task.id)}
                    onRetryRecognition={() => onRetryRecognition(task)}
                    onRemove={() => onRemove(task.id)}
                  />
                ))}
              </div>
            </div>
          )}
          <small className="foreground-note">
            iPhone 可能暂停后台网页；重新打开本应用或恢复网络后会继续上传。
          </small>
        </div>
      )}
    </section>
    {batchEditorOpen && captureDrafts.length > 0 && target && (
      <CaptureBatchEditor
        drafts={captureDrafts}
        activeIndex={Math.min(captureDraftIndex, captureDrafts.length - 1)}
        target={target}
        error={captureError}
        isPreparing={isPreparingBatch}
        onActiveIndex={setCaptureDraftIndex}
        onEdit={(id, edit) => {
          setCaptureDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, edit } : draft));
        }}
        onDelete={(id) => {
          setCaptureDrafts((current) => current.filter((draft) => draft.id !== id));
          setCaptureDraftIndex((current) => Math.max(0, current - 1));
        }}
        onCaptureMore={() => {
          cameraInput.current?.click();
        }}
        onCancel={() => setBatchEditorOpen(false)}
        onConfirm={() => void confirmCaptureBatch()}
      />
    )}
    {historyOpen && imageHistory.length > 0 && (
      <CaptureHistoryViewer tasks={imageHistory} onClose={() => setHistoryOpen(false)} />
    )}
    </>
  );
}

type CaptureDraft = Readonly<{
  id: string;
  file: File;
  edit: CaptureEdit;
}>;

export function CaptureBatchEditor({
  drafts,
  activeIndex,
  target,
  error,
  isPreparing,
  onActiveIndex,
  onEdit,
  onDelete,
  onCaptureMore,
  onCancel,
  onConfirm
}: {
  drafts: readonly CaptureDraft[];
  activeIndex: number;
  target: PairingTarget;
  error: string;
  isPreparing: boolean;
  onActiveIndex(index: number): void;
  onEdit(id: string, edit: CaptureEdit): void;
  onDelete(id: string): void;
  onCaptureMore(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const active = drafts[activeIndex] ?? drafts[0];
  const previewUrl = useBlobUrl(active?.file);
  if (!active) return null;
  const setCrop = (crop: CaptureCrop) => onEdit(active.id, { ...active.edit, crop });

  return (
    <div className="capture-editor-layer" role="dialog" aria-modal="true" aria-label="素材预览与拍后编辑">
      <div className="capture-editor">
        <header>
          <button type="button" onClick={onCancel} aria-label="关闭素材预览"><X size={20} /></button>
          <span>
            <strong>素材预览与编辑</strong>
            <small>{target.notebookTitle} / {target.title} · {activeIndex + 1}/{drafts.length}</small>
          </span>
          <button type="button" onClick={onCaptureMore} disabled={isPreparing}>
            <Camera size={18} />继续拍
          </button>
        </header>

        <div className={`capture-editor-preview crop-${active.edit.crop}`}>
          {previewUrl && (
            <img
              src={previewUrl}
              alt={`待上传照片 ${activeIndex + 1}`}
              style={{ transform: `rotate(${active.edit.rotation}deg)` }}
            />
          )}
          {drafts.length > 1 && (
            <>
              <button
                className="capture-editor-previous"
                type="button"
                onClick={() => onActiveIndex((activeIndex - 1 + drafts.length) % drafts.length)}
                aria-label="上一张"
              ><ChevronLeft size={25} /></button>
              <button
                className="capture-editor-next"
                type="button"
                onClick={() => onActiveIndex((activeIndex + 1) % drafts.length)}
                aria-label="下一张"
              ><ChevronRight size={25} /></button>
            </>
          )}
        </div>

        <div className="capture-editor-tools" aria-label="照片编辑工具">
          <button type="button" onClick={() => onEdit(active.id, rotateCapture(active.edit, "left"))}>
            <RotateCcw size={18} />左转
          </button>
          <button type="button" onClick={() => onEdit(active.id, rotateCapture(active.edit, "right"))}>
            <RotateCw size={18} />右转
          </button>
          {(["original", "4:3", "square"] as const).map((crop) => (
            <button
              key={crop}
              type="button"
              className={active.edit.crop === crop ? "active" : ""}
              onClick={() => setCrop(crop)}
            >
              {crop === "original" ? "原图" : crop === "square" ? "方形" : "4:3"}
            </button>
          ))}
          <button className="danger" type="button" onClick={() => onDelete(active.id)}>
            <Trash2 size={18} />删除
          </button>
        </div>

        <div className="capture-editor-thumbnails" aria-label="本次拍摄">
          {drafts.map((draft, index) => (
            <CaptureDraftThumbnail
              key={draft.id}
              draft={draft}
              active={index === activeIndex}
              onClick={() => onActiveIndex(index)}
            />
          ))}
          <button className="capture-more-thumbnail" type="button" onClick={onCaptureMore} aria-label="继续拍一张">
            <Camera size={20} />
          </button>
        </div>

        {error && <p className="capture-editor-error">{error}</p>}
        <footer>
          <span>原始照片只在本次编辑中使用；确认后才进入本机上传队列。</span>
          <button type="button" onClick={onConfirm} disabled={isPreparing || drafts.length === 0}>
            {isPreparing ? "正在准备…" : `确认上传 ${drafts.length} 张`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function CaptureDraftThumbnail({
  draft,
  active,
  onClick
}: {
  draft: CaptureDraft;
  active: boolean;
  onClick(): void;
}) {
  const url = useBlobUrl(draft.file);
  return (
    <button className={active ? "active" : ""} type="button" onClick={onClick}>
      {url && <img src={url} alt="" />}
    </button>
  );
}

export function CaptureHistoryViewer({
  tasks,
  onClose
}: {
  tasks: readonly UploadTask[];
  onClose(): void;
}) {
  const [index, setIndex] = useState(0);
  const active = tasks[index] ?? tasks[0];
  const url = useBlobUrl(active?.previewBytes ?? active?.bytes);
  return (
    <div className="capture-history-layer" role="dialog" aria-modal="true" aria-label="最近采集历史">
      <div className="capture-history-viewer">
        <header>
          <span>
            <strong>最近采集</strong>
            <small>{index + 1}/{tasks.length} · {active ? uploadStatusLabel(active) : ""}</small>
          </span>
          <button type="button" onClick={onClose} aria-label="关闭最近采集"><X size={20} /></button>
        </header>
        <div className="capture-history-preview">
          {url
            ? <img src={url} alt={active?.fileName ?? "最近采集"} />
            : <div><CheckCircle2 size={44} /><span>缩略图已释放，素材已写入电脑。</span></div>}
          {tasks.length > 1 && (
            <>
              <button className="capture-history-previous" type="button" onClick={() => setIndex((index - 1 + tasks.length) % tasks.length)} aria-label="上一张">
                <ChevronLeft size={26} />
              </button>
              <button className="capture-history-next" type="button" onClick={() => setIndex((index + 1) % tasks.length)} aria-label="下一张">
                <ChevronRight size={26} />
              </button>
            </>
          )}
        </div>
        <p>{active?.fileName} · {active ? formatBytes(active.byteLength) : ""}</p>
      </div>
    </div>
  );
}

function UploadTaskCard({
  task,
  canRetryRecognition,
  onRetry,
  onRetryRecognition,
  onRemove
}: {
  task: UploadTask;
  canRetryRecognition: boolean;
  onRetry(): void;
  onRetryRecognition(): void;
  onRemove(): void;
}) {
  const previewUrl = useBlobUrl(task.kind === "image" ? task.previewBytes ?? task.bytes : undefined);
  const retryable = task.status === "failed" || task.status === "blocked_auth";
  const recognitionRetryable = canRetryRecognition && task.status === "succeeded" &&
    (task.recognitionStatus === "failed" || task.recognitionStatus === "cancelled");
  return (
    <article className={`upload-task ${task.status} recognition-${task.recognitionStatus ?? "none"}`}>
      <div className="upload-thumbnail" aria-hidden="true">
        {previewUrl
          ? <img src={previewUrl} alt="" />
          : task.kind === "pdf"
            ? <FileText size={21} />
            : task.status === "succeeded"
              ? <CheckCircle2 size={21} />
              : <ImagePlus size={21} />}
      </div>
      <div className="upload-task-copy">
        <strong title={task.fileName}>{task.fileName}</strong>
        <small>{task.notebookTitle} / {task.sessionTitle}</small>
        <span>{uploadStatusLabel(task)} · {formatBytes(task.byteLength)}</span>
        {task.lastError && <em>{task.lastError}</em>}
      </div>
      <div className="upload-task-actions">
        {retryable && (
          <button type="button" onClick={onRetry} aria-label={`重试 ${task.fileName}`} title="重试">
            <RotateCcw size={16} />
          </button>
        )}
        {recognitionRetryable && (
          <button type="button" onClick={onRetryRecognition} aria-label={`重新识别 ${task.fileName}`} title="重新识别">
            <RotateCcw size={16} />
          </button>
        )}
        {task.status !== "uploading" && (
          <button type="button" onClick={onRemove} aria-label={`移除 ${task.fileName}`} title="移除">
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </article>
  );
}

function PdfAttachmentBar({ assets }: { assets: readonly CachedAsset[] }) {
  return (
    <div className="pdf-attachment-bar" aria-label="PDF 附件">
      <span><FileText size={16} />PDF</span>
      <div>
        {assets.map((asset, index) => (
          <PdfAttachmentLink key={asset.assetId} asset={asset} index={index} />
        ))}
      </div>
    </div>
  );
}

function PdfAttachmentLink({
  asset,
  index
}: {
  asset: CachedAsset;
  index: number;
}) {
  const url = useBlobUrl(asset.bytes);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      download={`MathNotes-${index + 1}.pdf`}
      aria-disabled={!url}
    >
      打开 PDF {index + 1}
    </a>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <img src="/icons/mathnotes-192.png" alt="" />
      <RefreshCw size={19} className="spinning" />
      <span>正在打开离线笔记</span>
    </main>
  );
}

export function ConnectionState({
  state,
  expanded,
  onToggle
}: {
  state: SyncState;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={`连接状态：${statusLabel(state)}，查看详情`}
      className={`connection-state ${state}`}
      onClick={onToggle}
      type="button"
    >
      <i />
      {statusLabel(state)}
    </button>
  );
}

export function ConnectionDetails({
  state,
  message,
  origin,
  lastSuccessfulSyncAt,
  onRetry,
  onClose
}: {
  state: SyncState;
  message: string;
  origin?: string;
  lastSuccessfulSyncAt?: string;
  onRetry(): void;
  onClose(): void;
}) {
  const detail = connectionDetail(state, message);
  return (
    <section aria-label="连接详情" className={`connection-details ${state}`}>
      <div>
        <strong>{detail.title}</strong>
        <p>{detail.body}</p>
      </div>
      <dl>
        <div><dt>当前主机</dt><dd>{origin ?? "尚未配对"}</dd></div>
        <div><dt>最近同步</dt><dd>{formatLastSuccessfulSync(lastSuccessfulSyncAt)}</dd></div>
      </dl>
      <div className="connection-detail-actions">
        <button disabled={state === "syncing"} onClick={onRetry} type="button">
          {state === "syncing" ? "正在重试" : "立即重试"}
        </button>
        <button onClick={onClose} type="button">收起</button>
      </div>
    </section>
  );
}

export function connectionDetail(state: SyncState, message: string): { title: string; body: string } {
  if (state === "syncing") {
    return { title: "正在连接主机", body: message || "正在读取最新目录和笔记。" };
  }
  if (state === "live") {
    return { title: "主机连接正常", body: message || "目录与笔记可以实时更新。" };
  }
  if (state === "offline") {
    return {
      title: "手机当前离线",
      body: message || "正在显示本机缓存；网络恢复后会自动继续同步。"
    };
  }
  if (state === "failed") {
    return {
      title: "主机暂时无法连接",
      body: message || "页面和缓存仍可打开，但 Mac/Windows 主机 API 没有响应。请确认主机应用正在运行后重试。"
    };
  }
  return {
    title: "正在显示本机缓存",
    body: message || "尚未完成本次在线同步。"
  };
}

function formatLastSuccessfulSync(value?: string): string {
  if (!value) return "本次打开后尚未成功";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "未知";
  return parsed.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit"
  });
}

function groupTargets(targets: readonly PairingTarget[]) {
  const groups = new Map<string, { notebookId: string; title: string; sessions: PairingTarget[] }>();
  for (const target of targets) {
    const current = groups.get(target.notebookId) ?? {
      notebookId: target.notebookId,
      title: target.notebookTitle || target.notebookId,
      sessions: []
    };
    current.sessions.push(target);
    groups.set(target.notebookId, current);
  }
  return [...groups.values()];
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof CompanionApiError && error.status === 401;
}

function isTargetUnavailable(error: unknown): boolean {
  return error instanceof CompanionApiError &&
    (error.code === "target_not_found" || error.code === "invalid_target");
}

function userMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function deviceLabel(): string {
  if (/iPad/i.test(navigator.userAgent)) return "iPad";
  if (/iPhone/i.test(navigator.userAgent)) return "iPhone";
  return "Web Companion";
}

function stageLabel(stage: SessionSyncStage): string {
  if (stage === "manifest") return "正在检查修订";
  if (stage === "body") return "正文已更新";
  if (stage === "assets") return "正在补齐图片";
  return "已是最新";
}

export function statusLabel(state: SyncState): string {
  if (state === "syncing") return "正在同步";
  if (state === "live") return "实时同步";
  if (state === "offline") return "离线阅读";
  if (state === "failed") return "主机暂不可达";
  return "本机缓存";
}

function uploadStatusLabel(task: UploadTask): string {
  if (task.status === "uploading") return "正在上传";
  if (task.status === "retry_wait") return "等待自动重试";
  if (task.status === "failed") return "需要手动重试";
  if (task.status === "blocked_auth") return "请重新配对后重试";
  if (task.status === "succeeded") {
    if (task.recognitionStatus === "pending" || task.recognitionStatus === "running") {
      return task.duplicate ? "电脑已有素材，正在确认识别" : "已上传，正在识别";
    }
    if (task.recognitionStatus === "failed") return "已入库，识别失败";
    if (task.recognitionStatus === "cancelled") return "已入库，识别已中断";
    if (task.recognitionStatus === "succeeded") return "已入库并识别完成";
    return task.duplicate ? "电脑已有此素材" : "已存入电脑";
  }
  return "等待上传";
}

function persistenceLabel(state: PersistenceState): string {
  if (state === "granted") return "本机已允许长期保存待上传素材";
  if (state === "best-effort") return "素材已写入本机；请勿主动清除网站数据";
  if (state === "unavailable") return "素材已写入本机；此浏览器不支持长期存储申请";
  return "正在确认本机存储能力";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function useBlobUrl(blob?: Blob): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);
  return url;
}

async function requestPersistentStorage(): Promise<PersistenceState> {
  if (!navigator.storage?.persist) return "unavailable";
  try {
    return await navigator.storage.persist() ? "granted" : "best-effort";
  } catch {
    return "best-effort";
  }
}

async function reconnectingStream(args: {
  api: CompanionApiClient;
  path: string;
  token: string;
  signal: AbortSignal;
  onMessage(message: SseMessage): void;
  onConnection(): void;
  onAuthorizationLost(): void;
  initialLastEventId?: string;
  saveLastEventId?(cursor: string): Promise<void>;
}): Promise<void> {
  let lastEventId = args.initialLastEventId ?? "";
  let backoff = 1_000;
  let cursorWrite = Promise.resolve();
  while (!args.signal.aborted) {
    try {
      await args.api.stream(args.path, args.token, {
        signal: args.signal,
        lastEventId: lastEventId || undefined,
        onOpen: args.onConnection,
        onMessage: (message) => {
          if (message.id) {
            lastEventId = message.id;
            if (args.saveLastEventId) {
              cursorWrite = cursorWrite
                .then(() => args.saveLastEventId!(message.id!))
                .catch(() => undefined);
            }
          }
          if (message.retry) backoff = Math.min(15_000, Math.max(1_000, message.retry));
          args.onConnection();
          args.onMessage(message);
        }
      });
      backoff = 1_000;
    } catch (error) {
      if (args.signal.aborted) return;
      if (isUnauthorized(error)) {
        args.onAuthorizationLost();
        return;
      }
      await wait(backoff, args.signal);
      backoff = Math.min(15_000, backoff * 2);
    }
  }
  await cursorWrite;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

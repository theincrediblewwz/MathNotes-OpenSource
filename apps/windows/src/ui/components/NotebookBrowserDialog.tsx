import {
  ArrowLeft,
  FileText,
  Folder,
  Grid2X2,
  List,
  MoreHorizontal,
  Plus,
  Search,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  NotebookSessionSummary,
  NotebookSummary,
  ReadonlySessionPreview
} from "../../types/mathNotesApi";

type NotebookBrowserDialogProps = {
  open: boolean;
  busy?: boolean;
  notebooks: NotebookSummary[];
  currentNotebookId: string;
  currentSessionId: string;
  loadNotebookSessions: (notebookId: string) => Promise<NotebookSessionSummary[]>;
  loadSessionPreview: (input: { notebookId: string; sessionId: string }) => Promise<ReadonlySessionPreview>;
  onClose: () => void;
  onOpenSession: (session: NotebookSessionSummary) => void;
  onCreateNotebook?: () => void;
  onCreateSession?: (notebookId: string) => void;
  onRenameSession?: (session: NotebookSessionSummary) => void;
  onDeleteSession?: (session: NotebookSessionSummary) => void;
};

type PreviewState = {
  session: NotebookSessionSummary;
  html: string;
  loading: boolean;
  error?: string;
  x: number;
  y: number;
};

const previewWidth = 384;
const previewHeight = 304;

export function NotebookBrowserDialog({
  open,
  busy = false,
  notebooks,
  currentNotebookId,
  currentSessionId,
  loadNotebookSessions,
  loadSessionPreview,
  onClose,
  onOpenSession,
  onCreateNotebook,
  onCreateSession,
  onRenameSession,
  onDeleteSession
}: NotebookBrowserDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedNotebookId, setSelectedNotebookId] = useState(currentNotebookId);
  const [selectedSessionId, setSelectedSessionId] = useState(currentSessionId);
  const [sessionsByNotebook, setSessionsByNotebook] = useState<Record<string, NotebookSessionSummary[]>>({});
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [sessionMenu, setSessionMenu] = useState<NotebookSessionSummary | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestRef = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedNotebookId(notebooks.some((item) => item.notebookId === currentNotebookId)
      ? currentNotebookId
      : notebooks[0]?.notebookId ?? "");
    setSelectedSessionId(currentSessionId);
    setPreview(null);
    setSessionMenu(null);
    searchRef.current?.focus();
  }, [currentNotebookId, currentSessionId, notebooks, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalogLoading(true);
    void Promise.all(notebooks.map(async (notebook) => {
      try {
        return [notebook.notebookId, await loadNotebookSessions(notebook.notebookId)] as const;
      } catch {
        return [notebook.notebookId, []] as const;
      }
    })).then((entries) => {
      if (!cancelled) setSessionsByNotebook(Object.fromEntries(entries));
    }).finally(() => {
      if (!cancelled) setCatalogLoading(false);
    });
    return () => { cancelled = true; };
  }, [loadNotebookSessions, notebooks, open]);

  useEffect(() => () => clearPreviewTimer(), []);

  const normalizedQuery = normalizeSearch(query);
  const visibleNotebooks = useMemo(() => notebooks.filter((notebook) => {
    if (!normalizedQuery) return true;
    if (normalizeSearch(notebook.title).includes(normalizedQuery)) return true;
    return (sessionsByNotebook[notebook.notebookId] ?? []).some((session) => (
      normalizeSearch(session.title).includes(normalizedQuery)
    ));
  }), [normalizedQuery, notebooks, sessionsByNotebook]);
  const selectedNotebook = notebooks.find((item) => item.notebookId === selectedNotebookId) ?? visibleNotebooks[0] ?? notebooks[0];
  const selectedSessions = (selectedNotebook ? sessionsByNotebook[selectedNotebook.notebookId] : []) ?? [];
  const visibleSessions = selectedSessions.filter((session) => (
    !normalizedQuery ||
    normalizeSearch(session.title).includes(normalizedQuery) ||
    normalizeSearch(selectedNotebook?.title ?? "").includes(normalizedQuery)
  ));
  const selectedSession = visibleSessions.find((item) => item.sessionId === selectedSessionId)
    ?? selectedSessions.find((item) => item.sessionId === selectedSessionId)
    ?? visibleSessions[0];

  if (!open) return null;

  function clearPreviewTimer() {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }

  function hidePreview() {
    clearPreviewTimer();
    previewRequestRef.current += 1;
    setPreview(null);
  }

  function requestPreview(session: NotebookSessionSummary, pointerX: number, pointerY: number, delay = 220) {
    clearPreviewTimer();
    const position = positionSessionPreview({
      pointerX,
      pointerY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      previewWidth,
      previewHeight
    });
    previewTimerRef.current = window.setTimeout(() => {
      const requestId = ++previewRequestRef.current;
      setPreview({ session, html: "", loading: true, ...position });
      void loadSessionPreview({ notebookId: session.notebookId, sessionId: session.sessionId }).then((result) => {
        if (previewRequestRef.current !== requestId) return;
        setPreview({ session, html: result.html, loading: false, ...position });
      }).catch(() => {
        if (previewRequestRef.current !== requestId) return;
        setPreview({ session, html: "", loading: false, error: "暂时无法预览这篇笔记", ...position });
      });
    }, delay);
  }

  function movePreview(event: ReactPointerEvent<HTMLElement>, session: NotebookSessionSummary) {
    if (!preview || preview.session.sessionId !== session.sessionId || preview.session.notebookId !== session.notebookId) return;
    const position = positionSessionPreview({
      pointerX: event.clientX,
      pointerY: event.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      previewWidth,
      previewHeight
    });
    setPreview((current) => current ? { ...current, ...position } : current);
  }

  function closeOrHidePreview() {
    if (preview) hidePreview();
    else onClose();
  }

  return (
    <div
      className="notebook-browser-layer"
      data-testid="notebook-browser-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeOrHidePreview();
        }
      }}
    >
      <section aria-label="打开 Notebooks" aria-modal="true" className="notebook-browser" role="dialog">
        <header className="notebook-browser-head">
          <button aria-label="关闭 Notebook 浏览器" className="notebook-browser-back" onClick={onClose} type="button">
            <ArrowLeft />
          </button>
          <div>
            <h2>打开 Notebooks</h2>
            <p>所有 Notebooks <span>/</span> {selectedNotebook?.title ?? ""}</p>
          </div>
          <div className="notebook-browser-toolbar">
            <label className="notebook-browser-search">
              <Search aria-hidden="true" />
              <input
                aria-label="搜索 Notebooks 与 Sessions"
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="搜索 Notebooks 与 Sessions"
                ref={searchRef}
                value={query}
              />
            </label>
            <div className="notebook-browser-view-toggle" aria-label="Session 显示方式">
              <button aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")} title="网格" type="button"><Grid2X2 /></button>
              <button aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")} title="列表" type="button"><List /></button>
            </div>
            <button aria-label="关闭" className="notebook-browser-icon-action" onClick={onClose} type="button"><X /></button>
          </div>
        </header>

        <div className="notebook-browser-body">
          <aside aria-label="Notebooks" className="notebook-browser-folders">
            <div className="notebook-browser-section-title">
              <span>Notebooks</span>
              <button aria-label="新建 Notebook" onClick={onCreateNotebook} title="新建 Notebook" type="button"><Plus /></button>
            </div>
            <div className="notebook-folder-list">
              {visibleNotebooks.map((notebook) => (
                <button
                  aria-current={notebook.notebookId === selectedNotebook?.notebookId ? "page" : undefined}
                  className={`notebook-folder ${notebook.notebookId === selectedNotebook?.notebookId ? "active" : ""}`}
                  key={notebook.notebookId}
                  onClick={() => {
                    setSelectedNotebookId(notebook.notebookId);
                    setSelectedSessionId((sessionsByNotebook[notebook.notebookId] ?? [])[0]?.sessionId ?? "");
                    hidePreview();
                  }}
                  type="button"
                >
                  <Folder aria-hidden="true" />
                  <span>
                    <strong>{notebook.title}</strong>
                    <small>{notebook.sessionCount} 篇笔记</small>
                  </span>
                </button>
              ))}
              {!catalogLoading && visibleNotebooks.length === 0 ? <p className="notebook-browser-empty">没有匹配的 Notebook</p> : null}
            </div>
          </aside>

          <main className="notebook-browser-sessions">
            <div className="notebook-browser-session-head">
              <span>名称</span>
              <span>修改日期</span>
              <button
                disabled={!selectedNotebook}
                onClick={() => selectedNotebook && onCreateSession?.(selectedNotebook.notebookId)}
                type="button"
              ><Plus /> 新建 Session</button>
            </div>
            <div className={`notebook-session-list ${viewMode}`}>
              {visibleSessions.map((session) => {
                const previewId = `session-preview-${safeDomId(session.notebookId)}-${safeDomId(session.sessionId)}`;
                return (
                  <div className={`notebook-session-row ${session.sessionId === selectedSession?.sessionId ? "active" : ""}`} key={`${session.notebookId}/${session.sessionId}`}>
                    <button
                      aria-describedby={preview?.session.sessionId === session.sessionId ? previewId : undefined}
                      className="notebook-session-main"
                      onClick={() => setSelectedSessionId(session.sessionId)}
                      onDoubleClick={() => onOpenSession(session)}
                      onFocus={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        requestPreview(session, rect.right - 12, rect.top + Math.min(46, rect.height / 2), 0);
                      }}
                      onBlur={hidePreview}
                      onPointerEnter={(event) => requestPreview(session, event.clientX, event.clientY)}
                      onPointerLeave={hidePreview}
                      onPointerMove={(event) => movePreview(event, session)}
                      type="button"
                    >
                      <FileText aria-hidden="true" />
                      <span>{session.title || "未命名"}</span>
                      <time dateTime={session.updatedAt}>{formatSessionDate(session.updatedAt)}</time>
                    </button>
                    <button
                      aria-label={`管理 ${session.title || "未命名"}`}
                      className="notebook-session-more"
                      onClick={() => setSessionMenu((current) => current?.sessionId === session.sessionId ? null : session)}
                      type="button"
                    ><MoreHorizontal /></button>
                    {sessionMenu?.sessionId === session.sessionId && sessionMenu.notebookId === session.notebookId ? (
                      <div className="notebook-session-menu" role="menu">
                        <button onClick={() => { setSessionMenu(null); onRenameSession?.(session); }} role="menuitem" type="button">重命名</button>
                        <button className="danger-menuitem" onClick={() => { setSessionMenu(null); onDeleteSession?.(session); }} role="menuitem" type="button">删除</button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {!catalogLoading && selectedNotebook && visibleSessions.length === 0 ? <p className="notebook-browser-empty">这个 Notebook 里还没有匹配的 Session</p> : null}
              {catalogLoading ? <p className="notebook-browser-empty">正在整理笔记…</p> : null}
            </div>
          </main>
        </div>

        <footer className="notebook-browser-actions">
          <button onClick={onClose} type="button">取消</button>
          <button className="primary" disabled={busy || !selectedSession} onClick={() => selectedSession && onOpenSession(selectedSession)} type="button">
            {busy ? "正在打开…" : "打开"}
          </button>
        </footer>
      </section>
      {preview ? (
        <aside
          className="notebook-session-preview"
          id={`session-preview-${safeDomId(preview.session.notebookId)}-${safeDomId(preview.session.sessionId)}`}
          role="tooltip"
          style={{ left: preview.x, top: preview.y, width: previewWidth, height: previewHeight }}
        >
          <strong>{preview.session.title || "未命名"}</strong>
          {preview.loading ? <p>正在渲染预览…</p> : preview.error ? <p>{preview.error}</p> : (
            <div className="notebook-session-preview-markdown" dangerouslySetInnerHTML={{ __html: preview.html }} />
          )}
        </aside>
      ) : null}
    </div>
  );
}

export function positionSessionPreview(input: {
  pointerX: number;
  pointerY: number;
  viewportWidth: number;
  viewportHeight: number;
  previewWidth?: number;
  previewHeight?: number;
  gap?: number;
  margin?: number;
}): { x: number; y: number } {
  const width = input.previewWidth ?? previewWidth;
  const height = input.previewHeight ?? previewHeight;
  const gap = input.gap ?? 18;
  const margin = input.margin ?? 14;
  const x = input.pointerX + gap + width <= input.viewportWidth - margin
    ? input.pointerX + gap
    : input.pointerX - gap - width;
  const y = input.pointerY + gap + height <= input.viewportHeight - margin
    ? input.pointerY + gap
    : input.pointerY - gap - height;
  return {
    x: Math.max(margin, Math.min(input.viewportWidth - width - margin, x)),
    y: Math.max(margin, Math.min(input.viewportHeight - height - margin, y))
  };
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function formatSessionDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
}

function safeDomId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

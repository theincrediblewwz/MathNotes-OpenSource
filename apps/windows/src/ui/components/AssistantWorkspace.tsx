import {
  ArrowDown,
  BookOpenText,
  Check,
  ChevronDown,
  Maximize2,
  Minus,
  Minimize2,
  Pencil,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { AssistantMode } from "@mathnotes/shared";
import type {
  AssistantRemark,
  AssistantRemarkFocus,
  AssistantRemarkRelatedSource
} from "../../core/assistantRemarkStore";
import { assistantDragMime, readAssistantDragPayload, type AssistantDragPayload } from "../assistantDragPayload";
import { renderMarkdownPreview } from "./PreviewPane";

export type AssistantWorkspaceSubmitInput = {
  mode: AssistantMode;
  question?: string;
  focus: AssistantRemarkFocus;
};

export type AssistantSelectionEditDraft = {
  blockId: string;
  from: number;
  to: number;
  selectedText: string;
  instruction: string;
  replacementMarkdown: string;
  proposal: {
    id: string;
    replacementMarkdown: string;
    status: "proposed" | "applied" | "cancelled";
  } | null;
  status: "idle" | "generating" | "applying";
  error?: string;
  requiresUnlock?: boolean;
};

export type AssistantWorkspaceRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type AssistantResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

type AssistantWorkspaceProps = {
  error?: string | null;
  open: boolean;
  running: boolean;
  onlineEnabled: boolean;
  sessionDir?: string;
  remarks: AssistantRemark[];
  selectedRemarkId?: string | null;
  liveText: string;
  pendingQuestion?: string | null;
  answerFontFamily?: string;
  answerFontSize?: number;
  selectionEdit?: AssistantSelectionEditDraft | null;
  detached?: boolean;
  onClose: () => void;
  onMinimizeWindow?: () => void;
  onToggleMaximizeWindow?: () => boolean | undefined | Promise<boolean | undefined>;
  onCancel: () => void;
  onDeleteRemark: (remarkId: string) => void;
  onPromoteRemark: (remarkId: string) => void;
  onOpenRelatedSource?: (source: AssistantRemarkRelatedSource) => void;
  onSelectedRemarkChange?: (remarkId: string | null) => void;
  onEditSelection?: (input: { blockId: string; from: number; to: number; selectedText: string }) => void;
  onSubmit: (input: AssistantWorkspaceSubmitInput) => void;
  onSelectionApply?: () => void;
  onSelectionCancel?: () => void;
  onSelectionGenerate?: () => void;
  onSelectionInstructionChange?: (instruction: string) => void;
  onSelectionReplacementChange?: (replacementMarkdown: string) => void;
  onSelectionRetry?: () => void;
  onSelectionUnlock?: () => void;
};

const modeLabels: Record<AssistantMode, string> = {
  explain: "解读",
  teach: "梳理",
  summarize: "总结"
};

const assistantRectStorageKey = "mathnotes.assistant.workspace-rect.v2";
const assistantMinimumWidth = 420;
const assistantMinimumHeight = 500;
const assistantViewportMargin = 12;

export function resizeAssistantRect(args: {
  start: AssistantWorkspaceRect;
  direction: AssistantResizeDirection;
  deltaX: number;
  deltaY: number;
  viewportWidth: number;
  viewportHeight: number;
  minimumWidth?: number;
  minimumHeight?: number;
  margin?: number;
}): AssistantWorkspaceRect {
  const margin = args.margin ?? assistantViewportMargin;
  const minimumWidth = Math.min(args.minimumWidth ?? assistantMinimumWidth, Math.max(1, args.viewportWidth - margin * 2));
  const minimumHeight = Math.min(args.minimumHeight ?? assistantMinimumHeight, Math.max(1, args.viewportHeight - margin * 2));
  const startRight = args.start.left + args.start.width;
  const startBottom = args.start.top + args.start.height;
  let left = args.start.left;
  let right = startRight;
  let top = args.start.top;
  let bottom = startBottom;

  if (args.direction.includes("w")) {
    left = clamp(args.start.left + args.deltaX, margin, startRight - minimumWidth);
  } else if (args.direction.includes("e")) {
    right = clamp(startRight + args.deltaX, args.start.left + minimumWidth, args.viewportWidth - margin);
  }
  if (args.direction.includes("n")) {
    top = clamp(args.start.top + args.deltaY, margin, startBottom - minimumHeight);
  } else if (args.direction.includes("s")) {
    bottom = clamp(startBottom + args.deltaY, args.start.top + minimumHeight, args.viewportHeight - margin);
  }

  return { left, top, width: right - left, height: bottom - top };
}

export function AssistantWorkspace({
  error,
  open,
  running,
  onlineEnabled,
  sessionDir,
  remarks,
  selectedRemarkId = null,
  liveText,
  pendingQuestion = null,
  answerFontFamily,
  answerFontSize,
  selectionEdit = null,
  detached = false,
  onClose,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onCancel,
  onDeleteRemark,
  onPromoteRemark,
  onOpenRelatedSource,
  onSelectedRemarkChange,
  onEditSelection,
  onSubmit,
  onSelectionApply,
  onSelectionCancel,
  onSelectionGenerate,
  onSelectionInstructionChange,
  onSelectionReplacementChange,
  onSelectionRetry,
  onSelectionUnlock
}: AssistantWorkspaceProps) {
  const [mode, setMode] = useState<AssistantMode>("explain");
  const [question, setQuestion] = useState("");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [focus, setFocus] = useState<AssistantRemarkFocus>({ kind: "session", label: "当前笔记" });
  const [workspaceRect, setWorkspaceRect] = useState(loadAssistantRect);
  const [expanded, setExpanded] = useState(false);
  const [editingReplacement, setEditingReplacement] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionInputRef = useRef<HTMLTextAreaElement | null>(null);
  const rectBeforeExpandRef = useRef<AssistantWorkspaceRect | null>(null);
  const selectedRemark = remarks.find((remark) => remark.id === selectedRemarkId) ?? null;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      (selectionEdit ? selectionInputRef.current : inputRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectionEdit?.blockId]);

  useEffect(() => {
    if (!selectionEdit) return;
    setFocus({
      kind: "selection",
      blockId: selectionEdit.blockId,
      label: "当前选区",
      excerpt: selectionEdit.selectedText,
      from: selectionEdit.from,
      to: selectionEdit.to
    });
  }, [selectionEdit?.blockId, selectionEdit?.from, selectionEdit?.selectedText, selectionEdit?.to]);

  useEffect(() => setEditingReplacement(false), [selectionEdit?.proposal?.id]);

  useEffect(() => {
    const keepInsideViewport = () => {
      if (expanded) return;
      setWorkspaceRect((current) => normalizeAssistantRect(current, window.innerWidth, window.innerHeight));
    };
    window.addEventListener("resize", keepInsideViewport);
    return () => window.removeEventListener("resize", keepInsideViewport);
  }, [expanded]);

  if (!open) return null;

  function startResize(direction: AssistantResizeDirection, event: ReactPointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startPointer = { x: event.clientX, y: event.clientY };
    const start = workspaceRect;
    let latest = start;
    const onMove = (move: PointerEvent) => {
      latest = resizeAssistantRect({
        start,
        direction,
        deltaX: move.clientX - startPointer.x,
        deltaY: move.clientY - startPointer.y,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      });
      setWorkspaceRect(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistAssistantRect(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    if (expanded || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, textarea, input, select, a")) return;
    event.preventDefault();
    const startPointer = { x: event.clientX, y: event.clientY };
    const start = workspaceRect;
    let latest = start;
    const onMove = (move: PointerEvent) => {
      latest = moveAssistantRect({
        start,
        deltaX: move.clientX - startPointer.x,
        deltaY: move.clientY - startPointer.y,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      });
      setWorkspaceRect(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistAssistantRect(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function toggleExpanded() {
    if (detached) {
      const result = onToggleMaximizeWindow?.();
      if (result instanceof Promise) {
        void result.then((maximized) => {
          setExpanded((current) => typeof maximized === "boolean" ? maximized : !current);
        });
      } else {
        setExpanded((current) => typeof result === "boolean" ? result : !current);
      }
      return;
    }
    if (expanded) {
      const restored = normalizeAssistantRect(
        rectBeforeExpandRef.current ?? workspaceRect,
        window.innerWidth,
        window.innerHeight
      );
      setWorkspaceRect(restored);
      persistAssistantRect(restored);
      setExpanded(false);
      return;
    }
    rectBeforeExpandRef.current = workspaceRect;
    setExpanded(true);
  }

  function acceptPayload(payload: AssistantDragPayload) {
    setFocus({
      kind: payload.kind,
      blockId: payload.blockId,
      label: payload.kind === "selection" ? "当前选区" : payload.label,
      excerpt: payload.text,
      from: payload.from,
      to: payload.to
    });
    setDropActive(false);
    inputRef.current?.focus();
  }

  const rect = expanded
    ? {
        left: assistantViewportMargin,
        top: assistantViewportMargin,
        width: Math.max(1, window.innerWidth - assistantViewportMargin * 2),
        height: Math.max(1, window.innerHeight - assistantViewportMargin * 2)
      }
    : workspaceRect;

  return (
    <aside
      aria-label="与笔记对话"
      className={`assistant-workspace ${detached ? "detached" : ""} ${dropActive ? "drop-active" : ""} ${expanded ? "expanded" : ""}`}
      data-testid="assistant-workspace"
      style={{
        ...(detached ? {} : {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        }),
        "--assistant-answer-font-family": answerFontFamily,
        "--assistant-answer-font-size": answerFontSize ? `${answerFontSize}px` : undefined
      } as CSSProperties}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes(assistantDragMime)) {
          event.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(assistantDragMime)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const payload = readAssistantDragPayload(event.dataTransfer);
        if (payload) acceptPayload(payload);
      }}
    >
      {!detached && !expanded ? resizeDirections.map((direction) => (
        <span
          aria-hidden="true"
          className={`assistant-resize-handle ${direction}`}
          data-testid={`assistant-resize-${direction}`}
          key={direction}
          onPointerDown={(event) => startResize(direction, event)}
        />
      )) : null}

      <header className="assistant-workspace-header" onPointerDown={detached ? undefined : startDrag}>
        <strong>与笔记对话</strong>
        <div className="assistant-window-actions">
          {detached ? (
            <button aria-label="最小化对话窗口" onClick={onMinimizeWindow} type="button"><Minus /></button>
          ) : null}
          <button
            aria-label={expanded ? "还原对话窗口" : "展开对话窗口"}
            onClick={toggleExpanded}
            type="button"
          >{expanded ? <Minimize2 /> : <Maximize2 />}</button>
          <button aria-label="关闭与笔记对话" onClick={onClose} type="button"><X /></button>
        </div>
      </header>

      <div className="assistant-conversation">
        {selectionEdit ? (
          <SelectionEditConversation
            draft={selectionEdit}
            editingReplacement={editingReplacement}
            onEditingReplacementChange={setEditingReplacement}
            onReplacementChange={onSelectionReplacementChange}
            sessionDir={sessionDir}
          />
        ) : selectedRemark ? (
          <RemarkConversation
            focused
            onBack={() => onSelectedRemarkChange?.(null)}
            onDelete={() => onDeleteRemark(selectedRemark.id)}
            onOpenRelatedSource={onOpenRelatedSource}
            onPromote={() => onPromoteRemark(selectedRemark.id)}
            remark={selectedRemark}
            sessionDir={sessionDir}
          />
        ) : (
          <>
            {error ? (
              <div className="assistant-workspace-error" role="alert">
                <strong>这次没有完成</strong>
                <span>{error}</span>
              </div>
            ) : null}
            {remarks.length === 0 && !running ? (
              <div className="assistant-empty-state">
                <BookOpenText />
                <strong>和这篇笔记一起思考</strong>
                <span>可以提问、梳理思路，也可以选择一段文字让 AI 帮你修改。</span>
              </div>
            ) : null}
            {remarks.map((remark) => (
              <RemarkConversation
                key={remark.id}
                onDelete={() => onDeleteRemark(remark.id)}
                onOpen={() => onSelectedRemarkChange?.(remark.id)}
                onOpenRelatedSource={onOpenRelatedSource}
                onPromote={() => onPromoteRemark(remark.id)}
                remark={remark}
                sessionDir={sessionDir}
              />
            ))}
            {running ? (
              <section className="assistant-turn assistant-live-turn" aria-live="polite">
                {pendingQuestion ? <div className="assistant-user-bubble">{pendingQuestion}</div> : null}
                <article className="assistant-ai-message">
                  <div className="assistant-source-row"><Sparkles /><span>正在阅读这篇笔记</span></div>
                  <pre>{liveText || "正在整理上下文…"}<span className="assistant-live-caret" /></pre>
                </article>
              </section>
            ) : null}
          </>
        )}
      </div>

      {selectionEdit ? (
        <footer className="assistant-selection-footer">
          {selectionEdit.error ? (
            <div className="assistant-selection-error-row">
              <p className="assistant-selection-error" role="alert">{selectionEdit.error}</p>
              {selectionEdit.requiresUnlock ? (
                <button onClick={onSelectionUnlock} type="button">去解锁</button>
              ) : null}
            </div>
          ) : null}
          {!selectionEdit.proposal ? (
            <textarea
              aria-label="告诉 AI 怎样修改"
              disabled={selectionEdit.status !== "idle"}
              onChange={(event) => onSelectionInstructionChange?.(event.currentTarget.value)}
              placeholder="告诉 AI 要怎样修改这段文字…"
              ref={selectionInputRef}
              rows={3}
              value={selectionEdit.instruction}
            />
          ) : null}
          <div className="assistant-selection-actions">
            <button disabled={selectionEdit.status !== "idle"} onClick={onSelectionCancel} type="button">取消</button>
            {selectionEdit.proposal ? (
              <>
                <button
                  className="assistant-retry-edit"
                  disabled={selectionEdit.status !== "idle"}
                  onClick={onSelectionRetry}
                  type="button"
                ><RotateCcw /> 重新生成</button>
                <button
                  className="assistant-apply-edit"
                  disabled={selectionEdit.status !== "idle" || !selectionEdit.replacementMarkdown.trim()}
                  onClick={onSelectionApply}
                  type="button"
                >{selectionEdit.status === "applying" ? "正在应用…" : selectionEdit.requiresUnlock ? "重试" : "应用修改"}</button>
              </>
            ) : (
              <button
                className="assistant-apply-edit"
                disabled={selectionEdit.status !== "idle" || !selectionEdit.instruction.trim()}
                onClick={onSelectionGenerate}
                type="button"
              >{selectionEdit.status === "generating" ? "正在生成…" : "生成修改"}</button>
            )}
          </div>
        </footer>
      ) : selectedRemark ? null : (
        <footer className="assistant-composer">
          <div className="assistant-composer-context">
            <span>{focus.kind === "selection" ? "已引用选区" : focus.kind === "block" ? focus.label : "当前笔记"}</span>
            {focus.kind !== "session" ? (
              <button aria-label="恢复当前笔记上下文" onClick={() => setFocus({ kind: "session", label: "当前笔记" })} type="button"><X /></button>
            ) : null}
          </div>
          {focus.excerpt ? <blockquote className="assistant-focus-preview" data-testid="assistant-focus-preview">{focus.excerpt}</blockquote> : null}
          <textarea
            aria-label="与笔记对话"
            onChange={(event) => setQuestion(event.currentTarget.value)}
            placeholder="问问这篇笔记，或说出你想怎样修改…"
            ref={inputRef}
            value={question}
          />
          <div className="assistant-composer-actions">
            <div className="assistant-mode-picker">
              <button aria-expanded={modeMenuOpen} onClick={() => setModeMenuOpen((current) => !current)} type="button">
                {modeLabels[mode]} <ChevronDown />
              </button>
              {modeMenuOpen ? (
                <div className="assistant-mode-menu">
                  {(Object.keys(modeLabels) as AssistantMode[]).map((candidate) => (
                    <button key={candidate} onClick={() => { setMode(candidate); setModeMenuOpen(false); }} type="button">{modeLabels[candidate]}</button>
                  ))}
                </div>
              ) : null}
            </div>
            {focus.kind === "selection" && focus.blockId && focus.excerpt && Number.isInteger(focus.from) && Number.isInteger(focus.to) ? (
              <button
                className="assistant-edit-selection"
                disabled={running || !onEditSelection}
                onClick={() => onEditSelection?.({
                  blockId: focus.blockId!,
                  from: focus.from!,
                  to: focus.to!,
                  selectedText: focus.excerpt!
                })}
                type="button"
              >修改这段文字</button>
            ) : null}
            {running ? (
              <button className="assistant-stop" onClick={onCancel} title="停止" type="button"><Square /></button>
            ) : (
              <button
                aria-label="发送"
                className="assistant-send"
                disabled={!onlineEnabled || !question.trim()}
                onClick={() => {
                  onSubmit({ mode, question: question.trim() || undefined, focus });
                  setQuestion("");
                }}
                title={onlineEnabled ? "发送" : "请先在设置中允许在线学习助手"}
                type="button"
              ><Send /></button>
            )}
          </div>
        </footer>
      )}
    </aside>
  );
}

function SelectionEditConversation({
  draft,
  editingReplacement,
  onEditingReplacementChange,
  onReplacementChange,
  sessionDir
}: {
  draft: AssistantSelectionEditDraft;
  editingReplacement: boolean;
  onEditingReplacementChange: (editing: boolean) => void;
  onReplacementChange?: (replacement: string) => void;
  sessionDir?: string;
}) {
  return (
    <section className="assistant-selection-conversation">
      {draft.instruction ? <div className="assistant-user-bubble">{draft.instruction}</div> : null}
      <div className="assistant-lock-promise"><ShieldCheck /><span>仅修改未锁定内容</span></div>
      {draft.status === "generating" ? (
        <article className="assistant-ai-message assistant-edit-intro"><Sparkles /><span>正在准备修改候选…</span></article>
      ) : draft.proposal ? (
        <article className="assistant-ai-message assistant-edit-intro">
          <Sparkles />
          <span>已生成修改候选。应用前，你仍可以继续编辑。</span>
        </article>
      ) : (
        <article className="assistant-ai-message assistant-edit-intro">
          <Sparkles />
          <span>告诉我希望怎样修改；原文和锁定边界都会保留到你明确确认。</span>
        </article>
      )}
      <article className="assistant-edit-card original">
        <header><span>原文</span></header>
        <div
          className="assistant-edit-markdown preview-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(draft.selectedText, sessionDir) }}
        />
      </article>
      {draft.proposal ? (
        <>
          <ArrowDown className="assistant-edit-arrow" />
          <article className="assistant-edit-card revised">
            <header>
              <span>修改后（可编辑）</span>
              <button onClick={() => onEditingReplacementChange(!editingReplacement)} type="button">
                {editingReplacement ? <><Check /> 完成</> : <><Pencil /> 编辑</>}
              </button>
            </header>
            {editingReplacement ? (
              <textarea
                aria-label="修改后的文字"
                autoFocus
                onChange={(event) => onReplacementChange?.(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") onEditingReplacementChange(false);
                }}
                value={draft.replacementMarkdown}
              />
            ) : (
              <div
                className="assistant-edit-markdown preview-markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(draft.replacementMarkdown, sessionDir) }}
              />
            )}
          </article>
        </>
      ) : null}
    </section>
  );
}

function RemarkConversation({
  focused = false,
  onBack,
  onDelete,
  onOpen,
  onOpenRelatedSource,
  onPromote,
  remark,
  sessionDir
}: {
  focused?: boolean;
  onBack?: () => void;
  onDelete: () => void;
  onOpen?: () => void;
  onOpenRelatedSource?: (source: AssistantRemarkRelatedSource) => void;
  onPromote: () => void;
  remark: AssistantRemark;
  sessionDir?: string;
}) {
  return (
    <section className={`assistant-turn ${focused ? "focused" : ""}`}>
      {focused ? <button className="assistant-reader-back" onClick={onBack} type="button">返回对话</button> : null}
      {remark.question ? <div className="assistant-user-bubble">{remark.question}</div> : null}
      <article className="assistant-ai-message">
        <div className="assistant-source-chips">
          <span className="assistant-source-row"><BookOpenText /><span>{remark.focus.label || "当前笔记"}</span></span>
          {remark.relatedSources?.map((source) => (
            <button
              className="assistant-related-source"
              key={`${source.refId}:${source.notebookId}:${source.sessionId}:${source.blockId}`}
              onClick={() => onOpenRelatedSource?.(source)}
              title={source.locked ? "来源内容已锁定；仅供引用" : "打开来源笔记"}
              type="button"
            >Notebook：{source.notebookTitle} · Session：{source.sessionTitle}</button>
          ))}
        </div>
        <div
          className="assistant-remark-markdown preview-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(remark.markdown, sessionDir) }}
        />
        <footer className="assistant-remark-actions">
          {!focused ? <button onClick={onOpen} type="button">展开阅读</button> : null}
          <button onClick={onPromote} type="button">写入笔记</button>
          <button aria-label="删除这条回答" onClick={onDelete} type="button"><Trash2 /></button>
        </footer>
      </article>
    </section>
  );
}

const resizeDirections: AssistantResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

function loadAssistantRect(): AssistantWorkspaceRect {
  const fallbackWidth = Math.min(540, Math.max(assistantMinimumWidth, window.innerWidth - assistantViewportMargin * 2));
  const fallbackHeight = Math.min(860, Math.max(assistantMinimumHeight, window.innerHeight - assistantViewportMargin * 2));
  const fallback = {
    width: fallbackWidth,
    height: fallbackHeight,
    left: Math.max(assistantViewportMargin, window.innerWidth - fallbackWidth - 28),
    top: Math.max(assistantViewportMargin, (window.innerHeight - fallbackHeight) / 2)
  };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(assistantRectStorageKey) ?? "null") as Partial<AssistantWorkspaceRect> | null;
    if (!parsed) return fallback;
    return normalizeAssistantRect({
      left: Number(parsed.left) || fallback.left,
      top: Number(parsed.top) || fallback.top,
      width: Number(parsed.width) || fallback.width,
      height: Number(parsed.height) || fallback.height
    }, window.innerWidth, window.innerHeight);
  } catch {
    return fallback;
  }
}

function normalizeAssistantRect(rect: AssistantWorkspaceRect, viewportWidth: number, viewportHeight: number): AssistantWorkspaceRect {
  const maximumWidth = Math.max(1, viewportWidth - assistantViewportMargin * 2);
  const maximumHeight = Math.max(1, viewportHeight - assistantViewportMargin * 2);
  const width = clamp(rect.width, Math.min(assistantMinimumWidth, maximumWidth), maximumWidth);
  const height = clamp(rect.height, Math.min(assistantMinimumHeight, maximumHeight), maximumHeight);
  return {
    left: clamp(rect.left, assistantViewportMargin, viewportWidth - width - assistantViewportMargin),
    top: clamp(rect.top, assistantViewportMargin, viewportHeight - height - assistantViewportMargin),
    width,
    height
  };
}

function moveAssistantRect(args: {
  start: AssistantWorkspaceRect;
  deltaX: number;
  deltaY: number;
  viewportWidth: number;
  viewportHeight: number;
}): AssistantWorkspaceRect {
  return {
    ...args.start,
    left: clamp(
      args.start.left + args.deltaX,
      assistantViewportMargin,
      args.viewportWidth - args.start.width - assistantViewportMargin
    ),
    top: clamp(
      args.start.top + args.deltaY,
      assistantViewportMargin,
      args.viewportHeight - args.start.height - assistantViewportMargin
    )
  };
}

function persistAssistantRect(rect: AssistantWorkspaceRect): void {
  try {
    window.localStorage.setItem(assistantRectStorageKey, JSON.stringify(rect));
  } catch {
    // Window geometry is optional UI state.
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}

import { BookOpenText, ChevronDown, GraduationCap, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { AssistantMode } from "@mathnotes/shared";
import type { AssistantRemark, AssistantRemarkFocus } from "../../core/assistantRemarkStore";
import {
  buildAssistantContextPacket,
  type AssistantContextBlock
} from "../../common/assistantContextContract";
import { assistantDragMime, readAssistantDragPayload, type AssistantDragPayload } from "../assistantDragPayload";
import { renderMarkdownPreview } from "./PreviewPane";

export type AssistantWorkspaceSubmitInput = {
  mode: AssistantMode;
  question?: string;
  focus: AssistantRemarkFocus;
};

type AssistantWorkspaceProps = {
  error?: string | null;
  open: boolean;
  running: boolean;
  onlineEnabled: boolean;
  providerLabel: string;
  sessionDir?: string;
  remarks: AssistantRemark[];
  selectedRemarkId?: string | null;
  liveText: string;
  answerFontFamily?: string;
  answerFontSize?: number;
  contextBlocks?: AssistantContextBlock[];
  onClose: () => void;
  onCancel: () => void;
  onDeleteRemark: (remarkId: string) => void;
  onPromoteRemark: (remarkId: string) => void;
  onSelectedRemarkChange?: (remarkId: string | null) => void;
  onSubmit: (input: AssistantWorkspaceSubmitInput) => void;
  detached?: boolean;
};

const modeLabels: Record<AssistantMode, string> = {
  explain: "解读",
  teach: "教学",
  summarize: "总结"
};

type AssistantResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
const assistantSizeStorageKey = "mathnotes.assistant.workspace-size.v1";
const assistantMinimumWidth = 380;
const assistantMinimumHeight = 420;

function loadAssistantSize() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(assistantSizeStorageKey) ?? "null") as { width?: number; height?: number } | null;
    return {
      width: Math.max(assistantMinimumWidth, Math.min(760, Number(parsed?.width) || 500)),
      height: Math.max(assistantMinimumHeight, Math.min(900, Number(parsed?.height) || 650))
    };
  } catch {
    return { width: 500, height: 650 };
  }
}

export function AssistantWorkspace({
  error,
  open,
  running,
  onlineEnabled,
  providerLabel,
  sessionDir,
  remarks,
  selectedRemarkId = null,
  liveText,
  answerFontFamily,
  answerFontSize,
  contextBlocks = [],
  onClose,
  onCancel,
  onDeleteRemark,
  onPromoteRemark,
  onSelectedRemarkChange,
  onSubmit,
  detached = false
}: AssistantWorkspaceProps) {
  const [mode, setMode] = useState<AssistantMode>("explain");
  const [question, setQuestion] = useState("");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [focus, setFocus] = useState<AssistantRemarkFocus>({ kind: "session", label: "当前 Session" });
  const [workspaceRect, setWorkspaceRect] = useState(() => {
    const size = loadAssistantSize();
    return { ...size, left: Math.max(22, window.innerWidth - size.width - 22), top: Math.max(22, window.innerHeight - size.height - 22) };
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedRemark = remarks.find((remark) => remark.id === selectedRemarkId) ?? null;
  const contextPreview = buildAssistantContextPacket({
    focus,
    question,
    blocks: contextBlocks
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  function startResize(direction: AssistantResizeDirection, event: ReactPointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, ...workspaceRect };
    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - start.x;
      const dy = move.clientY - start.y;
      let left = start.left;
      let top = start.top;
      let width = start.width;
      let height = start.height;
      if (direction.includes("e")) width = start.width + dx;
      if (direction.includes("s")) height = start.height + dy;
      if (direction.includes("w")) { width = start.width - dx; left = start.left + dx; }
      if (direction.includes("n")) { height = start.height - dy; top = start.top + dy; }
      width = Math.max(assistantMinimumWidth, Math.min(window.innerWidth - 24, width));
      height = Math.max(assistantMinimumHeight, Math.min(window.innerHeight - 24, height));
      left = Math.max(12, Math.min(window.innerWidth - width - 12, left));
      top = Math.max(12, Math.min(window.innerHeight - height - 12, top));
      setWorkspaceRect({ left, top, width, height });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const current = document.querySelector<HTMLElement>("[data-testid='assistant-workspace']");
      if (current) {
        window.localStorage.setItem(assistantSizeStorageKey, JSON.stringify({ width: current.offsetWidth, height: current.offsetHeight }));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function acceptPayload(payload: AssistantDragPayload) {
    setFocus({
      kind: payload.kind,
      blockId: payload.blockId,
      label: payload.label,
      excerpt: payload.text
    });
    setDropActive(false);
    inputRef.current?.focus();
  }

  return (
    <aside
      aria-label="AI 学习助手"
      className={`assistant-workspace ${dropActive ? "drop-active" : ""}`}
      data-testid="assistant-workspace"
      style={{
        left: detached ? 0 : workspaceRect.left,
        top: detached ? 0 : workspaceRect.top,
        width: detached ? "100%" : workspaceRect.width,
        height: detached ? "100%" : workspaceRect.height,
        "--assistant-answer-font-family": answerFontFamily,
        "--assistant-answer-font-size": answerFontSize ? `${answerFontSize}px` : undefined
      } as React.CSSProperties}
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
      {!detached ? (["n", "ne", "e", "se", "s", "sw", "w", "nw"] as AssistantResizeDirection[]).map((direction) => (
        <span
          aria-hidden="true"
          className={`assistant-resize-handle ${direction}`}
          data-testid={`assistant-resize-${direction}`}
          key={direction}
          onPointerDown={(event) => startResize(direction, event)}
        />
      )) : null}
      <header className="assistant-workspace-header">
        <div title="生成独立旁注，原笔记与锁定内容只读；只有明确转为笔记块才会进入正文。">
          <span><Sparkles /> AI 学习助手</span>
          <small>{providerLabel}</small>
        </div>
        <button aria-label="关闭 AI 学习助手" onClick={onClose} type="button"><X /></button>
      </header>

      {selectedRemark ? (
        <section className="assistant-remark-reader" aria-label="AI 旁注阅读器">
          <div className="assistant-reader-toolbar">
            <button onClick={() => onSelectedRemarkChange?.(null)} type="button">返回旁注列表</button>
            <span>{modeLabels[selectedRemark.mode]} · {selectedRemark.focus.label}</span>
          </div>
          <div className="assistant-reader-meta">
            <strong>{selectedRemark.providerName}</strong>
            <time dateTime={selectedRemark.updatedAt}>{new Date(selectedRemark.updatedAt).toLocaleString("zh-CN")}</time>
          </div>
          <div
            className="assistant-reader-markdown preview-markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(selectedRemark.markdown, sessionDir) }}
          />
          <div className="assistant-reader-actions">
            <button onClick={() => onPromoteRemark(selectedRemark.id)} type="button">转为笔记块</button>
          </div>
        </section>
      ) : (
      <>
      <div className="assistant-remark-list">
        {error ? (
          <div className="assistant-workspace-error" role="alert">
            <strong>本次调用没有完成</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {remarks.length === 0 && !running ? (
          <div className="assistant-empty-state">
            <BookOpenText />
            <strong>建立笔记的旁注</strong>
            <span>直接提问会读取当前 Session；也可把选区或 block 标题拖到这里。</span>
          </div>
        ) : null}
        {remarks.map((remark) => (
          <article className="assistant-remark" key={remark.id}>
            <div className="assistant-remark-meta">
              <span>{modeLabels[remark.mode]} · {remark.focus.label}</span>
              <small>{remark.providerName}</small>
            </div>
            <div
              className="assistant-remark-markdown preview-markdown"
              dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(remark.markdown, sessionDir) }}
            />
            <div className="assistant-remark-actions">
              <button onClick={() => onSelectedRemarkChange?.(remark.id)} type="button">专注阅读</button>
              <button onClick={() => onPromoteRemark(remark.id)} type="button">转为笔记块</button>
              <button aria-label="删除旁注" onClick={() => onDeleteRemark(remark.id)} type="button"><Trash2 /></button>
            </div>
          </article>
        ))}
        {running ? (
          <article className="assistant-remark live" aria-live="polite">
            <div className="assistant-remark-meta"><span>{modeLabels[mode]} · {focus.label}</span><small>生成中</small></div>
            <pre>{liveText || "正在建立上下文..."}<span className="assistant-live-caret" /></pre>
          </article>
        ) : null}
      </div>

      <footer className="assistant-composer">
        <div className="assistant-focus-chip">
          <span>{focus.kind === "selection" ? "选区" : focus.kind === "block" ? "块" : "全文"}</span>
          <strong title={focus.label}>{focus.label}</strong>
          {focus.kind !== "session" ? (
            <button aria-label="恢复全文上下文" onClick={() => setFocus({ kind: "session", label: "当前 Session" })} type="button"><X /></button>
          ) : null}
        </div>
        {focus.excerpt ? (
          <blockquote className="assistant-focus-preview" data-testid="assistant-focus-preview">
            {focus.excerpt.slice(0, 320)}
            {focus.excerpt.length > 320 ? "…" : ""}
          </blockquote>
        ) : null}
        <div className="assistant-context-budget" data-testid="assistant-context-budget">
          <span>
            当前 {contextPreview.usage.sessionBlockCount} 块 /
            {contextPreview.usage.sessionCharacterCount.toLocaleString("zh-CN")} 字符
          </span>
          <span>
            实际笔记上下文 {contextPreview.usage.textCharacters.toLocaleString("zh-CN")} /
            {contextPreview.usage.maximumTextCharacters.toLocaleString("zh-CN")} 字符 · 图片最多{" "}
            {contextPreview.usage.maximumImageCount} 张
          </span>
          {contextPreview.usage.namedBlockOrdinals.length > 0 ? (
            <span>已优先包含第 {contextPreview.usage.namedBlockOrdinals.join("、")} 块</span>
          ) : null}
          {contextPreview.usage.focusTruncated || contextPreview.usage.truncated ? (
            <strong>内容超过硬上限，已按焦点、点名块、背景的顺序截断</strong>
          ) : null}
        </div>
        <textarea
          aria-label="向 AI 学习助手提问"
          onChange={(event) => setQuestion(event.currentTarget.value)}
          placeholder="要求后续变更，或直接提问..."
          ref={inputRef}
          value={question}
        />
        <div className="assistant-composer-actions">
          <div className="assistant-mode-picker">
            <button onClick={() => setModeMenuOpen((current) => !current)} type="button">
              {mode === "teach" ? <GraduationCap /> : <Sparkles />} {modeLabels[mode]} <ChevronDown />
            </button>
            {modeMenuOpen ? (
              <div className="assistant-mode-menu">
                {(Object.keys(modeLabels) as AssistantMode[]).map((candidate) => (
                  <button key={candidate} onClick={() => { setMode(candidate); setModeMenuOpen(false); }} type="button">
                    {modeLabels[candidate]}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {running ? (
            <button className="assistant-stop" onClick={onCancel} title="中断生成" type="button"><Square /></button>
          ) : (
            <button
              className="assistant-send"
              disabled={!onlineEnabled}
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
      </>
      )}
    </aside>
  );
}

export function DetachedAssistantWorkspace(props: AssistantWorkspaceProps) {
  const [portalWindow, setPortalWindow] = useState<Window | null>(null);
  const portalWindowRef = useRef<Window | null>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    if (!props.open) {
      portalWindowRef.current?.close();
      portalWindowRef.current = null;
      setPortalWindow(null);
      return;
    }

    const child = window.open("about:blank", "mathnotes-assistant", "popup,width=520,height=680");
    if (!child) {
      onCloseRef.current();
      return;
    }
    portalWindowRef.current = child;
    child.document.open();
    child.document.write(`<!doctype html><html lang="zh-CN"><head><base href="${document.baseURI}"><title>MathNotes 学习助手</title></head><body class="assistant-window-body"><div id="assistant-window-root"></div></body></html>`);
    child.document.close();
    for (const node of document.head.querySelectorAll('style,link[rel="stylesheet"]')) {
      child.document.head.append(node.cloneNode(true));
    }
    const handleClosed = () => {
      portalWindowRef.current = null;
      setPortalWindow(null);
      onCloseRef.current();
    };
    child.addEventListener("beforeunload", handleClosed, { once: true });
    setPortalWindow(child);
    child.focus();
    return () => child.removeEventListener("beforeunload", handleClosed);
  }, [props.open]);

  useEffect(() => () => portalWindowRef.current?.close(), []);

  const root = portalWindow?.document.getElementById("assistant-window-root");
  return root ? createPortal(<AssistantWorkspace {...props} detached open />, root) : null;
}

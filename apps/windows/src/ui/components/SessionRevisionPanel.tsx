import type { SessionAiRevision } from "../../core/sessionAiRevision";
import { renderMarkdownPreview } from "./PreviewPane";

export type SessionRevisionDraft = {
  instruction: string;
  status: "idle" | "generating" | "applying";
  proposal: SessionAiRevision | null;
  error?: string;
};

export function SessionRevisionPanel({ draft, sessionDir, onInstructionChange, onGenerate, onApply, onClose, onStop }: {
  draft: SessionRevisionDraft;
  sessionDir?: string;
  onInstructionChange?: (value: string) => void;
  onGenerate?: () => void;
  onApply?: () => void;
  onClose?: () => void;
  onStop?: () => void;
}) {
  const proposal = draft.proposal;
  return <section className="assistant-session-revision" aria-label="整篇笔记修改">
    <div className="assistant-user-bubble">{proposal?.instruction ?? draft.instruction}</div>
    <p className="assistant-lock-promise">整篇修改 · 保留锁定内容</p>
    {draft.status === "generating" ? <p role="status">正在通读全文并准备逐块修改…</p> : null}
    {proposal ? <>
      <p role="status">{proposal.status === "applied" ? `已应用 ${proposal.changes.length} 个块的修改` : `待审阅：${proposal.changes.length} 个块`}</p>
      <p>{proposal.summary}</p>
      {proposal.changes.map((change) => <details className="assistant-edit-card" key={change.blockId}>
        <summary><strong>{change.title}</strong><span>{change.summary}</span></summary>
        <div className="assistant-session-comparison">
          <article><h4>修改前</h4><div className="preview-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(change.before, sessionDir) }} /></article>
          <article><h4>修改后</h4><div className="preview-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(change.markdown, sessionDir) }} /></article>
        </div>
      </details>)}
      {proposal.lockedSuggestions.length ? <aside className="assistant-session-locked">
        <strong>因为以下块已被锁定，未能进行更改</strong>
        <ul>{proposal.lockedSuggestions.map((item) => <li key={item.blockId}><strong>{item.title}</strong><p>{item.suggestion}</p></li>)}</ul>
      </aside> : null}
      {!proposal.changes.length ? <p>没有需要应用的未锁定块修改。</p> : null}
    </> : null}
    {draft.error ? <p className="assistant-selection-error" role="alert">{draft.error}</p> : null}
    <footer className="assistant-selection-footer">
      <textarea aria-label="整篇笔记修改要求" value={draft.instruction} rows={3} disabled={draft.status !== "idle"}
        placeholder="例如：统一全文记号，补充未锁定推导的中间步骤…"
        onChange={(event) => onInstructionChange?.(event.currentTarget.value)} />
      <div className="assistant-selection-actions">
        <button type="button" disabled={draft.status === "applying"} onClick={draft.status === "generating" ? onStop : onClose}>
          {draft.status === "generating" ? "停止生成" : "返回对话"}
        </button>
        <button type="button" disabled={draft.status !== "idle" || !draft.instruction.trim()} onClick={onGenerate}>{proposal ? "按要求重新生成" : "生成整篇修改"}</button>
        {proposal?.status === "proposed" && proposal.changes.length > 0 ? <button className="assistant-apply-edit" type="button"
          disabled={draft.status !== "idle"} onClick={onApply}>{draft.status === "applying" ? "正在应用…" : "应用全文修改"}</button> : null}
      </div>
    </footer>
  </section>;
}

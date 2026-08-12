import { FileText, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { PdfImportMode, PickLocalPdfResult } from "../../types/mathNotesApi";

export type PdfImportDraft = Exclude<PickLocalPdfResult, { cancelled: true }> & {
  notebookId?: string;
  sessionId?: string;
};

export type PdfImportConfirmInput = {
  mode: PdfImportMode;
  destination: "current_session" | "new_session";
  newSessionTitle?: string;
  pageStart: number;
  pageEnd: number;
  concurrency: number;
};

export function PdfImportDialog({
  draft,
  providerLabel,
  onCancel,
  onConfirm
}: {
  draft: PdfImportDraft;
  providerLabel?: string;
  onCancel(): void;
  onConfirm(input: PdfImportConfirmInput): void | Promise<void>;
}) {
  const [destination, setDestination] = useState<PdfImportConfirmInput["destination"]>("current_session");
  const [mode, setMode] = useState<PdfImportMode>("read_only");
  const [newSessionTitle, setNewSessionTitle] = useState(draft.fileName.replace(/\.pdf$/i, ""));
  const [pageStart, setPageStart] = useState(1);
  const [pageEnd, setPageEnd] = useState(Math.min(draft.pageCount, 10));
  const [concurrency, setConcurrency] = useState(2);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onConfirm({
      mode,
      destination,
      newSessionTitle: destination === "new_session" ? newSessionTitle.trim() : undefined,
      pageStart: mode === "recognize_selected" ? pageStart : 1,
      pageEnd: mode === "recognize_selected" ? pageEnd : draft.pageCount,
      concurrency
    });
  }

  return (
    <div className="pdf-import-layer" role="presentation">
      <form aria-label="PDF 导入设置" className="pdf-import-dialog" onSubmit={submit} role="dialog">
        <header>
          <div>
            <span className="annotation-kicker">导入 PDF</span>
            <h2 title={draft.fileName}>{draft.fileName}</h2>
          </div>
          <button aria-label="关闭 PDF 导入" className="annotation-close" onClick={onCancel} type="button">
            <X />
          </button>
        </header>

        <div className="pdf-import-summary">
          <FileText />
          <div>
            <strong>{draft.pageCount} 页</strong>
            <span>{formatBytes(draft.byteLength)} · 原文件将完整保留</span>
          </div>
        </div>

        <fieldset>
          <legend>处理方式</legend>
          <label className={`pdf-import-choice ${mode === "read_only" ? "selected" : ""}`}>
            <input checked={mode === "read_only"} name="mode" onChange={() => setMode("read_only")} type="radio" />
            <span>
              <strong>仅阅读</strong>
              <small>把原文作为只读内容放进笔记，不启动识别</small>
            </span>
          </label>
          <label className={`pdf-import-choice ${mode === "recognize_selected" ? "selected" : ""}`}>
            <input
              checked={mode === "recognize_selected"}
              name="mode"
              onChange={() => setMode("recognize_selected")}
              type="radio"
            />
            <span>
              <strong>识别选定页</strong>
              <small>逐页生成 Markdown 草稿；原 PDF 仅作可回看的素材来源</small>
            </span>
          </label>
          <label className={`pdf-import-choice ${mode === "recognize_all" ? "selected" : ""}`}>
            <input checked={mode === "recognize_all"} name="mode" onChange={() => setMode("recognize_all")} type="radio" />
            <span>
              <strong>识别全部页</strong>
              <small>长文档建议新建一次笔记记录；原 PDF 完整保留但不重复显示</small>
            </span>
          </label>
          {mode !== "read_only" ? (
            <div className="pdf-import-recognition-options">
              {mode === "recognize_selected" ? (
                <div className="pdf-import-range">
                  <label>
                    起始页
                    <input
                      aria-label="起始页"
                      max={pageEnd}
                      min={1}
                      onChange={(event) => setPageStart(Number(event.target.value))}
                      type="number"
                      value={pageStart}
                    />
                  </label>
                  <label>
                    结束页
                    <input
                      aria-label="结束页"
                      max={draft.pageCount}
                      min={pageStart}
                      onChange={(event) => setPageEnd(Number(event.target.value))}
                      type="number"
                      value={pageEnd}
                    />
                  </label>
                </div>
              ) : null}
              <label>
                模型并发
                <select aria-label="模型并发" onChange={(event) => setConcurrency(Number(event.target.value))} value={concurrency}>
                  <option value={2}>2（推荐）</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                </select>
              </label>
              <small>当前识别服务：{providerLabel ?? "按设置页选择"}。遇到限流或超时会自动降速。</small>
            </div>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>放到哪里</legend>
          <label className={`pdf-import-choice ${destination === "current_session" ? "selected" : ""}`}>
            <input
              checked={destination === "current_session"}
              name="destination"
              onChange={() => setDestination("current_session")}
              type="radio"
            />
            <span>
              <strong>当前记录</strong>
              <small>插入到当前光标所在内容块后面</small>
            </span>
          </label>
          <label className={`pdf-import-choice ${destination === "new_session" ? "selected" : ""}`}>
            <input
              checked={destination === "new_session"}
              name="destination"
              onChange={() => setDestination("new_session")}
              type="radio"
            />
            <span>
              <strong>新建记录</strong>
              <small>适合较长 PDF，仍放在当前笔记本内</small>
            </span>
          </label>
          {destination === "new_session" ? (
            <label className="pdf-import-title">
              记录名称
              <input onChange={(event) => setNewSessionTitle(event.target.value)} required value={newSessionTitle} />
            </label>
          ) : null}
        </fieldset>

        <footer>
          <button className="secondary-action" onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-action" type="submit">
            导入 PDF
          </button>
        </footer>
      </form>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

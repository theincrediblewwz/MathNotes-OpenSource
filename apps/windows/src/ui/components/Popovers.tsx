import { ChevronDown, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSearchResult } from "../../common/sessionSearch";
import type { RecognitionTaskSummary } from "../../core/uploadTaskLog";
import type { CompanionUploadActivityEvent, ProviderRuntimeState, RecognitionRuntimeEvent } from "../../types/mathNotesApi";
import { providerRuntimeSummaryTitle } from "../providerRuntimeState";

type PopoverProps = {
  openLayer: string | null;
  onClose: () => void;
  onExport: () => void;
  onJump: (sourceId: string) => void;
};

type TaskPopoverProps = PopoverProps & {
  tasks: RecognitionTaskSummary[];
  events?: RecognitionRuntimeEvent[];
  uploadActivities?: CompanionUploadActivityEvent[];
  runtimeState?: ProviderRuntimeState;
  loading?: boolean;
  onRetry?: (recognitionJobId: string) => void;
  onCancelTask?: (recognitionJobId: string) => void;
  onPausePdfBatch?: (batchId: string) => void;
  onResumePdfBatch?: (batchId: string) => void;
  onCancelPdfBatch?: (batchId: string) => void;
};

type SearchPopoverProps = PopoverProps & {
  query: string;
  results: SessionSearchResult[];
  onQueryChange: (query: string) => void;
};

export type ExportOptions = {
  includeMetadataComments: boolean;
  includeAssistantRemarks: boolean;
  packageMode?: "markdown" | "share";
};

export type ExportResultView = {
  outPath: string;
  exportedBlocks: number;
  packageDir?: string;
  copiedAssets?: string[];
  missingAssets?: string[];
};

type ExportPopoverProps = Omit<PopoverProps, "onExport" | "onJump"> & {
  onExport: (options: ExportOptions) => void;
  lastExportResult?: ExportResultView | null;
  onRevealExport?: (outPath: string) => void;
};

export function SearchPopover({ openLayer, onClose, onJump, query, results, onQueryChange }: SearchPopoverProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (openLayer === "search") {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [openLayer]);

  return (
    <section
      aria-label="搜索"
      className={`popover command-palette ${openLayer === "search" ? "open" : ""}`}
      data-testid={openLayer === "search" ? "search-popover" : undefined}
    >
      <div className="popover-head">
        <Search />
        <input
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="搜索笔记、源码、公式或命令"
          ref={inputRef}
          type="search"
          value={query}
        />
      </div>
      {query.trim() && results.length === 0 ? <p className="muted">当前 Session 内没有匹配结果。</p> : null}
      {results.map((result) => (
        <button
          key={result.id}
          onClick={() => {
            onJump(result.sourceId);
            onClose();
          }}
          type="button"
        >
          <strong>{result.title}</strong>
          <small>{result.snippet}</small>
        </button>
      ))}
    </section>
  );
}

export function TaskPopover({
  openLayer,
  onClose,
  tasks,
  events = [],
  uploadActivities = [],
  runtimeState,
  loading = false,
  onRetry,
  onCancelTask,
  onPausePdfBatch,
  onResumePdfBatch,
  onCancelPdfBatch
}: TaskPopoverProps) {
  const pdfBatches = summarizePdfBatches(tasks);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());

  function toggleTask(taskId: string): void {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }
  return (
    <section
      aria-label="任务与块信息"
      className={`popover task-popover ${openLayer === "task" ? "open" : ""}`}
      data-testid={openLayer === "task" ? "task-popover" : undefined}
    >
      <div className="popover-title">
        <strong>任务与块信息</strong>
        <button aria-label="关闭任务信息" className="plain-icon" onClick={onClose} type="button">
          <X />
        </button>
      </div>
      {runtimeState ? (
        <div className={`codex-runtime-summary ${runtimeState.status}`}>
          <span />
          <div>
            <strong>{providerRuntimeSummaryTitle(runtimeState)}</strong>
            {runtimeState.status === "error" ? <small>{runtimeState.detail}</small> : null}
          </div>
        </div>
      ) : null}
      {uploadActivities.length > 0 ? (
        <div aria-label="手机素材接收进度" className="task-upload-activity">
          <strong>手机素材接收</strong>
          {uploadActivities.map((activity) => {
            const identity = `${activity.notebookId}/${activity.sessionId}/${activity.captureId ?? activity.fileName ?? activity.updatedAt}`;
            const total = activity.totalBytes;
            const progress = total && total > 0 ? Math.min(100, Math.round((activity.receivedBytes / total) * 100)) : undefined;
            return (
              <div className={`task-row upload-${activity.status}`} key={identity}>
                <span />
                <div>
                  <strong>{activity.fileName ?? "手机素材"}</strong>
                  <small>
                    {activity.status === "accepted" ? "接收完成" : "正在接收"}
                    {` · ${formatUploadBytes(activity.receivedBytes)}`}
                    {total !== undefined ? ` / ${formatUploadBytes(total)}` : ""}
                  </small>
                  {progress !== undefined ? <progress aria-label={`${activity.fileName ?? "手机素材"}接收进度`} max={100} value={progress} /> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {loading ? <p className="muted">正在读取任务记录</p> : null}
      {!loading && tasks.length === 0 ? <p className="muted">暂无真实任务记录。导入或上传照片后会显示识别状态。</p> : null}
      {pdfBatches.map((batch) => (
        <div className="task-row pdf-batch-row" key={batch.batchId}>
          <span />
          <div>
            <strong>PDF 分页识别</strong>
            <small>{`${batch.completed}/${batch.total} 页完成${batch.running ? " · 正在运行" : batch.pending ? " · 已暂停或等待继续" : ""}`}</small>
            <div className="task-batch-actions">
              {batch.running && onPausePdfBatch ? (
                <button className="task-retry-button" onClick={() => onPausePdfBatch(batch.batchId)} type="button">
                  暂停批次
                </button>
              ) : batch.pending && onResumePdfBatch ? (
                <button className="task-retry-button" onClick={() => onResumePdfBatch(batch.batchId)} type="button">
                  继续批次
                </button>
              ) : null}
              {(batch.running || batch.pending) && onCancelPdfBatch ? (
                <button className="task-retry-button danger-action" onClick={() => onCancelPdfBatch(batch.batchId)} type="button">
                  中断整批
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ))}
      {tasks.map((task) => {
        const expanded = expandedTaskIds.has(task.id);
        const taskEvents = dedupeRuntimeEvents(events.filter((event) => event.recognitionJobId === task.recognitionJobId));
        const taskConsoleText = buildRuntimeConsoleText(taskEvents);
        const detailsId = `recognition-task-details-${task.id}`;
        return (
          <article className={`task-row recognition-task-row ${task.recognitionStatus} ${task.failureKind ?? ""}`} key={task.id}>
            <button
              aria-controls={detailsId}
              aria-expanded={expanded}
              className="task-row-toggle"
              onClick={() => toggleTask(task.id)}
              type="button"
            >
              <span className="task-status-mark" />
              <span className="task-row-summary">
                <strong>{task.fileName}</strong>
                <small>{task.pageNumber ? `PDF 第 ${task.pageNumber}/${task.pageCount ?? "?"} 页 · ` : ""}{formatTaskStatus(task)}</small>
              </span>
              <ChevronDown aria-hidden="true" className={expanded ? "expanded" : ""} />
            </button>
            {expanded ? (
              <div className="task-row-details" id={detailsId}>
                <div className="task-detail-meta">
                  {task.providerLabel ? <span>识别服务：{task.providerLabel}</span> : null}
                  {formatTaskTiming(task) ? <span>{formatTaskTiming(task)}</span> : null}
                </div>
                {task.error ? <small className="task-error">失败原因：{task.error}</small> : null}
                {task.warnings?.length ? <small className="task-warning">{formatWarningSummary(task.warnings)}</small> : null}
                <div aria-label={`${task.fileName} 流式识别详情`} className="task-runtime-console">
                  {taskEvents.length > 0 ? <TerminalText text={taskConsoleText} /> : <p className="muted">尚未收到运行事件。</p>}
                </div>
                <div className="task-row-actions">
                  {task.recognitionStatus === "failed" && onRetry ? (
                    <button aria-label={`重试识别 ${task.recognitionJobId}`} className="task-retry-button" onClick={() => onRetry(task.recognitionJobId)} type="button">重试</button>
                  ) : null}
                  {task.recognitionStatus === "running" && onCancelTask ? (
                    <button aria-label={`中断识别 ${task.recognitionJobId}`} className="task-retry-button danger-action" onClick={() => onCancelTask(task.recognitionJobId)} type="button">中断</button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
      <p className="muted">当前块：来自左侧源码。点击右侧内容可定位源码。</p>
    </section>
  );
}

function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function summarizePdfBatches(tasks: RecognitionTaskSummary[]): Array<{
  batchId: string;
  total: number;
  completed: number;
  running: boolean;
  pending: boolean;
}> {
  const batches = new Map<string, RecognitionTaskSummary[]>();
  for (const task of tasks) {
    if (!task.batchId) continue;
    batches.set(task.batchId, [...(batches.get(task.batchId) ?? []), task]);
  }
  return [...batches.entries()].map(([batchId, entries]) => ({
    batchId,
    total: entries.length,
    completed: entries.filter((entry) => entry.recognitionStatus === "succeeded").length,
    running: entries.some((entry) => entry.recognitionStatus === "running"),
    pending: entries.some((entry) => entry.recognitionStatus === "pending")
  }));
}

function formatWarningSummary(warnings: string[]): string {
  return warnings.length === 1 ? "需要复核：1 条" : `需要复核：${warnings.length} 条`;
}

function TerminalText({ text }: { text: string }) {
  const [visibleText, setVisibleText] = useState(text);
  const targetTextRef = useRef(text);

  useEffect(() => {
    targetTextRef.current = text;
    setVisibleText((current) => {
      if (text.startsWith(current)) {
        return current;
      }

      const animatedTailLength = 260;
      const immediateLength = Math.max(0, text.length - animatedTailLength);
      return text.slice(0, immediateLength);
    });
  }, [text]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setVisibleText((current) => {
        const targetText = targetTextRef.current;
        if (current === targetText) {
          return current;
        }
        if (!targetText.startsWith(current)) {
          const immediateLength = Math.max(0, targetText.length - 260);
          return targetText.slice(0, immediateLength);
        }
        return targetText.slice(0, Math.min(targetText.length, current.length + 12));
      });
    }, 45);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <pre>
      {visibleText}
      <span className="runtime-cursor" />
    </pre>
  );
}

function dedupeRuntimeEvents(events: RecognitionRuntimeEvent[]): RecognitionRuntimeEvent[] {
  const seen = new Set<string>();
  const deduped: RecognitionRuntimeEvent[] = [];

  for (const event of events) {
    if (event.level === "stdout") {
      deduped.push(event);
      continue;
    }
    const message = event.message.trim();
    const key = `${event.recognitionJobId}:${event.level}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

export function buildRuntimeConsoleText(events: RecognitionRuntimeEvent[]): string {
  const groups: Array<{ event: RecognitionRuntimeEvent; message: string }> = [];
  for (const event of [...events].reverse()) {
    const previous = groups.at(-1);
    if (
      event.level === "stdout" &&
      previous?.event.level === "stdout" &&
      previous.event.recognitionJobId === event.recognitionJobId
    ) {
      previous.message += event.message;
      continue;
    }
    groups.push({ event, message: event.message });
  }
  return groups
    .map(({ event, message }) =>
      `[${formatRuntimeTime(event.at)}] ${event.level}> ${message.trim() || "(empty chunk)"}`
    )
    .join("\n");
}

function formatTaskStatus(task: RecognitionTaskSummary): string {
  const statusText =
    task.recognitionStatus === "succeeded"
      ? "识别完成"
      : task.recognitionStatus === "failed"
        ? task.failureKind === "output_anomaly"
          ? "异常输出已停止"
          : "识别失败"
        : task.recognitionStatus === "cancelled"
          ? "识别已中断"
          : task.recognitionStatus === "running"
            ? "识别中"
            : "等待识别";

  return statusText;
}

function formatTaskTiming(task: RecognitionTaskSummary): string | null {
  const timing = task.timing;
  if (!timing) return null;
  const parts: string[] = [];
  if (timing.queueMs !== undefined) parts.push(`等待 ${formatDuration(timing.queueMs)}`);
  if (timing.firstOutputMs !== undefined) parts.push(`模型首字 ${formatDuration(timing.firstOutputMs)}`);
  if (timing.totalMs !== undefined) parts.push(`总计 ${formatDuration(timing.totalMs)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
}

function formatRuntimeTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function ExportPopover({ openLayer, onClose, onExport, lastExportResult, onRevealExport }: ExportPopoverProps) {
  const [includeMetadataComments, setIncludeMetadataComments] = useState(true);
  const [includeAssistantRemarks, setIncludeAssistantRemarks] = useState(false);
  const [showMissingAssets, setShowMissingAssets] = useState(false);
  const missingAssets = lastExportResult?.missingAssets ?? [];

  useEffect(() => {
    setShowMissingAssets(false);
  }, [lastExportResult?.outPath, lastExportResult?.packageDir]);

  return (
    <section
      aria-label="导出"
      className={`popover export-popover ${openLayer === "export" ? "open" : ""}`}
      data-testid={openLayer === "export" ? "export-popover" : undefined}
    >
      <div className="popover-title">
        <strong>导出 Markdown</strong>
        <button aria-label="关闭导出" className="plain-icon" onClick={onClose} type="button">
          <X />
        </button>
      </div>
      <label>
        <input
          checked={includeMetadataComments}
          onChange={(event) => setIncludeMetadataComments(event.currentTarget.checked)}
          type="checkbox"
        />{" "}
        保留内容来源注释
      </label>
      <label>
        <input
          checked={includeAssistantRemarks}
          onChange={(event) => setIncludeAssistantRemarks(event.currentTarget.checked)}
          type="checkbox"
        />{" "}
        把 AI 旁注附在文末
      </label>
      <button className="primary-action" onClick={() => onExport({ includeMetadataComments, includeAssistantRemarks })} type="button">
        导出当前 Session
      </button>
      <button className="secondary-action" onClick={() => onExport({ includeMetadataComments, includeAssistantRemarks, packageMode: "share" })} type="button">
        导出分享包
      </button>
      {lastExportResult ? (
        <div className="export-result" data-testid="export-result">
          <strong>最近导出</strong>
          <small>{lastExportResult.outPath}</small>
          <small>{lastExportResult.exportedBlocks} 个 Markdown block</small>
          {lastExportResult.packageDir ? <small>分享包：{lastExportResult.packageDir}</small> : null}
          {lastExportResult.copiedAssets ? <small>已复制 {lastExportResult.copiedAssets.length} 个素材</small> : null}
          {missingAssets.length ? (
            <>
              <small className="export-warning">缺失 {missingAssets.length} 个素材</small>
              <button className="secondary-action compact-action" onClick={() => setShowMissingAssets((current) => !current)} type="button">
                {showMissingAssets ? "收起缺失素材" : "查看缺失素材"}
              </button>
              {showMissingAssets ? (
                <ul className="export-missing-assets">
                  {missingAssets.map((assetPath) => (
                    <li key={assetPath}>{assetPath}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {onRevealExport ? (
            <button aria-label="定位导出文件" onClick={() => onRevealExport(lastExportResult.outPath)} type="button">
              定位文件
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

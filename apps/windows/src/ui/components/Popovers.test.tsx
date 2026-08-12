import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildRuntimeConsoleText, ExportPopover, TaskPopover } from "./Popovers";

describe("buildRuntimeConsoleText", () => {
  it("renders consecutive stdout chunks as one continuous task stream", () => {
    const common = {
      notebookId: "analysis",
      sessionId: "lecture",
      recognitionJobId: "recognition_0001",
      level: "stdout" as const
    };
    const text = buildRuntimeConsoleText([
      { ...common, id: "3", at: "2026-07-19T15:38:43.000Z", message: "内容。" },
      { ...common, id: "2", at: "2026-07-19T15:38:42.000Z", message: "流式" },
      { ...common, id: "1", at: "2026-07-19T15:38:41.000Z", message: "连续" }
    ]);

    expect(text).toMatch(/\[\d{2}:38:41\] stdout> 连续流式内容。/);
    expect(text.match(/stdout>/g)).toHaveLength(1);
  });
});

describe("TaskPopover", () => {
  it("shows live phone upload byte progress before recognition starts", () => {
    render(
      <TaskPopover
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        openLayer="task"
        tasks={[]}
        uploadActivities={[
          {
            version: 1,
            notebookId: "analysis",
            sessionId: "lecture",
            captureId: "capture-1",
            fileName: "page-01.jpg",
            receivedBytes: 2048,
            totalBytes: 4096,
            status: "receiving",
            updatedAt: "2026-07-29T02:00:00.000Z"
          }
        ]}
      />
    );

    expect(screen.getByText("手机素材接收")).toBeTruthy();
    expect(screen.getByText("page-01.jpg")).toBeTruthy();
    expect(screen.getByText(/2.0 KB \/ 4.0 KB/)).toBeTruthy();
    expect((screen.getByRole("progressbar", { name: "page-01.jpg接收进度" }) as HTMLProgressElement).value).toBe(50);
  });

  it("shows failed recognition errors and retry actions", () => {
    const onRetry = vi.fn();

    render(
      <TaskPopover
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        onRetry={onRetry}
        openLayer="task"
        tasks={[
          {
            id: "recognition_0001",
            fileName: "failed.jpg",
            assetPath: "assets/photos/failed.jpg",
            recognitionJobId: "recognition_0001",
            recognitionStatus: "failed",
            imageBlockId: "0001",
            transcriptBlockId: "-",
            receivedAt: "2026-06-27T02:00:00.000Z",
            error: "provider offline"
          }
        ]}
      />
    );

    expect(screen.getByText("failed.jpg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /failed\.jpg/ }));
    expect(screen.getByText(/provider offline/)).toBeTruthy();
    expect(screen.queryByText("Codex CLI stream")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试识别 recognition_0001" }));

    expect(onRetry).toHaveBeenCalledWith("recognition_0001");
  });

  it("labels stopped output anomalies and keeps retry available", () => {
    const onRetry = vi.fn();

    render(
      <TaskPopover
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        onRetry={onRetry}
        openLayer="task"
        tasks={[
          {
            id: "recognition_0004",
            fileName: "looping.jpg",
            assetPath: "assets/photos/looping.jpg",
            recognitionJobId: "recognition_0004",
            recognitionStatus: "failed",
            failureKind: "output_anomaly",
            imageBlockId: "0004",
            transcriptBlockId: "0005",
            receivedAt: "2026-07-10T12:00:00.000Z",
            error: "持续重复输出已自动停止。"
          }
        ]}
      />
    );

    expect(screen.getByText(/异常输出已停止/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /looping\.jpg/ }));
    const retry = screen.getByRole("button", { name: "重试识别 recognition_0004" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith("recognition_0004");
  });

  it("summarizes recognition warnings instead of dumping long provider logs", () => {
    const longProviderLog = "Reading prompt from stdin... OpenAI Codex v0.142.3 ".repeat(20);
    render(
      <TaskPopover
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        openLayer="task"
        tasks={[
          {
            id: "recognition_0002",
            fileName: "math-board.jpg",
            assetPath: "assets/photos/math-board.jpg",
            recognitionJobId: "recognition_0002",
            recognitionStatus: "succeeded",
            imageBlockId: "0002",
            transcriptBlockId: "0003",
            receivedAt: "2026-06-27T02:10:00.000Z",
            warnings: [longProviderLog]
          }
        ]}
      />
    );

    expect(screen.getByText("math-board.jpg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /math-board\.jpg/ }));
    expect(screen.getByText("需要复核：1 条")).toBeTruthy();
    expect(screen.queryByText(/OpenAI Codex v0\.142\.3/)).toBeNull();
  });

  it("shows Codex CLI runtime readiness separately from task rows", () => {
    render(
      <TaskPopover
        runtimeState={{
          providerId: "codex_cli",
          status: "ready",
          progress: 100,
          detail: "Codex CLI runtime 已启动，随时准备接收图片。",
          command: "wsl.exe --exec codex exec-server",
          updatedAt: "2026-07-01T00:00:00.000Z"
        }}
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        openLayer="task"
        tasks={[]}
      />
    );

    expect(screen.getByText("Codex CLI 启动成功")).toBeTruthy();
    expect(screen.queryByText(/随时准备接收图片/)).toBeNull();
    expect(screen.queryByText(/wsl\.exe --exec codex/)).toBeNull();
  });

  it("summarizes API provider runtime without Codex-specific wording", () => {
    render(
      <TaskPopover
        runtimeState={{
          providerId: "mimo_2_5",
          status: "ready",
          progress: 100,
          detail: "Mimo API provider ready",
          updatedAt: "2026-07-02T00:00:00.000Z"
        }}
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        openLayer="task"
        tasks={[]}
      />
    );

    expect(screen.getByText("Mimo v2.5 API 已就绪")).toBeTruthy();
    expect(screen.queryByText(/Codex CLI/)).toBeNull();
    expect(screen.queryByText(/Mimo API provider ready/)).toBeNull();
  });

  it("offers a cancel action for running recognition tasks", () => {
    const onCancelTask = vi.fn();

    render(
      <TaskPopover
        loading={false}
        onCancelTask={onCancelTask}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        openLayer="task"
        tasks={[
          {
            id: "recognition_0003",
            fileName: "looping.jpg",
            assetPath: "assets/photos/looping.jpg",
            recognitionJobId: "recognition_0003",
            recognitionStatus: "running",
            imageBlockId: "0003",
            transcriptBlockId: "0004",
            receivedAt: "2026-07-03T02:00:00.000Z",
            providerLabel: "Mimo v2.5",
            providerName: "mimo_2_5",
            timing: {
              acceptedAt: "2026-07-03T02:00:00.000Z",
              queueMs: 420,
              firstOutputMs: 1250,
              totalMs: 3400
            }
          }
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /looping\.jpg/ }));
    expect(screen.getByText("识别服务：Mimo v2.5")).toBeTruthy();
    expect(screen.getByText("等待 420 ms · 模型首字 1.3 秒 · 总计 3.4 秒")).toBeTruthy();
    expect(screen.queryByText(/image 0003/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "中断识别 recognition_0003" }));

    expect(onCancelTask).toHaveBeenCalledWith("recognition_0003");
  });

  it("expands only the selected task's streamed events and collapses them again", () => {
    render(
      <TaskPopover
        events={[
          { id: "1", at: "2026-07-03T02:00:01.000Z", notebookId: "analysis", sessionId: "lecture", recognitionJobId: "recognition_a", level: "stdout", message: "alpha delta" },
          { id: "2", at: "2026-07-03T02:00:02.000Z", notebookId: "analysis", sessionId: "lecture", recognitionJobId: "recognition_b", level: "stdout", message: "beta delta" }
        ]}
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        openLayer="task"
        tasks={[
          { id: "task-a", fileName: "alpha.jpg", assetPath: "assets/alpha.jpg", recognitionJobId: "recognition_a", recognitionStatus: "running", imageBlockId: "0001", transcriptBlockId: "0002", receivedAt: "2026-07-03T02:00:00.000Z" },
          { id: "task-b", fileName: "beta.jpg", assetPath: "assets/beta.jpg", recognitionJobId: "recognition_b", recognitionStatus: "running", imageBlockId: "0003", transcriptBlockId: "0004", receivedAt: "2026-07-03T02:00:00.000Z" }
        ]}
      />
    );

    const alpha = screen.getByRole("button", { name: /alpha\.jpg/ });
    expect(alpha.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/alpha delta/)).toBeNull();
    fireEvent.click(alpha);
    expect(alpha.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/alpha delta/)).toBeTruthy();
    expect(screen.queryByText(/beta delta/)).toBeNull();
    fireEvent.click(alpha);
    expect(screen.queryByText(/alpha delta/)).toBeNull();
  });

  it("controls a running PDF recognition batch", () => {
    const onPausePdfBatch = vi.fn();
    const onCancelPdfBatch = vi.fn();

    render(
      <TaskPopover
        loading={false}
        onCancelPdfBatch={onCancelPdfBatch}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        onPausePdfBatch={onPausePdfBatch}
        openLayer="task"
        tasks={[
          {
            id: "recognition_pdf_1",
            fileName: "lecture.pdf",
            assetPath: "assets/pdfs/lecture.pdf",
            recognitionJobId: "recognition_pdf_1",
            recognitionStatus: "running",
            imageBlockId: "pdf_page_1",
            transcriptBlockId: "transcript_1",
            receivedAt: "2026-07-14T02:00:00.000Z",
            batchId: "pdf_batch_1",
            pageNumber: 1,
            pageCount: 5
          }
        ]}
      />
    );

    expect(screen.getByText(/0\/1 页完成/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停批次" }));
    fireEvent.click(screen.getByRole("button", { name: "中断整批" }));

    expect(onPausePdfBatch).toHaveBeenCalledWith("pdf_batch_1");
    expect(onCancelPdfBatch).toHaveBeenCalledWith("pdf_batch_1");
  });

  it("continues a PDF recognition batch with pending pages", () => {
    const onResumePdfBatch = vi.fn();

    render(
      <TaskPopover
        loading={false}
        onClose={() => undefined}
        onExport={() => undefined}
        onJump={() => undefined}
        onResumePdfBatch={onResumePdfBatch}
        openLayer="task"
        tasks={[
          {
            id: "recognition_pdf_2",
            fileName: "lecture.pdf",
            assetPath: "assets/pdfs/lecture.pdf",
            recognitionJobId: "recognition_pdf_2",
            recognitionStatus: "pending",
            imageBlockId: "pdf_page_2",
            transcriptBlockId: "transcript_2",
            receivedAt: "2026-07-14T02:00:00.000Z",
            batchId: "pdf_batch_1",
            pageNumber: 2,
            pageCount: 5
          }
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "继续批次" }));
    expect(onResumePdfBatch).toHaveBeenCalledWith("pdf_batch_1");
  });
});

describe("ExportPopover", () => {
  it("requests a share package export from the export popover", () => {
    const onExport = vi.fn();

    render(
      <ExportPopover
        lastExportResult={null}
        onClose={() => undefined}
        onExport={onExport}
        openLayer="export"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "导出分享包" }));

    expect(onExport).toHaveBeenCalledWith({
      includeMetadataComments: true,
      includeAssistantRemarks: false,
      packageMode: "share"
    });
  });

  it("adds AI remarks only after the user opts in", () => {
    const onExport = vi.fn();
    render(
      <ExportPopover
        lastExportResult={null}
        onClose={() => undefined}
        onExport={onExport}
        openLayer="export"
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "把 AI 旁注附在文末" }));
    fireEvent.click(screen.getByRole("button", { name: "导出当前 Session" }));
    expect(onExport).toHaveBeenCalledWith({
      includeMetadataComments: true,
      includeAssistantRemarks: true
    });
  });

  it("shows the latest export result and reveals it on demand", () => {
    const onRevealExport = vi.fn();

    render(
      <ExportPopover
        lastExportResult={{
          outPath: "C:/notes/exports/lecture.md",
          exportedBlocks: 3,
          copiedAssets: ["assets/embedded/diagram.png"],
          packageDir: "C:/notes/exports/lecture_share",
          missingAssets: ["assets/embedded/missing.png"]
        }}
        onClose={() => undefined}
        onExport={() => undefined}
        onRevealExport={onRevealExport}
        openLayer="export"
      />
    );

    expect(screen.getByText(/lecture\.md/)).toBeTruthy();
    expect(screen.getByText(/3 个 Markdown block/)).toBeTruthy();
    expect(screen.getByText(/已复制 1 个素材/)).toBeTruthy();
    expect(screen.getByText(/缺失 1 个素材/)).toBeTruthy();
    expect(screen.queryByText("assets/embedded/missing.png")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看缺失素材" }));
    expect(screen.getByText("assets/embedded/missing.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "定位导出文件" }));

    expect(onRevealExport).toHaveBeenCalledWith("C:/notes/exports/lecture.md");
  });
});

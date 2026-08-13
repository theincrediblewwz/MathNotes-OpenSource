import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  App,
  AssetPreviewOverlay,
  enqueueToastMessage,
  exceedsWindowDragThreshold,
  formatByteCount,
  isOrdinaryShortcutInput,
  isPreviewScrollbarGutterPoint,
  RecognitionRefreshPending,
  recognitionTaskToastTitle,
  resolvePdfImportTarget,
  SessionDeleteConfirmPrompt,
  SelectionEditDialog,
  upsertCompanionUploadActivity
} from "./App";

describe("SelectionEditDialog", () => {
  const baseDraft = {
    blockId: "0007",
    from: 2,
    to: 8,
    selectedText: "原始选区",
    instruction: "修正语病",
    proposal: null,
    status: "idle" as const
  };

  it("shows before/candidate evidence and never applies before explicit confirmation", () => {
    const onApply = vi.fn();
    const onGenerate = vi.fn();
    const { rerender } = render(
      <SelectionEditDialog
        draft={baseDraft}
        onApply={onApply}
        onCancel={vi.fn()}
        onGenerate={onGenerate}
        onInstructionChange={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText("原始选区")).toBeTruthy();
    expect(screen.getByText(/此时不会修改笔记/)).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成修改候选" }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();

    rerender(
      <SelectionEditDialog
        draft={{
          ...baseDraft,
          proposal: {
            version: 1,
            id: "selection_00000000-0000-0000-0000-000000000000",
            notebookId: "book",
            sessionId: "session",
            blockId: "0007",
            baseRevision: "a".repeat(64),
            selection: { from: 2, to: 8, selectedText: "原始选区" },
            instruction: "修正语病",
            replacementMarkdown: "修改候选",
            providerName: "Mimo v2.5",
            status: "proposed",
            createdAt: "2026-08-13T00:00:00.000Z",
            updatedAt: "2026-08-13T00:00:00.000Z"
          }
        }}
        onApply={onApply}
        onCancel={vi.fn()}
        onGenerate={onGenerate}
        onInstructionChange={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText("修改候选")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("preserves a conflict message with the candidate and exposes retry/cancel", () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    render(
      <SelectionEditDialog
        draft={{
          ...baseDraft,
          error: "应用失败：内容已变化，候选仍保留",
          proposal: {
            version: 1,
            id: "selection_00000000-0000-0000-0000-000000000000",
            notebookId: "book",
            sessionId: "session",
            blockId: "0007",
            baseRevision: "a".repeat(64),
            selection: { from: 2, to: 8, selectedText: "原始选区" },
            instruction: "修正语病",
            replacementMarkdown: "修改候选",
            providerName: "Mimo v2.5",
            status: "proposed",
            createdAt: "2026-08-13T00:00:00.000Z",
            updatedAt: "2026-08-13T00:00:00.000Z"
          }
        }}
        onApply={vi.fn()}
        onCancel={onCancel}
        onGenerate={vi.fn()}
        onInstructionChange={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain("候选仍保留");
    expect(screen.getByText("修改候选")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("window drag gesture arbitration", () => {
  it("keeps a click editable until pointer movement crosses the drag threshold", () => {
    const start = { x: 100, y: 40 };
    expect(exceedsWindowDragThreshold(start, { x: 103, y: 44 })).toBe(false);
    expect(exceedsWindowDragThreshold(start, { x: 106, y: 40 })).toBe(true);
  });

  it("reserves the rightmost preview gutter for the native scrollbar", () => {
    expect(isPreviewScrollbarGutterPoint(1265, 1280)).toBe(false);
    expect(isPreviewScrollbarGutterPoint(1266, 1280)).toBe(true);
    expect(isPreviewScrollbarGutterPoint(1279, 1280)).toBe(true);
  });

  it("blocks ordinary form fields but allows the configured shortcut inside CodeMirror", () => {
    const input = document.createElement("input");
    expect(isOrdinaryShortcutInput(input)).toBe(true);

    const ordinaryEditable = document.createElement("div");
    ordinaryEditable.setAttribute("contenteditable", "true");
    expect(isOrdinaryShortcutInput(ordinaryEditable)).toBe(true);

    const codeMirror = document.createElement("div");
    codeMirror.className = "cm-editor";
    const codeMirrorContent = document.createElement("div");
    codeMirrorContent.setAttribute("contenteditable", "true");
    codeMirror.append(codeMirrorContent);
    expect(isOrdinaryShortcutInput(codeMirrorContent)).toBe(false);
  });
});

describe("enqueueToastMessage", () => {
  it("keeps durable receipt feedback ahead of the following recognition state", () => {
    const received = enqueueToastMessage([], "已收到识别素材：photo.jpg");
    const running = enqueueToastMessage(received, "正在识别：photo.jpg");

    expect(running).toEqual(["已收到识别素材：photo.jpg", "正在识别：photo.jpg"]);
    expect(enqueueToastMessage(running, "正在识别：photo.jpg")).toBe(running);
  });
});

describe("recognitionTaskToastTitle", () => {
  const failedTask = {
    id: "recognition_0001",
    fileName: "photo.jpg",
    assetPath: "assets/photos/photo.jpg",
    recognitionJobId: "recognition_0001",
    recognitionStatus: "failed" as const,
    imageBlockId: "0001",
    transcriptBlockId: "0002",
    receivedAt: "2026-07-10T12:00:00.000Z"
  };

  it("distinguishes output anomalies from ordinary recognition failures", () => {
    expect(recognitionTaskToastTitle({ ...failedTask, failureKind: "output_anomaly" })).toBe(
      "异常输出已停止，可重试"
    );
    expect(recognitionTaskToastTitle(failedTask)).toBe("识别失败，可重试");
  });
});

describe("companion upload activity", () => {
  it("keeps the latest progress for one capture and preserves recent history", () => {
    const receiving = {
      version: 1 as const,
      notebookId: "book",
      sessionId: "session",
      captureId: "capture-1",
      fileName: "page.jpg",
      receivedBytes: 1024,
      totalBytes: 4096,
      status: "receiving" as const,
      updatedAt: "2026-07-29T02:00:00.000Z"
    };
    const accepted = {
      ...receiving,
      receivedBytes: 4096,
      status: "accepted" as const,
      updatedAt: "2026-07-29T02:00:01.000Z"
    };

    expect(upsertCompanionUploadActivity([receiving], accepted)).toEqual([accepted]);
    expect(formatByteCount(4096)).toBe("4.0 KB");
    expect(formatByteCount(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("RecognitionRefreshPending", () => {
  it("makes a deferred recognition result visible without overwriting unsaved edits", () => {
    const onSave = vi.fn();
    render(<RecognitionRefreshPending onSave={onSave} saving={false} />);

    expect(screen.getByText("新的识别结果已到达")).toBeTruthy();
    expect(screen.getByText(/避免覆盖/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存并载入" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePdfImportTarget", () => {
  const current = { notebookId: "current-book", sessionId: "current-session" };

  it("keeps the target selected by Android even when another Session is open", () => {
    expect(resolvePdfImportTarget({ notebookId: "phone-book", sessionId: "phone-session" }, current)).toEqual({
      notebookId: "phone-book",
      sessionId: "phone-session"
    });
  });

  it("uses the open Session for a locally selected PDF", () => {
    expect(resolvePdfImportTarget({}, current)).toEqual(current);
  });
});

describe("SessionDeleteConfirmPrompt", () => {
  const session = {
    notebookId: "functional_analysis",
    sessionId: "lecture",
    title: "泛函分析 第 3 讲",
    status: "draft" as const,
    createdAt: "2026-06-30T08:00:00.000Z",
    updatedAt: "2026-06-30T08:00:00.000Z"
  };

  it("uses an in-app confirmation dialog for deleting sessions", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(<SessionDeleteConfirmPrompt onCancel={onCancel} onConfirm={onConfirm} session={session} />);

    expect(screen.getByTestId("session-delete-confirm")).toBeTruthy();
    expect(screen.getByText("删除 Session？")).toBeTruthy();
    expect(screen.getByText("泛函分析 第 3 讲")).toBeTruthy();
    expect(screen.getByText("lecture")).toBeTruthy();
    expect(screen.getByText(/blocks、assets、exports/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("AssetPreviewOverlay", () => {
  it("renders the selected asset and can reveal it in the file manager", () => {
    const onClose = vi.fn();
    const onReveal = vi.fn();

    render(
      <AssetPreviewOverlay
        onClose={onClose}
        onReveal={onReveal}
        preview={{
          absolutePath: "C:\\MathNotes\\sessions\\s\\assets\\embedded\\diagram.png",
          assetPath: "assets/embedded/diagram.png",
          label: "diagram.png",
          mediaType: "image",
          previewUrl: "mathnotes-asset://local/C:/MathNotes/sessions/s/assets/embedded/diagram.png"
        }}
      />
    );

    expect(screen.getByTestId("asset-preview")).toBeTruthy();
    expect(screen.getByAltText("diagram.png").getAttribute("src")).toBe("mathnotes-asset://local/C:/MathNotes/sessions/s/assets/embedded/diagram.png");

    fireEvent.click(screen.getByRole("button", { name: "在文件夹中显示" }));
    expect(onReveal).toHaveBeenCalledWith("C:\\MathNotes\\sessions\\s\\assets\\embedded\\diagram.png");

    fireEvent.click(screen.getByRole("button", { name: "关闭素材预览" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("routes PDF assets to the document preview instead of an image element", () => {
    render(
      <AssetPreviewOverlay
        onClose={() => undefined}
        onReveal={() => undefined}
        preview={{
          absolutePath: "C:\\MathNotes\\sessions\\s\\assets\\pdfs\\lecture.pdf",
          assetPath: "assets/pdfs/lecture.pdf",
          label: "lecture.pdf",
          mediaType: "pdf",
          previewUrl: "mathnotes-asset://local/C:/MathNotes/sessions/s/assets/pdfs/lecture.pdf"
        }}
      />
    );

    expect(screen.queryByAltText("lecture.pdf")).toBeNull();
    expect(screen.getByText("正在打开 lecture.pdf")).toBeTruthy();
  });

});

describe("App floating layers", () => {
  it("can switch to a preview-only reading mode and restore the source pane", () => {
    const { container } = render(<App />);

    expect(screen.queryByTestId("provider-assistant")).toBeNull();
    expect(screen.queryByTestId("runtime-stream-panel")).toBeNull();

    expect(container.querySelector(".app-shell")?.className).not.toContain("reading-only");
    fireEvent.click(screen.getByRole("button", { name: "进入阅读模式" }));
    expect(container.querySelector(".app-shell")?.className).toContain("reading-only");
    expect(screen.getByRole("button", { name: "退出阅读模式" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "笔记目录" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "退出阅读模式" }));
    expect(container.querySelector(".app-shell")?.className).not.toContain("reading-only");
  });

  it("hides the preview source hover tip before opening export controls", () => {
    window.localStorage.setItem("mathnotes:preview-windowing-lab", "off");
    const { container } = render(<App />);
    const previewBlock = container.querySelector(".render-block") as HTMLElement;
    previewBlock.getBoundingClientRect = () =>
      ({
        bottom: 180,
        height: 100,
        left: 0,
        right: 600,
        top: 80,
        width: 600,
        x: 0,
        y: 80,
        toJSON: () => undefined
      }) as DOMRect;

    fireEvent.mouseMove(previewBlock, { clientX: 240, clientY: 120 });
    expect(screen.getByTestId("hover-tip").style.display).toBe("block");

    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));

    expect(screen.getByTestId("export-popover")).toBeTruthy();
    expect(screen.getByTestId("hover-tip").style.display).toBe("none");
    window.localStorage.removeItem("mathnotes:preview-windowing-lab");
  });
});

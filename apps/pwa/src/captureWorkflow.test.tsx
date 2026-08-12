// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureBatchEditor, CaptureHistoryViewer, CapturePanel } from "./App";
import { DEFAULT_CAPTURE_EDIT } from "./captureEditing";
import type { UploadTask } from "./domain";

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:preview")
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(cleanup);

describe("PWA continuous capture workflow", () => {
  it("uses one system camera entry with an optional post-edit switch", async () => {
    const onFiles = vi.fn(async () => undefined);
    const rendered = render(
      <CapturePanel
        targets={[{ notebookId: "notes", notebookTitle: "课堂", sessionId: "lesson", title: "第一讲" }]}
        preferredTarget={{ notebookId: "notes", notebookTitle: "课堂", sessionId: "lesson", title: "第一讲" }}
        tasks={[]}
        capabilities={{ imageUpload: true, pdfUpload: true, recognitionStatus: true, recognitionRetry: true }}
        persistenceState="granted"
        onFiles={onFiles}
        onRetry={vi.fn()}
        onRetryRecognition={vi.fn()}
        onRemove={vi.fn()}
        onClearSucceeded={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "连续采集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "高质量单张" })).toBeNull();
    expect(screen.getByRole("button", { name: "拍照" })).toBeTruthy();
    const editSwitch = screen.getByRole("switch", { name: /拍后编辑/ });
    expect(editSwitch.getAttribute("aria-checked")).toBe("false");
    const cameraInput = rendered.container.querySelector('input[capture="environment"]') as HTMLInputElement;
    fireEvent.change(cameraInput, { target: { files: [photo("one.jpg")] } });
    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "素材预览与拍后编辑" })).toBeNull();

    fireEvent.click(editSwitch);
    expect(editSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.change(cameraInput, { target: { files: [photo("two.jpg")] } });
    expect(screen.getByText("本次采集 1 张")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "素材预览与拍后编辑" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭素材预览" }));
    fireEvent.click(rendered.container.querySelector(".capture-current-batch .capture-editor-thumbnails button") as HTMLElement);
    expect(screen.getByRole("dialog", { name: "素材预览与拍后编辑" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭素材预览" }));
    expect(screen.queryByRole("dialog", { name: "素材预览与拍后编辑" })).toBeNull();
    expect(screen.getByText("本次采集 1 张")).toBeTruthy();
  });

  it("keeps returned system-camera photos in one editable batch", () => {
    const onEdit = vi.fn();
    const onActiveIndex = vi.fn();
    const onCaptureMore = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CaptureBatchEditor
        drafts={[
          { id: "draft-1", file: photo("one.jpg"), edit: DEFAULT_CAPTURE_EDIT },
          { id: "draft-2", file: photo("two.jpg"), edit: DEFAULT_CAPTURE_EDIT }
        ]}
        activeIndex={0}
        target={{ notebookId: "notes", notebookTitle: "课堂", sessionId: "lesson", title: "第一讲" }}
        error=""
        isPreparing={false}
        onActiveIndex={onActiveIndex}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onCaptureMore={onCaptureMore}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText("课堂 / 第一讲 · 1/2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续拍一张" }));
    expect(onCaptureMore).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "右转" }));
    expect(onEdit).toHaveBeenCalledWith("draft-1", { rotation: 90, crop: "original" });
    fireEvent.click(screen.getByRole("button", { name: "方形" }));
    expect(onEdit).toHaveBeenCalledWith("draft-1", { rotation: 0, crop: "square" });
    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(onActiveIndex).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "确认上传 2 张" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("opens recent captures in place and pages without leaving the capture flow", () => {
    const onClose = vi.fn();
    render(
      <CaptureHistoryViewer
        tasks={[
          upload("capture-2", "two.jpg"),
          upload("capture-1", "one.jpg")
        ]}
        onClose={onClose}
      />
    );

    const history = within(screen.getByRole("dialog", { name: "最近采集历史" }));
    expect(history.getByText(/1\/2/)).toBeTruthy();
    expect(history.getByText(/two\.jpg/)).toBeTruthy();
    fireEvent.click(history.getByRole("button", { name: "下一张" }));
    expect(history.getByText(/2\/2/)).toBeTruthy();
    expect(history.getByText(/one\.jpg/)).toBeTruthy();
    fireEvent.click(history.getByRole("button", { name: "关闭最近采集" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function photo(name: string): File {
  return new File(["photo"], name, { type: "image/jpeg" });
}

function upload(id: string, fileName: string): UploadTask {
  return {
    id,
    version: 1,
    profileId: "device-1",
    kind: "image",
    fileName,
    mimeType: "image/jpeg",
    byteLength: 5,
    previewBytes: new Blob(["thumb"], { type: "image/jpeg" }),
    notebookId: "notes",
    notebookTitle: "课堂",
    sessionId: "lesson",
    sessionTitle: "第一讲",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    attempts: 0,
    status: "succeeded",
    recognitionStatus: "succeeded"
  };
}

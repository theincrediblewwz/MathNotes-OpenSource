import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PdfImportDialog } from "./PdfImportDialog";

describe("PdfImportDialog", () => {
  const draft = {
    cancelled: false as const,
    sourcePath: "C:/notes/lecture.pdf",
    fileName: "lecture.pdf",
    byteLength: 5 * 1024 * 1024,
    pageCount: 50
  };

  it("defaults to a read-only import in the current Session", () => {
    render(<PdfImportDialog draft={draft} onCancel={() => undefined} onConfirm={() => undefined} />);

    expect(screen.getByText("50 页")).toBeTruthy();
    expect(screen.getByText("仅阅读")).toBeTruthy();
    expect(screen.getByText("原文件将完整保留", { exact: false })).toBeTruthy();
    expect(screen.getByLabelText("PDF 导入设置")).toBeTruthy();
  });

  it("can route a long PDF to a named note record", () => {
    const onConfirm = vi.fn();
    render(<PdfImportDialog draft={draft} onCancel={() => undefined} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText("新建记录"));
    fireEvent.change(screen.getByLabelText("记录名称"), { target: { value: "谱理论讲义" } });
    fireEvent.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "read_only",
        destination: "new_session",
        newSessionTitle: "谱理论讲义",
        pageStart: 1,
        pageEnd: 50
      })
    );
  });

  it("can queue a selected page range with bounded model concurrency", () => {
    const onConfirm = vi.fn();
    render(
      <PdfImportDialog
        draft={draft}
        onCancel={() => undefined}
        onConfirm={onConfirm}
        providerLabel="Mimo v2.5"
      />
    );

    fireEvent.click(screen.getByText("识别选定页"));
    fireEvent.change(screen.getByLabelText("起始页"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("结束页"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("模型并发"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "导入 PDF" }));

    expect(screen.getByText("当前识别服务：Mimo v2.5。遇到限流或超时会自动降速。")).toBeTruthy();
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "recognize_selected", pageStart: 4, pageEnd: 12, concurrency: 3 })
    );
  });
});

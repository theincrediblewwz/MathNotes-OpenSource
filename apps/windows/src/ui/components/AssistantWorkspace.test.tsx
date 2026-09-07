import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { assistantDragMime } from "../assistantDragPayload";
import { AssistantWorkspace, resizeAssistantRect } from "./AssistantWorkspace";

function renderWorkspace(overrides: Partial<ComponentProps<typeof AssistantWorkspace>> = {}) {
  const props: ComponentProps<typeof AssistantWorkspace> = {
    open: true,
    running: false,
    onlineEnabled: true,
    remarks: [],
    liveText: "",
    onClose: vi.fn(),
    onCancel: vi.fn(),
    onDeleteRemark: vi.fn(),
    onPromoteRemark: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides
  };
  render(<AssistantWorkspace {...props} />);
  return props;
}

describe("AssistantWorkspace", () => {
  it("routes explicit whole-note requests and keeps locked suggestions separate from applied changes", () => {
    const props = renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "解读" }));
    fireEvent.click(screen.getByRole("button", { name: "修改全文" }));
    fireEvent.change(screen.getByRole("textbox", { name: "与笔记对话" }), { target: { value: "统一符号" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ operation: "session_edit", question: "统一符号", focus: { kind: "session", label: "当前笔记" } }));
  });

  it("shows a whole-session preview and only applies after a click", () => {
    const onApply = vi.fn();
    renderWorkspace({ sessionRevision: { instruction: "整理全文", status: "idle", proposal: {
      id: "session_1", notebookId: "book", sessionId: "lesson", instruction: "整理全文", summary: "澄清概念", status: "proposed", createdAt: "2026-09-07",
      changes: [{ blockId: "0001", title: "第一块", before: "旧句", markdown: "新句", summary: "统一用词" }],
      lockedSuggestions: [{ blockId: "0002", title: "第二块", suggestion: "原本打算补充前提" }]
    } }, onSessionRevisionApply: onApply });
    expect(screen.getByText("因为以下块已被锁定，未能进行更改")).toBeTruthy();
    expect(screen.getByText("原本打算补充前提")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用全文修改" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });
  it("keeps provider failures visible without exposing provider or context-budget internals", () => {
    renderWorkspace({ error: "400 Param Incorrect" });

    expect(screen.getByRole("alert").textContent).toContain("这次没有完成");
    expect(screen.getByRole("alert").textContent).toContain("400 Param Incorrect");
    expect(screen.queryByText(/实际笔记上下文/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "与笔记对话" })).toBeTruthy();
  });

  it("accepts a copied editor selection as the next assistant focus", () => {
    const onEditSelection = vi.fn();
    const props = renderWorkspace({ onEditSelection });
    const payload = {
      kind: "selection",
      blockId: "0007",
      label: "选区 · block 0007",
      text: "一致有界原理",
      from: 4,
      to: 10
    };
    const dataTransfer = {
      types: [assistantDragMime],
      dropEffect: "none",
      getData: (type: string) => type === assistantDragMime ? JSON.stringify(payload) : payload.text
    } as unknown as DataTransfer;

    fireEvent.drop(screen.getByTestId("assistant-workspace"), { dataTransfer });
    expect(screen.getByTestId("assistant-focus-preview").textContent).toContain("一致有界原理");
    fireEvent.click(screen.getByRole("button", { name: "修改这段文字" }));
    expect(onEditSelection).toHaveBeenCalledWith({
      blockId: "0007",
      from: 4,
      to: 10,
      selectedText: "一致有界原理"
    });
    fireEvent.change(screen.getByRole("textbox", { name: "与笔记对话" }), { target: { value: "为什么？" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(props.onSubmit).toHaveBeenCalledWith({
      mode: "explain",
      question: "为什么？",
      focus: expect.objectContaining({
        kind: "selection",
        blockId: "0007",
        excerpt: "一致有界原理"
      })
    });
  });

  it("shows a conversational before-and-after edit and applies only after confirmation", () => {
    const onSelectionApply = vi.fn();
    const onSelectionReplacementChange = vi.fn();
    renderWorkspace({
      onSelectionApply,
      onSelectionReplacementChange,
      selectionEdit: {
        blockId: "0007",
        from: 2,
        to: 8,
        selectedText: "原始选区 $x$",
        instruction: "写得更清楚，公式不要动",
        replacementMarkdown: "修改候选 $x$",
        proposal: {
          id: "selection_1",
          replacementMarkdown: "修改候选 $x$",
          status: "proposed"
        },
        status: "idle"
      }
    });

    expect(screen.getByText("仅修改未锁定内容")).toBeTruthy();
    expect(screen.getByText("原文")).toBeTruthy();
    expect(screen.getByText("修改后（可编辑）")).toBeTruthy();
    expect(onSelectionApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /编辑/ }));
    fireEvent.change(screen.getByLabelText("修改后的文字"), { target: { value: "用户调整后的候选" } });
    expect(onSelectionReplacementChange).toHaveBeenCalledWith("用户调整后的候选");
    fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
    expect(onSelectionApply).toHaveBeenCalledTimes(1);
  });

  it("shows the submitted user message immediately while the answer is still streaming", () => {
    renderWorkspace({
      running: true,
      pendingQuestion: "请解释第三块",
      liveText: "正在读取"
    });

    expect(screen.getByText("请解释第三块")).toBeTruthy();
    expect(screen.getByText(/正在读取/)).toBeTruthy();
  });

  it("keeps a locked proposal visible and retries the same candidate after user unlock", () => {
    const onSelectionApply = vi.fn();
    const onSelectionRetry = vi.fn();
    const onSelectionUnlock = vi.fn();
    renderWorkspace({
      onSelectionApply,
      onSelectionRetry,
      onSelectionUnlock,
      selectionEdit: {
        blockId: "0007",
        from: 2,
        to: 8,
        selectedText: "原始选区",
        instruction: "写得更清楚",
        replacementMarkdown: "修改候选",
        proposal: {
          id: "selection_1",
          replacementMarkdown: "修改候选",
          status: "proposed"
        },
        status: "idle",
        error: "这段内容已经被固定。修改候选已保留。",
        requiresUnlock: true
      }
    });

    expect(screen.getByText("修改后（可编辑）")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去解锁" }));
    expect(onSelectionUnlock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onSelectionApply).toHaveBeenCalledTimes(1);
    expect(onSelectionRetry).not.toHaveBeenCalled();
  });

  it("does not auto-write assistant answers into the note", () => {
    const onPromoteRemark = vi.fn();
    const onOpenRelatedSource = vi.fn();
    renderWorkspace({
      onPromoteRemark,
      onOpenRelatedSource,
      remarks: [{
        id: "remark_1",
        mode: "teach",
        focus: { kind: "session", label: "当前笔记" },
        question: "解释这个结论",
        markdown: "## 回答",
        providerName: "Mimo v2.5",
        sourceBlockIds: ["0001"],
        relatedSources: [{
          refId: "R1",
          notebookId: "analysis",
          notebookTitle: "泛函分析",
          sessionId: "principle",
          sessionTitle: "一致有界原理",
          blockId: "0007",
          locked: true
        }],
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z"
      }]
    });

    expect(screen.getByText("解释这个结论")).toBeTruthy();
    expect(onPromoteRemark).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Notebook：泛函分析 · Session：一致有界原理" }));
    expect(onOpenRelatedSource).toHaveBeenCalledWith(expect.objectContaining({ refId: "R1", blockId: "0007" }));
    fireEvent.click(screen.getByRole("button", { name: "写入笔记" }));
    expect(onPromoteRemark).toHaveBeenCalledWith("remark_1");
  });

  it("opens a stored answer in focused reading without changing the note", () => {
    const onSelectedRemarkChange = vi.fn();
    renderWorkspace({
      onSelectedRemarkChange,
      selectedRemarkId: "remark_1",
      remarks: [{
        id: "remark_1",
        mode: "explain",
        focus: { kind: "block", blockId: "0007", label: "当前选区" },
        markdown: "## 一致有界原理\n\n这是独立回答。",
        providerName: "Mimo v2.5",
        sourceBlockIds: ["0007"],
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z"
      }]
    });

    expect(screen.getByText("这是独立回答。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
    expect(onSelectedRemarkChange).toHaveBeenCalledWith(null);
  });

  it("applies answer typography and exposes edge and corner resize handles", () => {
    renderWorkspace({ answerFontFamily: "Microsoft YaHei UI", answerFontSize: 20 });
    const workspace = screen.getByTestId("assistant-workspace");
    expect(workspace.style.getPropertyValue("--assistant-answer-font-family")).toBe("Microsoft YaHei UI");
    expect(workspace.style.getPropertyValue("--assistant-answer-font-size")).toBe("20px");
    expect(screen.getByTestId("assistant-resize-n")).toBeTruthy();
    expect(screen.getByTestId("assistant-resize-e")).toBeTruthy();
    expect(screen.getByTestId("assistant-resize-se")).toBeTruthy();
  });

  it("uses native window controls and leaves resizing to the detached OS window", () => {
    const onMinimizeWindow = vi.fn();
    const onToggleMaximizeWindow = vi.fn(() => true);
    renderWorkspace({ detached: true, onMinimizeWindow, onToggleMaximizeWindow });

    const workspace = screen.getByTestId("assistant-workspace");
    expect(workspace.classList.contains("detached")).toBe(true);
    expect(workspace.style.left).toBe("");
    expect(screen.queryByTestId("assistant-resize-n")).toBeNull();
    expect(screen.queryByTestId("assistant-resize-se")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "最小化对话窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "展开对话窗口" }));
    expect(onMinimizeWindow).toHaveBeenCalledTimes(1);
    expect(onToggleMaximizeWindow).toHaveBeenCalledTimes(1);
  });
});

describe("resizeAssistantRect", () => {
  const start = { left: 300, top: 100, width: 500, height: 600 };
  const viewport = { viewportWidth: 1400, viewportHeight: 1000 };

  it("anchors the opposite horizontal edge", () => {
    const west = resizeAssistantRect({ start, direction: "w", deltaX: 100, deltaY: 0, ...viewport });
    expect(west.left + west.width).toBe(800);
    expect(west).toEqual({ left: 380, top: 100, width: 420, height: 600 });

    const east = resizeAssistantRect({ start, direction: "e", deltaX: 100, deltaY: 0, ...viewport });
    expect(east.left).toBe(300);
    expect(east.width).toBe(600);
  });

  it("anchors the opposite vertical edge and handles corners independently", () => {
    const north = resizeAssistantRect({ start, direction: "n", deltaX: 0, deltaY: 80, ...viewport });
    expect(north.top + north.height).toBe(700);
    expect(north).toEqual({ left: 300, top: 180, width: 500, height: 520 });

    const southEast = resizeAssistantRect({ start, direction: "se", deltaX: 120, deltaY: 100, ...viewport });
    expect(southEast).toEqual({ left: 300, top: 100, width: 620, height: 700 });
  });
});

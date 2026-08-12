import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { assistantDragMime } from "../assistantDragPayload";
import { AssistantWorkspace } from "./AssistantWorkspace";

function renderWorkspace(overrides: Partial<ComponentProps<typeof AssistantWorkspace>> = {}) {
  const props: ComponentProps<typeof AssistantWorkspace> = {
    open: true,
    running: false,
    onlineEnabled: true,
    providerLabel: "Mimo v2.5",
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
  it("keeps provider failures visible inside the non-modal workspace", () => {
    renderWorkspace({ error: "400 Param Incorrect" });

    expect(screen.getByRole("alert").textContent).toContain("本次调用没有完成");
    expect(screen.getByRole("alert").textContent).toContain("400 Param Incorrect");
  });

  it("accepts a copied editor selection as the next assistant focus", () => {
    const props = renderWorkspace();
    const payload = {
      kind: "selection",
      blockId: "0007",
      label: "选区 · block 0007",
      text: "一致有界原理"
    };
    const dataTransfer = {
      types: [assistantDragMime],
      dropEffect: "none",
      getData: (type: string) => type === assistantDragMime ? JSON.stringify(payload) : payload.text
    } as unknown as DataTransfer;

    fireEvent.drop(screen.getByTestId("assistant-workspace"), { dataTransfer });
    expect(screen.getByTestId("assistant-focus-preview").textContent).toContain("一致有界原理");
    expect(screen.getByTestId("assistant-context-budget").textContent).toContain("实际笔记上下文");
    fireEvent.change(screen.getByLabelText("向 AI 学习助手提问"), { target: { value: "为什么？" } });
    fireEvent.click(screen.getByTitle("发送"));

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

  it("does not auto-promote remarks into the note", () => {
    const onPromoteRemark = vi.fn();
    renderWorkspace({
      onPromoteRemark,
      remarks: [{
        id: "remark_1",
        mode: "teach",
        focus: { kind: "session", label: "当前 Session" },
        markdown: "## 旁注",
        providerName: "Mimo v2.5",
        sourceBlockIds: ["0001"],
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z"
      }]
    });

    expect(screen.getByText("旁注")).toBeTruthy();
    expect(onPromoteRemark).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "转为笔记块" }));
    expect(onPromoteRemark).toHaveBeenCalledWith("remark_1");
  });

  it("opens a stored remark in the dedicated reader without changing the note", () => {
    const onSelectedRemarkChange = vi.fn();
    renderWorkspace({
      onSelectedRemarkChange,
      selectedRemarkId: "remark_1",
      remarks: [{
        id: "remark_1",
        mode: "explain",
        focus: { kind: "block", blockId: "0007", label: "block 0007" },
        markdown: "## 一致有界原理\n\n这是独立旁注。",
        providerName: "Mimo v2.5",
        sourceBlockIds: ["0007"],
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z"
      }]
    });

    expect(screen.getByLabelText("AI 旁注阅读器").textContent).toContain("这是独立旁注");
    fireEvent.click(screen.getByRole("button", { name: "返回旁注列表" }));
    expect(onSelectedRemarkChange).toHaveBeenCalledWith(null);
  });

  it("shows the exact shared context budget and prioritizes question-named block ordinals", () => {
    renderWorkspace({
      contextBlocks: Array.from({ length: 42 }, (_, index) => ({
        id: String(index + 1).padStart(4, "0"),
        source: "user",
        markdown: index === 41 ? "一致有界原理的精确内容" : `普通块 ${index + 1}`
      }))
    });

    fireEvent.change(screen.getByLabelText("向 AI 学习助手提问"), {
      target: { value: "第 42 块是什么？" }
    });
    const budget = screen.getByTestId("assistant-context-budget");
    expect(budget.textContent).toContain("当前 42 块");
    expect(budget.textContent).toContain("104,000 字符");
    expect(budget.textContent).toContain("图片最多 8 张");
    expect(budget.textContent).toContain("已优先包含第 42 块");
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
});

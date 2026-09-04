import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NotebookSessionSummary, NotebookSummary } from "../../types/mathNotesApi";
import { NotebookBrowserDialog, positionSessionPreview } from "./NotebookBrowserDialog";

const notebooks: NotebookSummary[] = [
  { notebookId: "analysis", title: "泛函分析", sessionCount: 2, createdAt: "", updatedAt: "2026-08-30T00:00:00.000Z" },
  { notebookId: "papers", title: "论文阅读", sessionCount: 1, createdAt: "", updatedAt: "2026-08-29T00:00:00.000Z" }
];

const sessions: Record<string, NotebookSessionSummary[]> = {
  analysis: [
    session("analysis", "lecture-1", "有界线性算子"),
    session("analysis", "lecture-2", "谱理论初步")
  ],
  papers: [session("papers", "paper-1", "紧算子论文札记")]
};

describe("NotebookBrowserDialog", () => {
  it("loads every notebook in parallel, searches sessions and opens only after an explicit action", async () => {
    const loadNotebookSessions = vi.fn(async (notebookId: string) => sessions[notebookId] ?? []);
    const onOpenSession = vi.fn();
    render(
      <NotebookBrowserDialog
        currentNotebookId="analysis"
        currentSessionId="lecture-1"
        loadNotebookSessions={loadNotebookSessions}
        loadSessionPreview={async (input) => ({
          version: 1,
          ...input,
          title: "预览",
          updatedAt: "2026-08-30T00:00:00.000Z",
          html: "<p>渲染预览</p>",
          truncated: false
        })}
        notebooks={notebooks}
        onClose={() => undefined}
        onOpenSession={onOpenSession}
        open
      />
    );

    await waitFor(() => expect(loadNotebookSessions).toHaveBeenCalledTimes(2));
    expect(loadNotebookSessions.mock.calls.map(([notebookId]) => notebookId).sort()).toEqual(["analysis", "papers"]);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();

    fireEvent.change(screen.getByLabelText("搜索 Notebooks 与 Sessions"), { target: { value: "紧算子" } });
    fireEvent.click(screen.getByRole("button", { name: /^论文阅读/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^紧算子论文札记/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "paper-1" }));
  });

  it("shows a host-rendered preview on keyboard focus and supports the real view toggle", async () => {
    render(
      <NotebookBrowserDialog
        currentNotebookId="analysis"
        currentSessionId="lecture-1"
        loadNotebookSessions={async (notebookId) => sessions[notebookId] ?? []}
        loadSessionPreview={async (input) => ({
          version: 1,
          ...input,
          title: "有界线性算子",
          updatedAt: "2026-08-30T00:00:00.000Z",
          html: "<h2>有界线性算子</h2><p>渲染预览</p>",
          truncated: false
        })}
        notebooks={notebooks}
        onClose={() => undefined}
        onOpenSession={() => undefined}
        open
      />
    );

    const row = await screen.findByRole("button", { name: /^有界线性算子/ });
    fireEvent.focus(row);
    expect((await screen.findByRole("tooltip")).textContent).toContain("渲染预览");
    fireEvent.click(screen.getByTitle("网格"));
    expect(document.querySelector(".notebook-session-list")?.className).toContain("grid");
  });

  it("keeps the preview inside the viewport and flips across the pointer near an edge", () => {
    expect(positionSessionPreview({
      pointerX: 980,
      pointerY: 730,
      viewportWidth: 1024,
      viewportHeight: 768,
      previewWidth: 320,
      previewHeight: 240
    })).toEqual({ x: 642, y: 472 });
    expect(positionSessionPreview({
      pointerX: 20,
      pointerY: 20,
      viewportWidth: 1024,
      viewportHeight: 768,
      previewWidth: 320,
      previewHeight: 240
    })).toEqual({ x: 38, y: 38 });
  });
});

function session(notebookId: string, sessionId: string, title: string): NotebookSessionSummary {
  return {
    notebookId,
    sessionId,
    title,
    status: "draft",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
  };
}

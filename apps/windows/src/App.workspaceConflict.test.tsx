import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { createSessionDocument } from "./common/sessionDocument";
import type { MathNotesApi } from "./types/mathNotesApi";
import { App } from "./App";

// Keep the App's real save/refresh lifecycle; editor DOM mechanics have their own suite.
vi.mock("./ui/components/SessionSourceEditor", () => ({
  SessionSourceEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    <textarea aria-label="合成源码编辑器" value={value} onChange={event => onChange(event.target.value)} />
}));

afterEach(() => { cleanup(); delete window.mathNotes; vi.restoreAllMocks(); });

describe("Windows workspace conflict lifecycle", () => {
  function fixture() {
    const session = createSessionRecord({ id: "lesson", title: "合成笔记", createdAt: "2026-09-08T00:00:00Z" });
    session.blocks = [createBlockRef({ id: "0001", type: "markdown", path: "blocks/1.md", source: "user", createdAt: session.createdAt })];
    const make = (text: string, baseline: string) => ({ ...createSessionDocument({ notebookId: "book", session, markdownByPath: { "blocks/1.md": text } }), revisionBaseline: baseline });
    let host = make("A 原文", "a");
    let deleted = false;
    let notify: (event: { notebookId: string; sessionId?: string; catalogChanged?: boolean }) => void = () => {};
    const load = vi.fn(async () => { if (deleted) throw new Error("ENOENT session.json"); return host; });
    const save = vi.fn(async (input: { sourceText: string; revisionBaseline: string }) => {
      if (input.revisionBaseline !== host.revisionBaseline) throw new Error("revision_conflict");
      host = { ...host, revisionBaseline: "saved", sourceDocument: { ...host.sourceDocument, text: input.sourceText } };
      return host;
    });
    const specific: Record<string, unknown> = {
      loadCurrentSession: load, saveSessionSource: save,
      onWorkspaceChanged: (callback: typeof notify) => { notify = callback; return () => {}; },
      loadProviderConfig: async () => null, loadAssistantProviderConfig: async () => null,
      loadPromptTemplateConfig: async () => null, loadNotationProfileConfig: async () => null,
      loadUserSettings: async () => null, loadIngestServerState: async () => ({ running: false }),
      loadConnectionDiagnostics: async () => null,
      loadCodexRuntimeState: async () => ({ status: "stopped", progress: 0 }),
      exportCurrentSession: async () => ({ outPath: "synthetic.md", exportedBlocks: 1 })
    };
    window.mathNotes = new Proxy(specific, { get(target, key: string) {
      return target[key] ?? (key.startsWith("on") ? () => () => {} : async () => []);
    } }) as unknown as MathNotesApi;
    return { load, save, update() { host = make("B 主机新版", "b"); notify({ notebookId: "book", sessionId: "lesson" }); },
      trash() { deleted = true; notify({ notebookId: "book", catalogChanged: true }); },
      restore() { deleted = false; host = make("恢复后的主机版本", "restored"); notify({ notebookId: "book", catalogChanged: true }); }
    };
  }
  it("keeps a draft through notebook trash and restore and cannot save into the deleted path", async () => {
    const f = fixture(); render(<App />);
    const editor = await screen.findByRole("textbox", { name: "合成源码编辑器" });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("A 原文"));
    fireEvent.change(editor, { target: { value: "保留这份草稿" } });
    await act(async () => { f.trash(); });
    await waitFor(() => expect(screen.getByTestId("workspace-conflict").textContent).toContain("废纸篓"));
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(f.save).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("保留这份草稿");
    await act(async () => { f.restore(); });
    await screen.findByRole("button", { name: "查看主机版本" });
    expect((editor as HTMLTextAreaElement).value).toBe("保留这份草稿");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "重新载入并替换草稿" }));
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("恢复后的主机版本"));
  });
  it("refreshes an unedited open document when the host publishes a change", async () => {
    const f = fixture(); render(<App />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "合成源码编辑器" }) as HTMLTextAreaElement).value).toContain("A 原文"));
    await act(async () => { f.update(); });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "合成源码编辑器" }) as HTMLTextAreaElement).value).toContain("B 主机新版"));
    expect(screen.queryByTestId("workspace-conflict")).toBeNull();
  });
  it("carries the new save response baseline into subsequent shortcut saves", async () => {
    const f = fixture(); render(<App />);
    const editor = await screen.findByRole("textbox", { name: "合成源码编辑器" });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("A 原文"));
    fireEvent.change(editor, { target: { value: "first draft" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(f.save).toHaveBeenNthCalledWith(1, expect.objectContaining({ revisionBaseline: "a" })));
    await waitFor(() => expect(screen.queryByText("正在保存")).toBeNull());
    fireEvent.change(editor, { target: { value: "second draft" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(f.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ revisionBaseline: "saved", sourceText: "second draft" })));
    expect(screen.queryByTestId("workspace-conflict")).toBeNull();
  });
  it("keeps the Windows draft on a remote change and failed save, shows B read-only, and requires explicit reload", async () => {
    const f = fixture(); render(<App />);
    const editor = await screen.findByRole("textbox", { name: "合成源码编辑器" });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("A 原文"));
    fireEvent.change(editor, { target: { value: "Windows A 草稿" } });
    await act(async () => { f.update(); });
    expect(screen.getByTestId("workspace-conflict")).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("Windows A 草稿");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ revisionBaseline: "a", sourceText: "Windows A 草稿" })));
    fireEvent.click(screen.getByRole("button", { name: "查看主机版本" }));
    await screen.findByRole("dialog", { name: "当前主机版本" });
    expect((editor as HTMLTextAreaElement).value).toBe("Windows A 草稿");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "重新载入并替换草稿" }));
    expect(confirm).toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("Windows A 草稿");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "重新载入并替换草稿" }));
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain("B 主机新版"));
  });
});

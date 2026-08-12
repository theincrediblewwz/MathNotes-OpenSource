import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSourceDocument } from "../../common/sessionSourceDocument";
import {
  buildPerformanceLabVirtualLayout,
  expandPerformanceLabVirtualRange,
  findPerformanceLabVirtualRange,
  groupAssistantRemarksByBlockId,
  findEditorCaretTargetAtPoint,
  SessionSourceEditor,
  shouldApplyExternalMarkdown
} from "./SessionSourceEditor";

describe("SessionSourceEditor", () => {
  beforeEach(() => {
    window.localStorage.setItem("mathnotes:editor-windowing-lab", "off");
  });

  afterEach(() => {
    window.localStorage.removeItem("mathnotes:editor-windowing-lab");
  });

  it("calculates a bounded virtual block range from estimated dynamic heights", () => {
    const layout = buildPerformanceLabVirtualLayout([
      "one",
      "two\nlines",
      "three\nlines\nhere",
      "last"
    ]);

    const range = findPerformanceLabVirtualRange({
      layout,
      scrollTop: layout.offsets[2],
      viewportHeight: 80,
      overscanPx: 0,
      itemCount: 4
    });

    expect(range.start).toBe(2);
    expect(range.end).toBe(3);
    expect(layout.totalSize).toBeGreaterThan(layout.offsets[3]);
  });

  it("keeps a wider segmented shell around the precise virtual range", () => {
    expect(expandPerformanceLabVirtualRange({ start: 25, end: 31 }, 120, 12)).toEqual({
      start: 12,
      end: 48
    });
    expect(expandPerformanceLabVirtualRange({ start: 0, end: 4 }, 8, 12)).toEqual({
      start: 0,
      end: 8
    });
  });

  it("maps a top-edge click to the editor beneath the drag layer", () => {
    const insideView = {
      dom: { getBoundingClientRect: () => ({ left: 40, right: 400, top: 0, bottom: 120 }) },
      posAtCoords: vi.fn(() => 17)
    } as unknown as import("@codemirror/view").EditorView;
    const outsideView = {
      dom: { getBoundingClientRect: () => ({ left: 40, right: 400, top: 140, bottom: 260 }) },
      posAtCoords: vi.fn(() => 9)
    } as unknown as import("@codemirror/view").EditorView;

    expect(findEditorCaretTargetAtPoint(new Map([["0001", insideView], ["0002", outsideView]]), { clientX: 220, clientY: 24 })).toEqual({
      blockId: "0001",
      view: insideView,
      position: 17
    });
    expect(outsideView.posAtCoords).not.toHaveBeenCalled();
  });

  it("rejects a stale controlled echo while the user is actively typing", () => {
    expect(shouldApplyExternalMarkdown({
      currentMarkdown: "实时预览测试",
      externalMarkdown: "实时预览测",
      hasFocus: true,
      lastLocalEditAt: 100,
      now: 120
    })).toBe(false);
    expect(shouldApplyExternalMarkdown({
      currentMarkdown: "实时预览测试",
      externalMarkdown: "识别流新内容",
      hasFocus: false,
      lastLocalEditAt: 100,
      now: 120
    })).toBe(true);
  });

  it("counts only block-owned remarks in a block badge", () => {
    const blockRemark = {
      id: "remark-block",
      mode: "explain" as const,
      focus: { kind: "block" as const, blockId: "0001", label: "block 0001" },
      markdown: "块旁注",
      providerName: "mock",
      sourceBlockIds: ["0001"],
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    };
    const sessionRemark = {
      ...blockRemark,
      id: "remark-session",
      focus: { kind: "session" as const, label: "整个 Session" },
      markdown: "全局旁注"
    };
    const selectionRemark = {
      ...blockRemark,
      id: "remark-selection",
      focus: { kind: "selection" as const, blockId: "0001", label: "选区" },
      markdown: "选区旁注"
    };

    const grouped = groupAssistantRemarksByBlockId([blockRemark, sessionRemark, selectionRemark]);

    expect(grouped.get("0001")?.map((remark) => remark.id)).toEqual(["remark-block", "remark-selection"]);
  });

  it("highlights the concrete line targeted by preview locating", async () => {
    if (!HTMLElement.prototype.scrollTo) {
      HTMLElement.prototype.scrollTo = vi.fn();
    }
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect;

    const document: SessionSourceDocument = {
      text: [
        "--- source: user | block: 0001 ---",
        "第一行",
        "第二行",
        "第三行"
      ].join("\n"),
      markdownBlocks: [
        {
          blockId: "0001",
          sourceId: "src-0001",
          path: "blocks/0001_user_note.md",
          source: "user",
          header: "user",
          locked: false
        }
      ]
    };

    const { container } = render(
      <SessionSourceEditor
        document={document}
        insertMarkdownRequest={null}
        locatingRequest={{
          blockId: "0001",
          sourceId: "src-0001",
          lineInBlock: 2,
          lineCount: 3,
          nonce: 1
        }}
        lockSelectionRequest={0}
        unlockProtectedSpanRequest={0}
        value={document.text}
        onActiveBlockChange={vi.fn()}
        onChange={vi.fn()}
        onDeleteBlockRequest={vi.fn()}
        onProtectedSpanUnlockableChange={vi.fn()}
        onProtectedSpanUnlocked={vi.fn()}
        onSelectionLockableChange={vi.fn()}
        onSelectionLocked={vi.fn()}
        onSourceReferenceClick={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".cm-previewLocatedLine")?.textContent).toContain("第二行");
    });
  });

  it("opens the product context menu from editable Markdown", async () => {
    const onRerecognizeBlockRequest = vi.fn();
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const document: SessionSourceDocument = {
      text: ["--- source: user | block: 0001 ---", "# 标题", "正文"].join("\n"),
      markdownBlocks: [{
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_user_note.md",
        source: "user",
        header: "user",
        locked: false
      }]
    };
    const { container } = render(
      <SessionSourceEditor
        document={document}
        insertMarkdownRequest={null}
        locatingRequest={null}
        lockSelectionRequest={0}
        unlockProtectedSpanRequest={0}
        value={document.text}
        onActiveBlockChange={vi.fn()}
        onChange={vi.fn()}
        onDeleteBlockRequest={vi.fn()}
        onProtectedSpanUnlockableChange={vi.fn()}
        onProtectedSpanUnlocked={vi.fn()}
        onRerecognizeBlockRequest={onRerecognizeBlockRequest}
        onSelectionLockableChange={vi.fn()}
        onSelectionLocked={vi.fn()}
        onSourceReferenceClick={vi.fn()}
      />
    );

    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    const content = container.querySelector(".cm-content") as HTMLElement;
    fireEvent.contextMenu(content, { clientX: 120, clientY: 140 });

    expect(screen.getByTestId("editor-context-menu")).toBeTruthy();
    expect(screen.getByRole("button", { name: /复制/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /粘贴/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新识别这个块" }));
    expect(onRerecognizeBlockRequest).toHaveBeenCalledWith("0001");
    expect(screen.queryByTestId("editor-context-menu")).toBeNull();
  });

  it("sends the exact UTF-16 selection to the AI edit callback from the editor context menu", async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const onAiSelectionEditRequest = vi.fn();
    const document: SessionSourceDocument = {
      text: ["--- source: user | block: 0001 ---", "a😀bc"].join("\n"),
      markdownBlocks: [{
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_user_note.md",
        source: "user",
        header: "user",
        locked: false
      }]
    };
    const { container } = render(
      <SessionSourceEditor
        document={document}
        insertMarkdownRequest={null}
        locatingRequest={null}
        lockSelectionRequest={0}
        unlockProtectedSpanRequest={0}
        value={document.text}
        onActiveBlockChange={vi.fn()}
        onChange={vi.fn()}
        onAiSelectionEditRequest={onAiSelectionEditRequest}
        onDeleteBlockRequest={vi.fn()}
        onProtectedSpanUnlockableChange={vi.fn()}
        onProtectedSpanUnlocked={vi.fn()}
        onSelectionLockableChange={vi.fn()}
        onSelectionLocked={vi.fn()}
        onSourceReferenceClick={vi.fn()}
      />
    );

    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    const content = container.querySelector(".cm-content") as HTMLElement;
    const view = EditorView.findFromDOM(content);
    expect(view).toBeTruthy();
    view!.dispatch({ selection: { anchor: 1, head: 5 } });

    fireEvent.contextMenu(content, { clientX: 120, clientY: 140 });
    fireEvent.click(screen.getByRole("button", { name: "用 AI 修改选中文字" }));

    expect(onAiSelectionEditRequest).toHaveBeenCalledTimes(1);
    expect(onAiSelectionEditRequest).toHaveBeenCalledWith({
      blockId: "0001",
      from: 1,
      to: 5,
      selectedText: "😀bc"
    });
    expect(screen.queryByTestId("editor-context-menu")).toBeNull();
  });

  it("disables the AI edit entry for an empty selection or a locked block", async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const unlocked: SessionSourceDocument = {
      text: ["--- source: user | block: 0001 ---", "a😀bc"].join("\n"),
      markdownBlocks: [{
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_user_note.md",
        source: "user",
        header: "user",
        locked: false
      }]
    };
    const sharedProps = {
      insertMarkdownRequest: null,
      locatingRequest: null,
      lockSelectionRequest: 0,
      unlockProtectedSpanRequest: 0,
      onActiveBlockChange: vi.fn(),
      onChange: vi.fn(),
      onDeleteBlockRequest: vi.fn(),
      onProtectedSpanUnlockableChange: vi.fn(),
      onProtectedSpanUnlocked: vi.fn(),
      onSelectionLockableChange: vi.fn(),
      onSelectionLocked: vi.fn(),
      onSourceReferenceClick: vi.fn()
    };
    const { container, rerender } = render(
      <SessionSourceEditor {...sharedProps} document={unlocked} value={unlocked.text} />
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    const content = container.querySelector(".cm-content") as HTMLElement;

    fireEvent.contextMenu(content, { clientX: 120, clientY: 140 });
    expect((screen.getByRole("button", { name: "用 AI 修改选中文字" }) as HTMLButtonElement).disabled).toBe(true);

    const locked: SessionSourceDocument = {
      ...unlocked,
      markdownBlocks: unlocked.markdownBlocks.map((block) => ({ ...block, locked: true }))
    };
    rerender(<SessionSourceEditor {...sharedProps} document={locked} value={locked.text} />);
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    const lockedContent = container.querySelector(".cm-content") as HTMLElement;
    const lockedView = EditorView.findFromDOM(lockedContent);
    expect(lockedView).toBeTruthy();
    lockedView!.dispatch({ selection: { anchor: 1, head: 5 } });

    fireEvent.contextMenu(lockedContent, { clientX: 120, clientY: 140 });
    expect((screen.getByRole("button", { name: "用 AI 修改选中文字" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("inserts after the right-clicked block and forwards its blockId", async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const onCreateBlockAfterRequest = vi.fn();
    const document: SessionSourceDocument = {
      text: [
        "--- source: first | block: 0001 ---",
        "第一块",
        "--- source: second | block: 0002 ---",
        "第二块"
      ].join("\n"),
      markdownBlocks: [
        { blockId: "0001", sourceId: "src-0001", path: "blocks/0001.md", source: "user", header: "first", locked: false },
        { blockId: "0002", sourceId: "src-0002", path: "blocks/0002.md", source: "user", header: "second", locked: false }
      ]
    };
    const { container } = render(
      <SessionSourceEditor
        document={document}
        insertMarkdownRequest={null}
        locatingRequest={null}
        lockSelectionRequest={0}
        unlockProtectedSpanRequest={0}
        value={document.text}
        onActiveBlockChange={vi.fn()}
        onChange={vi.fn()}
        onCreateBlockAfterRequest={onCreateBlockAfterRequest}
        onDeleteBlockRequest={vi.fn()}
        onProtectedSpanUnlockableChange={vi.fn()}
        onProtectedSpanUnlocked={vi.fn()}
        onSelectionLockableChange={vi.fn()}
        onSelectionLocked={vi.fn()}
        onSourceReferenceClick={vi.fn()}
      />
    );

    await waitFor(() => expect(container.querySelectorAll(".cm-content").length).toBe(2));
    const secondContent = container.querySelectorAll(".cm-content")[1] as HTMLElement;
    fireEvent.contextMenu(secondContent, { clientX: 120, clientY: 140 });

    fireEvent.click(screen.getByRole("button", { name: "在下方新建文本块" }));
    expect(onCreateBlockAfterRequest).toHaveBeenCalledTimes(1);
    expect(onCreateBlockAfterRequest).toHaveBeenCalledWith("0002");
    expect(screen.queryByTestId("editor-context-menu")).toBeNull();
  });

  it("supports multi-select reorder and cross-session transfer requests", async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const document: SessionSourceDocument = {
      text: [
        "--- source: first | block: 0001 ---",
        "第一块",
        "--- source: second | block: 0002 ---",
        "第二块"
      ].join("\n"),
      markdownBlocks: [
        { blockId: "0001", sourceId: "src-0001", path: "blocks/0001.md", source: "user", header: "first", locked: false },
        { blockId: "0002", sourceId: "src-0002", path: "blocks/0002.md", source: "user", header: "second", locked: false }
      ]
    };
    const onReorder = vi.fn();
    const onTransfer = vi.fn();
    const { container } = render(
      <SessionSourceEditor
        document={document}
        insertMarkdownRequest={null}
        locatingRequest={null}
        lockSelectionRequest={0}
        unlockProtectedSpanRequest={0}
        value={document.text}
        onActiveBlockChange={vi.fn()}
        onChange={vi.fn()}
        onDeleteBlockRequest={vi.fn()}
        onProtectedSpanUnlockableChange={vi.fn()}
        onProtectedSpanUnlocked={vi.fn()}
        onReorderBlocksRequest={onReorder}
        onSelectionLockableChange={vi.fn()}
        onSelectionLocked={vi.fn()}
        onSourceReferenceClick={vi.fn()}
        onTransferBlocksRequest={onTransfer}
      />
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    const headers = container.querySelectorAll("[data-testid='source-block-header']");
    fireEvent.contextMenu(headers[0]!, { clientX: 120, clientY: 80 });
    fireEvent.click(screen.getByRole("button", { name: "多选块" }));
    expect(screen.getByRole("checkbox", { name: "取消选择 block 0001" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 block 0002" }));
    expect(screen.getByTestId("source-block-organize-toolbar").textContent).toContain("已选 2 块");
    fireEvent.click(screen.getByRole("button", { name: "上移" }));
    fireEvent.click(screen.getByRole("button", { name: "移动到…" }));
    expect(onReorder).toHaveBeenCalledWith(["0001", "0002"], "up");
    expect(onTransfer).toHaveBeenCalledWith(["0001", "0002"], "move");
    fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("offers block actions from the block title context menu", () => {
    const onRerecognizeBlockRequest = vi.fn();
    const document: SessionSourceDocument = {
      text: ["--- source: photo.jpg | block: 0001 ---", "识别正文"].join("\n"),
      markdownBlocks: [{
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001.md",
        source: "ai_transcription",
        header: "photo.jpg",
        locked: false
      }]
    };
    const { container } = render(
      <SessionSourceEditor
        document={document}
        insertMarkdownRequest={null}
        locatingRequest={null}
        lockSelectionRequest={0}
        unlockProtectedSpanRequest={0}
        value={document.text}
        onActiveBlockChange={vi.fn()}
        onChange={vi.fn()}
        onDeleteBlockRequest={vi.fn()}
        onProtectedSpanUnlockableChange={vi.fn()}
        onProtectedSpanUnlocked={vi.fn()}
        onRerecognizeBlockRequest={onRerecognizeBlockRequest}
        onSelectionLockableChange={vi.fn()}
        onSelectionLocked={vi.fn()}
        onSourceReferenceClick={vi.fn()}
      />
    );

    fireEvent.contextMenu(container.querySelector("[data-testid='source-block-header']")!, {
      clientX: 120,
      clientY: 80
    });
    expect(screen.getByRole("button", { name: "多选块" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新识别这个块" }));
    expect(onRerecognizeBlockRequest).toHaveBeenCalledWith("0001");
  });

  it("does not report streamed disk updates as user edits", async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const onChange = vi.fn();
    const document: SessionSourceDocument = {
      text: ["--- source: image.png | block: 0001 ---", "正在识别"].join("\n"),
      markdownBlocks: [{
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_ai_transcript.md",
        source: "ai_transcription",
        header: "image.png",
        locked: false
      }]
    };
    const props = {
      document,
      insertMarkdownRequest: null,
      locatingRequest: null,
      lockSelectionRequest: 0,
      unlockProtectedSpanRequest: 0,
      onActiveBlockChange: vi.fn(),
      onChange,
      onDeleteBlockRequest: vi.fn(),
      onProtectedSpanUnlockableChange: vi.fn(),
      onProtectedSpanUnlocked: vi.fn(),
      onSelectionLockableChange: vi.fn(),
      onSelectionLocked: vi.fn(),
      onSourceReferenceClick: vi.fn()
    };
    const { container, rerender } = render(
      <SessionSourceEditor {...props} value={document.text} />
    );
    await waitFor(() => expect(container.querySelector(".cm-content")?.textContent).toContain("正在识别"));

    const streamedText = ["--- source: image.png | block: 0001 ---", "正在识别数学公式"].join("\n");
    rerender(<SessionSourceEditor {...props} value={streamedText} />);

    await waitFor(() => expect(container.querySelector(".cm-content")?.textContent).toContain("正在识别数学公式"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an applied external AI replacement in native editor undo history", async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const document: SessionSourceDocument = {
      text: ["--- source: user | block: 0001 ---", "原始选区"].join("\n"),
      markdownBlocks: [{
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001.md",
        source: "user",
        header: "user",
        locked: false
      }]
    };
    const props = {
      document,
      insertMarkdownRequest: null,
      locatingRequest: null,
      lockSelectionRequest: 0,
      unlockProtectedSpanRequest: 0,
      onActiveBlockChange: vi.fn(),
      onChange: vi.fn(),
      onDeleteBlockRequest: vi.fn(),
      onProtectedSpanUnlockableChange: vi.fn(),
      onProtectedSpanUnlocked: vi.fn(),
      onSelectionLockableChange: vi.fn(),
      onSelectionLocked: vi.fn(),
      onSourceReferenceClick: vi.fn()
    };
    const { container, rerender } = render(<SessionSourceEditor {...props} value={document.text} />);
    await waitFor(() => expect(container.querySelector(".cm-content")?.textContent).toContain("原始选区"));

    const appliedText = ["--- source: user | block: 0001 ---", "修改候选"].join("\n");
    rerender(<SessionSourceEditor {...props} value={appliedText} />);
    await waitFor(() => expect(container.querySelector(".cm-content")?.textContent).toContain("修改候选"));

    const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement);
    expect(view).toBeTruthy();
    expect(undo(view!)).toBe(true);
    expect(view!.state.doc.toString()).toBe("原始选区");
  });

  it("reports the latest block metadata without rebuilding the editor", async () => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const onActiveBlockChange = vi.fn();
    const unlocked: SessionSourceDocument = {
      text: ["--- source: image.png | block: 0001 ---", "正文"].join("\n"),
      markdownBlocks: [{
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_ai_transcript.md",
        source: "ai_transcription",
        header: "image.png",
        locked: false
      }]
    };
    const sharedProps = {
      insertMarkdownRequest: null,
      locatingRequest: null,
      lockSelectionRequest: 0,
      unlockProtectedSpanRequest: 0,
      onActiveBlockChange,
      onChange: vi.fn(),
      onDeleteBlockRequest: vi.fn(),
      onProtectedSpanUnlockableChange: vi.fn(),
      onProtectedSpanUnlocked: vi.fn(),
      onSelectionLockableChange: vi.fn(),
      onSelectionLocked: vi.fn(),
      onSourceReferenceClick: vi.fn()
    };
    const { container, rerender } = render(
      <SessionSourceEditor {...sharedProps} document={unlocked} value={unlocked.text} />
    );
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    const locked: SessionSourceDocument = {
      ...unlocked,
      markdownBlocks: unlocked.markdownBlocks.map((block) => ({ ...block, locked: true }))
    };
    rerender(<SessionSourceEditor {...sharedProps} document={locked} value={locked.text} />);
    fireEvent.focus(container.querySelector(".cm-content") as HTMLElement);

    await waitFor(() => expect(onActiveBlockChange).toHaveBeenLastCalledWith(expect.objectContaining({ locked: true })));
  });
});

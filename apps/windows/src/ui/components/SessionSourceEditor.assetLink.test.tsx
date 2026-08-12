import { fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSourceDocument } from "../../common/sessionSourceDocument";
import { SessionSourceEditor } from "./SessionSourceEditor";

describe("SessionSourceEditor asset references", () => {
  beforeEach(() => {
    window.localStorage.setItem("mathnotes:editor-windowing-lab", "off");
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
  });

  afterEach(() => {
    window.localStorage.removeItem("mathnotes:editor-windowing-lab");
    vi.restoreAllMocks();
  });

  it("opens the source asset path from a block header", async () => {
    const onSourceReferenceClick = vi.fn();
    const document = createDocument("![图](../assets/embedded/diagram.png)");

    const { getByTestId } = renderEditor(document, { onSourceReferenceClick });

    fireEvent.click(getByTestId("source-block-header"));

    expect(onSourceReferenceClick).toHaveBeenCalledWith({
      kind: "source",
      target: "IMG_20260622_104803.png",
      assetPath: "assets/photos/IMG_20260622_104803.png",
      blockId: "0001"
    });
  });

  it("opens markdown image references from the block editor", async () => {
    const onSourceReferenceClick = vi.fn();
    const document = createDocument("![图](../assets/embedded/diagram.png)");
    const { container } = renderEditor(document, { onSourceReferenceClick });

    await waitFor(() => expect(container.querySelector(".cm-line")?.textContent).toContain("diagram.png"));
    const editor = container.querySelector(".cm-content") as HTMLElement;
    vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(8);

    fireEvent.click(editor, { clientX: 14, clientY: 14 });

    expect(onSourceReferenceClick).toHaveBeenCalledWith({
      kind: "asset",
      target: "../assets/embedded/diagram.png",
      blockId: "0001"
    });
  });
});

function createDocument(markdown: string): SessionSourceDocument {
  return {
    text: [`--- source: IMG_20260622_104803.png | block: 0001 ---`, markdown].join("\n"),
    markdownBlocks: [
      {
        blockId: "0001",
        sourceId: "src-0001",
        path: "blocks/0001_ai_transcript.md",
        source: "ai_transcription",
        header: "IMG_20260622_104803.png",
        sourceAssetPath: "assets/photos/IMG_20260622_104803.png",
        locked: false
      }
    ]
  };
}

function renderEditor(
  document: SessionSourceDocument,
  overrides: Partial<Parameters<typeof SessionSourceEditor>[0]> = {}
) {
  return render(
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
      onSelectionLockableChange={vi.fn()}
      onSelectionLocked={vi.fn()}
      onSourceReferenceClick={vi.fn()}
      {...overrides}
    />
  );
}

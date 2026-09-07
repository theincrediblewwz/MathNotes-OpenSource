import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";
import { BlockReorderPreview } from "./BlockReorderPreview";

describe("BlockReorderPreview drop ownership", () => {
  it.each(["original", "blank", "other"])("consumes the %s drop without bubbling through its portal to the file importer", (location) => {
    const importFiles = vi.fn(), onDrop = vi.fn(), onCancel = vi.fn();
    const blocks = [{ blockId: "a", header: "第一块" }, { blockId: "b", header: "第二块" }] as SessionSourceMarkdownBlock[];
    render(<div onDrop={importFiles}><BlockReorderPreview drag={{ blockId: "a", bounds: { left: 0, top: 0, width: 600, height: 500 } }}
      blocks={blocks} markdownByBlockId={{ a: "第一块正文", b: "第二块正文" }} displayByBlockId={new Map()}
      onDrop={onDrop} onCancel={onCancel} /></div>);
    const preview = screen.getByTestId("block-reorder-preview");
    const destination = location === "blank" ? preview : preview.querySelector(`[data-block-id="${location === "original" ? "a" : "b"}"]`)!;
    fireEvent.drop(destination, { clientY: 0, dataTransfer: { types: ["application/x-mathnotes-assistant-context"], files: [] } });
    expect(importFiles).not.toHaveBeenCalled();
    if (location === "other") expect(onDrop).toHaveBeenCalledWith("b", "down");
    else { expect(onDrop).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledTimes(1); }
  });
});

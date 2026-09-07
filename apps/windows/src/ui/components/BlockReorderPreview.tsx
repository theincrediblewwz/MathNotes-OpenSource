import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";

export type BlockReorderDrag = { blockId: string; bounds: { left: number; top: number; width: number; height: number } };

export function BlockReorderPreview({ drag, blocks, markdownByBlockId, displayByBlockId, onDrop, onCancel }: {
  drag: BlockReorderDrag;
  blocks: SessionSourceMarkdownBlock[];
  markdownByBlockId: Record<string, string>;
  displayByBlockId: Map<string, string>;
  onDrop: (targetBlockId: string, direction: "up" | "down") => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState<{ blockId: string; direction: "up" | "down" } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("[data-dragged=true]")?.scrollIntoView?.({ block: "center" });
    const cancelOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", cancelOnEscape);
    window.addEventListener("dragend", onCancel);
    window.addEventListener("drop", onCancel);
    return () => {
      window.removeEventListener("keydown", cancelOnEscape);
      window.removeEventListener("dragend", onCancel);
      window.removeEventListener("drop", onCancel);
    };
  }, [drag.blockId, onCancel]);
  return createPortal(<div className="block-reorder-preview" data-testid="block-reorder-preview" style={drag.bounds} ref={list}
    onDragOver={(event) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientY < bounds.top + 50) event.currentTarget.scrollTop -= 24;
      if (event.clientY > bounds.bottom - 50) event.currentTarget.scrollTop += 24;
    }}
    onDrop={(event) => {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }}>
    <p>拖到目标块的上方或下方，松开完成移动</p>
    {blocks.map((block) => <section key={block.blockId} data-dragged={drag.blockId === block.blockId} data-block-id={block.blockId}
      className={`block-reorder-card ${target?.blockId === block.blockId ? `drop-${target.direction}` : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (block.blockId === drag.blockId) { setTarget(null); return; }
        const bounds = event.currentTarget.getBoundingClientRect();
        setTarget({ blockId: block.blockId, direction: event.clientY < bounds.top + bounds.height / 2 ? "up" : "down" });
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (block.blockId === drag.blockId) { onCancel(); return; }
        const bounds = event.currentTarget.getBoundingClientRect();
        onDrop(block.blockId, event.clientY < bounds.top + bounds.height / 2 ? "up" : "down");
      }}>
      <header><span>{block.header}</span><strong>block: {displayByBlockId.get(block.blockId) ?? block.blockId}{block.locked ? " · 已锁定" : ""}</strong></header>
      <pre>{(markdownByBlockId[block.blockId] ?? "").slice(0, 1200) || "空文本块"}</pre>
    </section>)}
  </div>, document.body);
}

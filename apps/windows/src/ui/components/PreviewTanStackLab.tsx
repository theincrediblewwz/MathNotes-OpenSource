import { useLayoutEffect, type CSSProperties, type ReactNode, type RefCallback, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RenderBlock } from "../sampleSession";

type PreviewTanStackLabProps = {
  blocks: RenderBlock[];
  estimateSize: (block: RenderBlock) => number;
  renderItem: (
    block: RenderBlock,
    index: number,
    measureElement: RefCallback<HTMLElement>,
    style: CSSProperties
  ) => ReactNode;
  scrollElementRef: RefObject<HTMLDivElement | null>;
};

export function PreviewTanStackLab({
  blocks,
  estimateSize,
  renderItem,
  scrollElementRef
}: PreviewTanStackLabProps) {
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    anchorTo: "start",
    count: blocks.length,
    estimateSize: (index) => estimateSize(blocks[index]),
    gap: 6,
    getItemKey: (index) => blocks[index]?.id ?? index,
    getScrollElement: () => scrollElementRef.current,
    overscan: 12,
    useAnimationFrameWithResizeObserver: true
  });
  // Workspace-level anchor preservation owns scroll correction. Letting the
  // virtualizer correct the same resize would apply the delta twice.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    scrollElement.dataset.previewCalibratedTotalHeight = totalSize.toFixed(2);
    scrollElement.dataset.previewMeasuredCount = String(virtualizer.itemSizeCache.size);
  }, [scrollElementRef, totalSize, virtualItems, virtualizer]);

  return (
    <article
      className="rendered-note"
      data-preview-tanstack-container="true"
      style={{ height: totalSize, position: "relative" }}
    >
      {virtualItems.map((virtualItem) => {
        const block = blocks[virtualItem.index];
        if (!block) return null;
        return renderItem(block, virtualItem.index, virtualizer.measureElement, {
          left: 0,
          marginBottom: 0,
          position: "absolute",
          top: 0,
          transform: `translateY(${virtualItem.start}px)`,
          width: "100%"
        });
      })}
    </article>
  );
}

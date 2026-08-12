import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefCallback, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";

type SourceTanStackLabProps = {
  blocks: SessionSourceMarkdownBlock[];
  estimateSize: (block: SessionSourceMarkdownBlock, index: number) => number;
  locatingIndex: number;
  locatingNonce: number;
  onLocateMounted?: (nonce: number) => void;
  renderItem: (
    block: SessionSourceMarkdownBlock,
    index: number,
    measureElement: RefCallback<HTMLElement>,
    style: CSSProperties,
    scrolling: boolean
  ) => ReactNode;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  overscan?: number;
  staticWhileScrolling?: boolean;
};

export function SourceTanStackLab({
  blocks,
  estimateSize,
  locatingIndex,
  locatingNonce,
  onLocateMounted,
  renderItem,
  scrollElementRef,
  overscan = 8,
  staticWhileScrolling = false
}: SourceTanStackLabProps) {
  const lastLocateRequestRef = useRef("");
  const notifiedLocateRequestRef = useRef("");
  const locateFrameRef = useRef<number | null>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: blocks.length,
    estimateSize: (index) => estimateSize(blocks[index], index),
    gap: 8,
    getItemKey: (index) => blocks[index]?.blockId ?? index,
    getScrollElement: () => scrollElementRef.current,
    overscan,
    useAnimationFrameWithResizeObserver: true
  });
  // Workspace-level anchor preservation is the single owner of scroll
  // correction. A second correction here can pull the editor back after the
  // user has already expressed a newer scroll intent.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const locateRequest = `${locatingIndex}:${locatingNonce}`;
    if (locatingIndex < 0) return;
    const mountedTarget = scrollElementRef.current?.querySelector(`[data-index="${locatingIndex}"]`);
    if (mountedTarget && notifiedLocateRequestRef.current !== locateRequest) {
      notifiedLocateRequestRef.current = locateRequest;
      onLocateMounted?.(locatingNonce);
    }
    if (lastLocateRequestRef.current === locateRequest && mountedTarget) return;
    lastLocateRequestRef.current = locateRequest;
    let remainingFrames = 12;
    const locate = () => {
      virtualizer.scrollToIndex(locatingIndex, { align: "center" });
      remainingFrames -= 1;
      const mounted = scrollElementRef.current?.querySelector(
        `[data-index="${locatingIndex}"]`
      );
      if (mounted && notifiedLocateRequestRef.current !== locateRequest) {
        notifiedLocateRequestRef.current = locateRequest;
        onLocateMounted?.(locatingNonce);
      }
      if (mounted || remainingFrames <= 0) {
        locateFrameRef.current = null;
        return;
      }
      locateFrameRef.current = window.requestAnimationFrame(locate);
    };
    locate();
    return () => {
      if (locateFrameRef.current !== null) {
        window.cancelAnimationFrame(locateFrameRef.current);
        locateFrameRef.current = null;
      }
    };
  }, [locatingIndex, locatingNonce, onLocateMounted, scrollElementRef, virtualizer]);

  useLayoutEffect(() => {
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    scrollElement.dataset.sourceTanstackTotalHeight = totalSize.toFixed(2);
    scrollElement.dataset.sourceTanstackMeasuredCount = String(virtualizer.itemSizeCache.size);
  }, [scrollElementRef, totalSize, virtualItems, virtualizer]);

  return (
    <div
      data-source-tanstack-container="true"
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
        }, staticWhileScrolling && virtualizer.isScrolling);
      })}
    </div>
  );
}

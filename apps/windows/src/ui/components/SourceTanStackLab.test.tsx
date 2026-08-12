import { render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { SourceTanStackLab } from "./SourceTanStackLab";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, start: 0 }],
    getTotalSize: () => 100,
    itemSizeCache: new Map(),
    isScrolling: false,
    measureElement: () => undefined,
    scrollToIndex: vi.fn(),
    shouldAdjustScrollPositionOnItemSizeChange: undefined
  })
}));

describe("SourceTanStackLab preview locate handshake", () => {
  it("notifies the parent after the target block has actually mounted", async () => {
    const scrollElementRef = createRef<HTMLDivElement>();
    const onLocateMounted = vi.fn();
    const block = {
      blockId: "0042",
      sourceId: "src-0042",
      path: "blocks/0042.md",
      source: "user" as const,
      header: "user",
      locked: false
    };

    const { rerender } = render(<div ref={scrollElementRef} />);
    rerender(
      <div ref={scrollElementRef}>
        <SourceTanStackLab
          blocks={[block]}
          estimateSize={() => 100}
          locatingIndex={0}
          locatingNonce={7}
          onLocateMounted={onLocateMounted}
          renderItem={(_item, index, measureElement, style) => (
            <div data-index={index} key={index} ref={measureElement} style={style}>第 42 块</div>
          )}
          scrollElementRef={scrollElementRef}
        />
      </div>
    );

    await waitFor(() => expect(onLocateMounted).toHaveBeenCalledWith(7));
    expect(onLocateMounted).toHaveBeenCalledTimes(1);
  });
});

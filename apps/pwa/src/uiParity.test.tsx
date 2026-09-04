// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionBottomNavigation, sessionPreviewText } from "./App";
import type { CachedSession } from "./domain";

afterEach(cleanup);

describe("Android-aligned PWA navigation", () => {
  it("exposes the same four primary destinations and the pending queue count", () => {
    const onSelect = vi.fn();
    render(<CompanionBottomNavigation activeTab="notes" queueCount={3} onSelect={onSelect} />);

    const notes = screen.getByRole("button", { name: "笔记" });
    expect(notes.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "拍摄" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "队列" }).textContent).toContain("3");
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "拍摄" }));
    expect(onSelect).toHaveBeenCalledWith("capture");
  });

  it("uses rendered notebook content instead of generic continue-reading copy", () => {
    const cached: CachedSession = {
      key: "profile\0book\0session",
      profileId: "profile",
      version: 1,
      notebookId: "book",
      sessionId: "session",
      title: "泛函分析 第 3 讲",
      revision: "r1",
      updatedAt: "2026-09-01T00:00:00.000Z",
      blockCount: 1,
      markdown: "<!-- block:0001 source:user -->\n## 半群与生成元\n\n设 $T(t)$ 是强连续半群。\n\n$$\\|T(t)x\\| \\le e^{\\omega t}\\|x\\|.$$",
      html: "<h2>半群与生成元</h2><p>设 T(t) 是强连续半群。</p><script>hidden()</script>",
      assets: [],
      syncedAt: "2026-09-01T00:00:00.000Z"
    };

    expect(sessionPreviewText(cached)).toBe("半群与生成元 设 T(t) 是强连续半群。");
    expect(sessionPreviewText(cached)).not.toContain("\\|");
    expect(sessionPreviewText(cached)).not.toContain("block:");
  });
});

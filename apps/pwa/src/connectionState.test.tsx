// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionDetails, ConnectionState, connectionDetail, statusLabel } from "./App";

describe("PWA connection state", () => {
  it("does not describe an API failure as an unspecified retry wait", () => {
    expect(statusLabel("failed")).toBe("主机暂不可达");
    expect(connectionDetail("failed", "").body).toContain("主机 API 没有响应");
  });

  it("shows the exact host, cached boundary, and a concrete retry action", () => {
    const retry = vi.fn();
    render(
      <ConnectionDetails
        lastSuccessfulSyncAt="2026-07-28T08:30:00.000Z"
        message="目录暂时无法更新，正在显示离线缓存。"
        onClose={() => undefined}
        onRetry={retry}
        origin="https://macbook-air.tail532618.ts.net"
        state="failed"
      />
    );

    expect(screen.getByText("主机暂时无法连接")).toBeTruthy();
    expect(screen.getByText("https://macbook-air.tail532618.ts.net")).toBeTruthy();
    expect(screen.getByText(/显示离线缓存/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("opens connection details from the compact header state", () => {
    const toggle = vi.fn();
    render(<ConnectionState expanded={false} onToggle={toggle} state="failed" />);
    fireEvent.click(screen.getByRole("button", { name: /连接状态：主机暂不可达/ }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

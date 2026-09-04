// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import MobileModeApp from "./MobileModeApp";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
});
afterEach(cleanup);

describe("mobile mode ownership", () => {
  it("keeps an explicit legacy standalone workspace until the user reconnects", async () => {
    localStorage.setItem("mathnotes:mobile-mode:v1", "standalone");
    render(<MobileModeApp />);
    await waitFor(() => expect(screen.getByText("手机独立", { selector: "strong" })).toBeTruthy());
    expect(screen.getByText(/无需电脑地址、配对码或 Tailscale/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接电脑" }));
    await waitFor(() => expect(screen.getByText("连接你的 MathNotes")).toBeTruthy());
    expect(localStorage.getItem("mathnotes:mobile-mode:v1")).toBe("companion");
  });
});

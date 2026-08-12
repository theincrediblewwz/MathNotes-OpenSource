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
  it("defaults to phone standalone and only changes mode after an explicit click", async () => {
    render(<MobileModeApp />);
    await waitFor(() => expect(screen.getByText("手机独立", { selector: "strong" })).toBeTruthy());
    expect(screen.getByText(/无需电脑地址、配对码或 Tailscale/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接电脑" }));
    expect(screen.getByRole("button", { name: "切换到手机独立" })).toBeTruthy();
    expect(localStorage.getItem("mathnotes:mobile-mode:v1")).toBe("companion");
  });
});

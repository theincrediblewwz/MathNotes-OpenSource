import { describe, expect, it } from "vitest";
import { createSessionId, createSessionTitle } from "./sessionNaming";

describe("sessionNaming", () => {
  it("creates sortable session ids from wall-clock time", () => {
    expect(createSessionId(new Date("2026-06-30T05:04:03.000Z"))).toBe("2026-06-30_050403_session");
  });

  it("creates a readable default session title", () => {
    expect(createSessionTitle(new Date("2026-06-30T05:04:03.000Z"))).toBe("数学笔记 2026-06-30 05:04");
  });
});

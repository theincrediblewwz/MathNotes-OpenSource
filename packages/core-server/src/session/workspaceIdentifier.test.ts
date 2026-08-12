import { describe, expect, it } from "vitest";
import { isSafeWorkspaceIdentifier } from "./workspaceIdentifier";

describe("workspaceIdentifier", () => {
  it("accepts workspace IDs produced from Unicode notebook and session titles", () => {
    expect(isSafeWorkspaceIdentifier("20260728073706_未命名_session_12ce79")).toBe(true);
    expect(isSafeWorkspaceIdentifier("泛函分析")).toBe(true);
  });

  it.each([
    "",
    ".",
    "..",
    "../outside",
    "nested/session",
    "nested\\session",
    "bad\u0000id",
    "x".repeat(129)
  ])("rejects unsafe workspace ID %j", (value) => {
    expect(isSafeWorkspaceIdentifier(value)).toBe(false);
  });
});

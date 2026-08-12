import { describe, expect, it } from "vitest";
import type { PairingTarget } from "./domain";
import { retainAvailableSelection } from "./catalogSelection";

const first: PairingTarget = {
  notebookId: "try",
  notebookTitle: "try",
  sessionId: "20260728073706_未命名_session_12ce79",
  title: "未命名 Session"
};

describe("retainAvailableSelection", () => {
  it("keeps the directory view selected when catalog refresh starts from the directory", () => {
    expect(retainAvailableSelection(undefined, [first])).toBeUndefined();
  });

  it("keeps an open session only while the refreshed catalog still contains it", () => {
    expect(retainAvailableSelection(first, [{ ...first }])).toEqual(first);
    expect(retainAvailableSelection(first, [])).toBeUndefined();
  });
});

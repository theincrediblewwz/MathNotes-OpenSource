import { describe, expect, it } from "vitest";
import { applySelectionEdit } from "./selectionEdit";

describe("applySelectionEdit", () => {
  it("uses JavaScript UTF-16 offsets and only replaces the exact duplicate occurrence", () => {
    const markdown = "😀同文 / 同文";
    const from = markdown.lastIndexOf("同文");
    expect(applySelectionEdit({
      markdown,
      selection: { from, to: from + 2, selectedText: "同文" },
      replacement: "新文"
    })).toEqual({ ok: true, markdown: "😀同文 / 新文" });
  });

  it("fails closed for invalid or stale selections", () => {
    expect(applySelectionEdit({
      markdown: "abc",
      selection: { from: 2, to: 1, selectedText: "b" },
      replacement: "x"
    })).toEqual({ ok: false, reason: "invalid_range" });
    expect(applySelectionEdit({
      markdown: "abc",
      selection: { from: 1, to: 2, selectedText: "old" },
      replacement: "x"
    })).toEqual({ ok: false, reason: "selection_stale" });
  });

  it("rejects any overlap with a protected span or its lock markers", () => {
    const hash = "a".repeat(64);
    const markdown = `before\n<!-- lock:start id="kept" hash="${hash}" -->\nlocked\n<!-- lock:end id="kept" -->\nafter`;
    const from = markdown.indexOf("locked");
    expect(applySelectionEdit({
      markdown,
      selection: { from, to: from + 6, selectedText: "locked" },
      replacement: "changed"
    })).toEqual({ ok: false, reason: "protected_selection", protectedSpanId: "kept" });
  });
});

import { describe, expect, it } from "vitest";
import {
  findProtectedSpanAtPosition,
  findProtectedSpanCoveringSelection,
  parseProtectedSpans,
  unwrapProtectedSpan,
  wrapProtectedSpan
} from "./lockSpan";

describe("lockSpan", () => {
  it("wraps selected markdown with lock comments and parses the same hash", async () => {
    const wrapped = await wrapProtectedSpan({
      markdown: "定义内容",
      id: "lock_20260626_001"
    });

    expect(wrapped).toContain('<!-- lock:start id="lock_20260626_001" hash="');
    expect(wrapped).toContain("定义内容");
    expect(wrapped).toContain('<!-- lock:end id="lock_20260626_001" -->');
    expect(parseProtectedSpans(wrapped)[0]).toMatchObject({
      id: "lock_20260626_001",
      content: "定义内容"
    });
    expect(parseProtectedSpans(wrapped)[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("finds protected span ranges around the cursor and unwraps them", async () => {
    const locked = await wrapProtectedSpan({
      markdown: "定义 1.1 已人工确认\n\n公式保持不变。",
      id: "lock_20260626_002"
    });
    const markdown = ["前文", locked, "后文"].join("\n\n");
    const cursor = markdown.indexOf("公式保持不变") + 2;

    const span = findProtectedSpanAtPosition(markdown, cursor);

    expect(span).toMatchObject({
      id: "lock_20260626_002",
      content: "定义 1.1 已人工确认\n\n公式保持不变。"
    });
    expect(span?.from).toBe(markdown.indexOf("<!-- lock:start"));
    expect(span?.to).toBe(markdown.indexOf("<!-- lock:end") + '<!-- lock:end id="lock_20260626_002" -->'.length);
    expect(unwrapProtectedSpan(markdown, span!)).toBe("前文\n\n定义 1.1 已人工确认\n\n公式保持不变。\n\n后文");
  });

  it("finds a protected span only when the whole selection is inside it", async () => {
    const locked = await wrapProtectedSpan({
      markdown: "可解除固定的内容",
      id: "lock_20260626_003"
    });
    const markdown = ["前文", locked, "后文"].join("\n");
    const from = markdown.indexOf("可解除");
    const to = markdown.indexOf("内容") + "内容".length;

    expect(findProtectedSpanCoveringSelection(markdown, from, to)).toMatchObject({
      id: "lock_20260626_003"
    });
    expect(findProtectedSpanCoveringSelection(markdown, markdown.indexOf("前文"), to)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { StreamingOutputGuard } from "./streamingOutputGuard";

describe("StreamingOutputGuard", () => {
  it("keeps ordinary repeated math notation healthy", () => {
    const guard = new StreamingOutputGuard();

    expect(guard.observe("$$\nX = X_+ \\oplus X_-\n$$\n").state).toBe("healthy");
    expect(guard.observe("$$\nX = X_+ \\oplus X_-\n$$\n").state).toBe("healthy");
  });

  it("warns once and then trips on a repeated control sequence", () => {
    const guard = new StreamingOutputGuard({
      repeatedTokenWarningCount: 4,
      repeatedTokenStopCount: 8
    });

    expect(guard.observe("## 推导\n\\quad \\quad \\quad \\quad ").state).toBe("suspicious");
    const stopped = guard.observe("\\quad \\quad \\quad \\quad ");

    expect(stopped).toMatchObject({ state: "tripped", reason: "repeated_token" });
    expect(stopped.safeText).toContain("## 推导");
    expect(stopped.safeText).not.toContain("\\quad \\quad \\quad \\quad \\quad");
  });

  it("detects identical lines split across chunks", () => {
    const guard = new StreamingOutputGuard({
      repeatedLineWarningCount: 2,
      repeatedLineStopCount: 4
    });

    expect(guard.observe("## 推导\nx = y\nx = y\n").state).toBe("suspicious");
    const stopped = guard.observe("x = y\nx = y\n");

    expect(stopped).toMatchObject({ state: "tripped", reason: "repeated_line" });
    expect(stopped.safeText).toContain("## 推导");
  });

  it("warns and then trips on long low-diversity output", () => {
    const guard = new StreamingOutputGuard({
      repeatedTokenWarningCount: 100,
      repeatedTokenStopCount: 200,
      lowDiversityWarningTokens: 8,
      lowDiversityStopTokens: 12,
      lowDiversityUniqueRatio: 0.3
    });

    expect(guard.observe("alpha beta ".repeat(4)).state).toBe("suspicious");
    expect(guard.observe("alpha beta ".repeat(2))).toMatchObject({
      state: "tripped",
      reason: "low_diversity"
    });
  });

  it("does not treat a long structured derivation as low diversity", () => {
    const guard = new StreamingOutputGuard({
      lowDiversityWarningTokens: 12,
      lowDiversityStopTokens: 20
    });
    const result = guard.observe(
      "## 定理\n1. 假设 A 且映射连续\n2. 由紧性推出子列 B\n3. 因此极限满足 C\n$$x_n \\to x$$\n[不确定：符号]"
    );

    expect(result.state).toBe("healthy");
  });
});

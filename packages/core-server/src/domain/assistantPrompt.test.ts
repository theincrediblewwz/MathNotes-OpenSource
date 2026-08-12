import { describe, expect, it } from "vitest";
import { buildAssistantPrompt } from "./assistantPrompt";

describe("buildAssistantPrompt", () => {
  it("keeps explanation separate from faithful transcription", () => {
    const prompt = buildAssistantPrompt({
      mode: "explain",
      markdownContext: "$$T_n \\to T$$\n\n[不确定：一致收敛?]",
      question: "这里为什么需要有界性？"
    });

    expect(prompt).toContain("独立学习助手");
    expect(prompt).toContain("原笔记是只读证据");
    expect(prompt).toContain("用户问题：这里为什么需要有界性？");
    expect(prompt).toContain("[不确定：一致收敛?]");
    expect(prompt).not.toContain("忠实转写为 Markdown");
  });
});

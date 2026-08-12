import { describe, expect, it } from "vitest";
import {
  ASSISTANT_CONTEXT_LIMITS,
  buildAssistantContextPacket,
  extractAssistantBlockOrdinals
} from "./assistantContext";

describe("assistant context packet", () => {
  it("uses current display ordinals and reports the exact provider context length", () => {
    const blocks = Array.from({ length: 50 }, (_, index) => ({
      id: String(index + 1).padStart(4, "0"),
      source: "user",
      markdown: index === 41 ? "第 42 块的精确内容：一致有界原理" : `普通内容 ${index + 1}`
    }));
    const packet = buildAssistantContextPacket({
      focus: { kind: "session", label: "当前 Session" },
      question: "第 42 块是什么？",
      blocks
    });

    expect(extractAssistantBlockOrdinals("第 42 块和第2块", blocks.length)).toEqual([42, 2]);
    expect(packet.markdownContext).toContain("42. stable ID=0042");
    expect(packet.markdownContext).toContain("## 第 42 块 · stable ID 0042");
    expect(packet.markdownContext).toContain("第 42 块的精确内容：一致有界原理");
    expect(packet.usage.textCharacters).toBe(Array.from(packet.markdownContext).length);
    expect(packet.usage.namedBlockOrdinals).toEqual([42]);
  });

  it("enforces one total hard cap including focus, manifest, named blocks and headers", () => {
    const blocks = Array.from({ length: 80 }, (_, index) => ({
      id: String(index + 1).padStart(4, "0"),
      source: "ai_transcription",
      markdown: `${index}:`.repeat(15_000)
    }));
    const packet = buildAssistantContextPacket({
      focus: {
        kind: "selection",
        blockId: "0042",
        label: "第 42 块选区",
        excerpt: "选".repeat(20_000)
      },
      question: "解释第 42 块",
      blocks
    });

    expect(packet.usage.textCharacters).toBe(ASSISTANT_CONTEXT_LIMITS.totalCharacters);
    expect(packet.usage.maximumTextCharacters).toBe(ASSISTANT_CONTEXT_LIMITS.totalCharacters);
    expect(packet.usage.focusTruncated).toBe(true);
    expect(packet.usage.truncated).toBe(true);
  });
});

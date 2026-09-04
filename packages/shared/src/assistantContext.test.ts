import { describe, expect, it } from "vitest";
import {
  ASSISTANT_CONTEXT_LIMITS,
  buildAssistantContextPacket,
  extractAssistantBlockOrdinals,
  resolveAssistantBlockEditIntent
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

    expect(extractAssistantBlockOrdinals("第 42 块、第十个块和 block 0002", blocks.length)).toEqual([42, 10, 2]);
    expect(packet.markdownContext).toContain("42. source=user");
    expect(packet.markdownContext).toContain("## 第 42 块");
    expect(packet.markdownContext).toContain("第 42 块的精确内容：一致有界原理");
    expect(packet.markdownContext).not.toContain("stable ID");
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

  it("labels related notes with notebook and session names without internal reference chips", () => {
    const packet = buildAssistantContextPacket({
      focus: { kind: "session", label: "当前笔记" },
      question: "一致有界原理是什么？",
      blocks: [{ id: "0001", source: "user", markdown: "当前笔记" }],
      relatedSources: [{
        refId: "R1",
        notebookId: "analysis",
        notebookTitle: "泛函分析",
        sessionId: "lecture",
        sessionTitle: "一致有界原理",
        blockId: "0007",
        markdown: "逐点有界蕴含一致有界。",
        locked: true
      }]
    });

    expect(packet.markdownContext).toContain("Notebook：泛函分析 / Session：一致有界原理");
    expect(packet.markdownContext).not.toContain("[R1]");
    expect(packet.markdownContext).not.toContain("notebook=analysis");
    expect(packet.markdownContext).toContain("权限：只读；内容已锁定");
    expect(packet.usage.relatedSourceRefs).toEqual(["R1"]);
  });

  it("routes an explicit single-block modification to the guarded edit flow", () => {
    expect(resolveAssistantBlockEditIntent({
      question: "请把第三个块改写得更清楚，公式不要变",
      blockCount: 8
    })).toEqual({ ordinal: 3, instruction: "请把第三个块改写得更清楚，公式不要变" });
    expect(resolveAssistantBlockEditIntent({
      question: "润色当前块",
      blockCount: 8,
      focusedOrdinal: 4
    })).toEqual({ ordinal: 4, instruction: "润色当前块" });
    expect(resolveAssistantBlockEditIntent({
      question: "比较第 3 块和第 4 块",
      blockCount: 8
    })).toBeNull();
  });
});

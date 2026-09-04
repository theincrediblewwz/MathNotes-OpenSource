import { describe, expect, it } from "vitest";
import { assistantPortalRootId, prepareAssistantWindowDocument } from "./assistantNativeWindow";

describe("prepareAssistantWindowDocument", () => {
  it("creates a dedicated assistant root and copies only renderer styles", () => {
    const source = document.implementation.createHTMLDocument("source");
    source.head.innerHTML = '<style>.assistant-workspace{display:grid}</style><script>throw new Error("no")</script>';
    const target = document.implementation.createHTMLDocument("target");

    const root = prepareAssistantWindowDocument(source, target);

    expect(root.id).toBe(assistantPortalRootId);
    expect(target.title).toBe("MathNotes · 与笔记对话");
    expect(target.body.classList.contains("mathnotes-assistant-window")).toBe(true);
    expect(target.head.querySelectorAll("style[data-mathnotes-assistant-style]")).toHaveLength(1);
    expect(target.head.querySelector("script")).toBeNull();
  });
});

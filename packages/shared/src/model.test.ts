import { describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "./model";

describe("shared note model", () => {
  it("creates draft sessions with append-only AI policy", () => {
    const session = createSessionRecord({
      id: "session_20260626_lecture_03",
      title: "泛函分析 第 3 讲",
      createdAt: "2026-06-26T10:00:00.000Z"
    });

    expect(session.status).toBe("draft");
    expect(session.currentDraftPolicy).toBe("append_only");
    expect(session.blocks).toEqual([]);
    expect(session.locks).toEqual([]);
    expect(session.exportPolicy.includeMetadataComments).toBe(true);
  });

  it("marks AI transcript blocks as AI-editable drafts", () => {
    const block = createBlockRef({
      id: "0003",
      type: "markdown",
      path: "blocks/0003_ai_transcript.md",
      source: "ai_transcription",
      createdAt: "2026-06-26T10:01:00.000Z"
    });

    expect(block.status).toBe("draft");
    expect(block.readonly).toBe(false);
    expect(block.editableByAi).toBe(true);
  });

  it("marks user revision blocks as not editable by AI", () => {
    const block = createBlockRef({
      id: "0004",
      type: "markdown",
      path: "blocks/0004_user_revision.md",
      source: "user_revision",
      createdAt: "2026-06-26T10:02:00.000Z"
    });

    expect(block.editableByAi).toBe(false);
  });

  it("marks pdf blocks as readonly and not editable by AI", () => {
    const block = createBlockRef({
      id: "0001",
      type: "pdf",
      path: "assets/pdfs/lecture.pdf",
      source: "pdf_import",
      createdAt: "2026-06-26T10:03:00.000Z"
    });

    expect(block.readonly).toBe(true);
    expect(block.editableByAi).toBe(false);
  });

  it("preserves optional PDF continuous-preview policy", () => {
    const block = createBlockRef({
      id: "0002",
      type: "pdf",
      path: "assets/pdfs/recognition-source.pdf",
      source: "pdf_import",
      renderInNote: false,
      createdAt: "2026-07-15T10:03:00.000Z"
    });

    expect(block.renderInNote).toBe(false);
  });
});

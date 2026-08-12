import { describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { buildSessionSourceDocument, isProtectedSourceHeaderLine, parseSessionSourceText } from "./sessionSourceDocument";

describe("sessionSourceDocument", () => {
  it("builds a single editable source document from session blocks", () => {
    const session = createSessionRecord({
      id: "lecture",
      title: "Lecture",
      createdAt: "2026-06-26T10:00:00.000Z"
    });
    session.blocks.push(
      createBlockRef({
        id: "0001",
        type: "image",
        path: "assets/photos/photo_001.jpg",
        source: "android_camera",
        createdAt: "2026-06-26T10:01:00.000Z"
      }),
      createBlockRef({
        id: "0002",
        type: "markdown",
        path: "blocks/0002_ai_transcript.md",
        source: "ai_transcription",
        fromAssets: ["assets/photos/photo_001.jpg"],
        createdAt: "2026-06-26T10:02:00.000Z"
      }),
      createBlockRef({
        id: "0003",
        type: "markdown",
        path: "blocks/0003_user_note.md",
        source: "user",
        createdAt: "2026-06-26T10:03:00.000Z"
      })
    );
    session.blocks[2].status = "locked";

    const document = buildSessionSourceDocument({
      session,
      markdownByPath: {
        "blocks/0002_ai_transcript.md": "source: photo_001.jpg\n\n## OCR 草稿\n\n设 T 有界。",
        "blocks/0003_user_note.md": "补充：统一常数记号。"
      }
    });

    expect(document.text).not.toContain("--- asset: photo_001.jpg | block: 0001 | type: image ---");
    expect(document.text).toContain("--- source: photo_001.jpg | block: 0002 ---");
    expect(document.text).not.toContain("path: blocks/0002_ai_transcript.md");
    expect(document.text).not.toContain("kind: ai_transcription");
    expect(document.text).not.toContain("\nsource: photo_001.jpg");
    expect(document.text).toContain("--- source: user | block: 0003 ---");
    expect(document.markdownBlocks).toEqual([
      {
        blockId: "0002",
        sourceId: "src-0002",
        path: "blocks/0002_ai_transcript.md",
        source: "ai_transcription",
        header: "photo_001.jpg",
        sourceAssetPath: "assets/photos/photo_001.jpg",
        locked: false
      },
      {
        blockId: "0003",
        sourceId: "src-0003",
        path: "blocks/0003_user_note.md",
        source: "user",
        header: "user",
        locked: true
      }
    ]);
  });

  it("parses edited source text back into markdown block updates", () => {
    const edited = [
      "--- asset: photo_001.jpg | block: 0001 | type: image ---",
      "",
      "--- source: photo_001.jpg | block: 0002 ---",
      "source: photo_001.jpg",
      "## OCR 草稿",
      "",
      "修改后的第一块。",
      "",
      "--- source: user | block: 0003 ---",
      "补充：修改后的用户笔记。",
      ""
    ].join("\n");

    expect(parseSessionSourceText(edited)).toEqual([
      {
        blockId: "0002",
        path: "",
        markdown: "## OCR 草稿\n\n修改后的第一块。"
      },
      {
        blockId: "0003",
        path: "",
        markdown: "补充：修改后的用户笔记。"
      }
    ]);
  });

  it("continues parsing legacy source headers that include block paths", () => {
    const edited = [
      "--- source: photo_001.jpg | block: 0002 | path: blocks/0002_ai_transcript.md | kind: ai_transcription ---",
      "legacy header body"
    ].join("\n");

    expect(parseSessionSourceText(edited)).toEqual([
      {
        blockId: "0002",
        path: "blocks/0002_ai_transcript.md",
        markdown: "legacy header body"
      }
    ]);
  });

  it("treats tolerated source header variants as protected block boundaries", () => {
    const edited = [
      "---- source: photo_001.png |block: 0002 |path:blocks/0002_ai_transcript.md | kind: ai_transcription ---",
      "## OCR 草稿",
      "",
      "--- source: user | block: 0003 | path: blocks/0003_user_note.md | kind: user ---",
      "用户补充。"
    ].join("\n");

    expect(isProtectedSourceHeaderLine("---- source: photo_001.png |block: 0002 |path:blocks/0002_ai_transcript.md | kind: ai_transcription ---")).toBe(
      true
    );
    expect(parseSessionSourceText(edited)).toEqual([
      {
        blockId: "0002",
        path: "blocks/0002_ai_transcript.md",
        markdown: "## OCR 草稿"
      },
      {
        blockId: "0003",
        path: "blocks/0003_user_note.md",
        markdown: "用户补充。"
      }
    ]);
  });

  it("strips damaged generated source header fragments from markdown bodies", () => {
    const edited = [
      "--- source: PixPin_2026-05-10_13-17-39.png | block: 0016 | path: blocks/0016_ai_transcript.md | kind: ai_transcription ---",
      "#### Codex CLI 识别失败",
      "",
      "网络恢复后，请在任务面板点击重试。 -- source: PixPin_2026-05-10_13-17-39.png | block: 0018 | path: blocks/0018_ai_transcript.md | kind: ai_transcription ---",
      "----#### Codex CLI 识别失败",
      "",
      "-- source: PixPin_2026-05-10_13-17-39.png | block: 0012 | path: blocks/0012_ai_transcript.md | kind: ai_transcription --",
      "Codex CLI transcription timed out after 120000ms. 请稍后在任务面板手动重试。"
    ].join("\n");

    expect(parseSessionSourceText(edited)).toEqual([
      {
        blockId: "0016",
        path: "blocks/0016_ai_transcript.md",
        markdown: [
          "#### Codex CLI 识别失败",
          "",
          "网络恢复后，请在任务面板点击重试。",
          "#### Codex CLI 识别失败",
          "",
          "Codex CLI transcription timed out after 120000ms. 请稍后在任务面板手动重试。"
        ].join("\n")
      }
    ]);
  });

  it("strips damaged source header fragments split across multiple lines", () => {
    const edited = [
      "--- source: PixPin_2026-05-10_13-17-39.png | block: 0016 | path: blocks/0016_ai_transcript.md | kind: ai_transcription ---",
      "#### Codex CLI 识别失败",
      "",
      "网络恢复后，请在任务面板点击重试。 -- source: PixPin_2026-05-10_13-17-39.png | block: 0018 |",
      "path: blocks/0018_ai_transcript.md | kind:",
      "ai_transcription ---",
      "#### Codex CLI 识别失败"
    ].join("\n");

    expect(parseSessionSourceText(edited)).toEqual([
      {
        blockId: "0016",
        path: "blocks/0016_ai_transcript.md",
        markdown: "#### Codex CLI 识别失败\n\n网络恢复后，请在任务面板点击重试。\n#### Codex CLI 识别失败"
      }
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { parseStandaloneExport, serializeStandaloneExport, type StandaloneSession } from "./standaloneStorage";

const session: StandaloneSession = {
  id: "session-1", title: "手机笔记", markdown: "# 草稿", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z"
};

describe("standalone workspace export", () => {
  it("round trips versioned Markdown sessions without credentials", () => {
    const serialized = serializeStandaloneExport([session]);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("apiKey");
    const restored = parseStandaloneExport(serialized);
    expect(restored.sessions).toEqual([session]);
    expect(restored.assets).toEqual([]);
  });

  it("rejects an unrelated JSON document", () => {
    expect(() => parseStandaloneExport('{"version":1,"sessions":[]}')).toThrow(/不是受支持/);
  });

  it("rejects incomplete session rows", () => {
    expect(() => parseStandaloneExport('{"format":"mathnotes-standalone-export","version":1,"sessions":[{"id":"x"}]}')).toThrow(/不完整/);
  });
});

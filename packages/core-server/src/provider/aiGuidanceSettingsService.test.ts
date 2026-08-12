import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiGuidanceSettingsService, type NotationProfileConfig } from "./aiGuidanceSettingsService";

describe("AiGuidanceSettingsService", () => {
  let rootDir: string;

  beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), "mathnotes-ai-guidance-")); });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it("keeps the locked faithful template and persists a selected user template", async () => {
    const service = new AiGuidanceSettingsService(rootDir);
    await service.start();
    const initial = service.readPromptTemplates();
    expect(initial.templates[0]).toMatchObject({ id: "math_faithful_v1", locked: true });

    await service.savePromptTemplates({
      activeTemplateId: "course_prompt",
      templates: [...initial.templates, { id: "course_prompt", name: "课程", content: "逐行忠实转写。" }]
    });
    const restored = new AiGuidanceSettingsService(rootDir);
    await restored.start();
    expect(restored.activePromptTemplateContent()).toBe("逐行忠实转写。");
  });

  it("selects approved rules only and excludes conflicting meanings", async () => {
    const service = new AiGuidanceSettingsService(rootDir);
    await service.start();
    const config: NotationProfileConfig = {
      schemaVersion: "nh1-v1",
      revision: 1,
      profiles: [{
        id: "waves", name: "波动", description: "", enabled: true, status: "active", priority: 10, version: 1,
        createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
        rules: [
          rule("approved", "xi", "ξ", "边界点"),
          rule("candidate", "draft", "r", "半径"),
          rule("approved", "conflict-a", "T", "周期"),
          rule("approved", "conflict-b", "T", "算子")
        ]
      }]
    };
    await service.saveNotationProfiles(config);
    const preview = service.previewNotation({ query: "ξ T r" });
    expect(preview.selection.promptFragment).toContain("`ξ` 表示 边界点");
    expect(preview.selection.promptFragment).not.toContain("`r` 表示 半径");
    expect(preview.selection.conflicts).toHaveLength(1);
    expect(preview.selection.conflicts[0]).toMatchObject({ pattern: "T", ruleIds: ["conflict-a", "conflict-b"] });
    expect(new Set(preview.selection.conflicts[0].meanings)).toEqual(new Set(["周期", "算子"]));
    expect(preview.fullPrompt).toContain("图片证据优先");
  });
});

function rule(status: "candidate" | "approved", id: string, pattern: string, meaning: string) {
  return {
    id, kind: "symbol" as const, pattern, meaning, aliases: [], keywords: [], enabled: true, status,
    version: 1, source: { type: "user" as const }, createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z", approvedAt: status === "approved" ? "2026-08-09T00:00:00.000Z" : undefined
  };
}

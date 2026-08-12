import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultMathPromptTemplate,
  readPromptTemplateConfig,
  writePromptTemplateConfig
} from "./promptTemplateStore";

describe("promptTemplateStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-prompts-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns the built-in math template as the locked default", async () => {
    const config = await readPromptTemplateConfig({ rootDir });

    expect(config.activeTemplateId).toBe(defaultMathPromptTemplate.id);
    expect(config.templates[0]).toMatchObject({
      id: defaultMathPromptTemplate.id,
      name: "数学忠实转写",
      builtIn: true,
      locked: true
    });
    expect(config.templates[0].content).toContain("[图片：");
  });

  it("persists custom templates while keeping the built-in math template immutable", async () => {
    const saved = await writePromptTemplateConfig({
      rootDir,
      config: {
        activeTemplateId: "history_prompt",
        templates: [
          {
            ...defaultMathPromptTemplate,
            name: "被误改的默认模板",
            content: "bad prompt"
          },
          {
            id: "history_prompt",
            name: "历史材料转写",
            content: "请忠实转写史料。",
            builtIn: false,
            locked: false
          }
        ]
      }
    });

    expect(saved.activeTemplateId).toBe("history_prompt");
    expect(saved.templates[0].name).toBe(defaultMathPromptTemplate.name);
    expect(saved.templates[0].content).toBe(defaultMathPromptTemplate.content);

    await expect(readPromptTemplateConfig({ rootDir })).resolves.toMatchObject({
      activeTemplateId: "history_prompt",
      templates: [
        {
          id: defaultMathPromptTemplate.id,
          name: defaultMathPromptTemplate.name
        },
        {
          id: "history_prompt",
          name: "历史材料转写"
        }
      ]
    });
  });
});

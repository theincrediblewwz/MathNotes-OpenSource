import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAssistantFontFamily, defaultPreviewFontFamily } from "../common/defaultUserSettings";
import { readUserSettings, writeUserSettings } from "./userSettingsStore";

describe("userSettingsStore", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), "mathnotes-settings-"));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it("returns usable defaults", async () => {
    const settings = await readUserSettings({
      userDataDir,
      fallbackNotesRootDir: "C:/notes"
    });

    expect(settings).toMatchObject({
      notesRootDir: "C:/notes",
      defaultExportDir: "",
      previewFontFamily: defaultPreviewFontFamily,
      sourceFontSize: 13,
      previewFontSize: 16,
      assistantFontFamily: defaultAssistantFontFamily,
      assistantFontSize: 16,
      themeId: "default_light",
      locale: "zh-CN",
      showCodexAssistant: true
    });
  });

  it("migrates the old Inter preview default to the VSCode preview font stack", async () => {
    await writeUserSettings({
      userDataDir,
      settings: {
        notesRootDir: "D:/MyMathNotes",
        defaultExportDir: "",
        sourceFontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
        sourceFontSize: 13,
        previewFontFamily: '"Inter", "Noto Sans SC", system-ui, sans-serif',
        previewFontSize: 16,
        assistantFontFamily: defaultAssistantFontFamily,
        assistantFontSize: 16,
        themeId: "default_light",
        locale: "zh-CN",
        showCodexAssistant: true
      }
    });

    await expect(
      readUserSettings({
        userDataDir,
        fallbackNotesRootDir: "C:/notes"
      })
    ).resolves.toMatchObject({
      previewFontFamily: defaultPreviewFontFamily
    });
  });

  it("persists notes location and font settings", async () => {
    await writeUserSettings({
      userDataDir,
      settings: {
        notesRootDir: "D:/MyMathNotes",
        defaultExportDir: "D:/Exports",
        sourceFontFamily: "JetBrains Mono",
        sourceFontSize: 15,
        previewFontFamily: "LXGW WenKai",
        previewFontSize: 18,
        assistantFontFamily: "Microsoft YaHei UI",
        assistantFontSize: 20,
        themeId: "dark",
        locale: "en-US",
        showCodexAssistant: false
      }
    });

    await expect(
      readUserSettings({
        userDataDir,
        fallbackNotesRootDir: "C:/notes"
      })
    ).resolves.toMatchObject({
      notesRootDir: "D:/MyMathNotes",
      defaultExportDir: "D:/Exports",
      sourceFontFamily: "JetBrains Mono",
      sourceFontSize: 15,
      previewFontFamily: "LXGW WenKai",
      previewFontSize: 18,
      assistantFontFamily: "Microsoft YaHei UI",
      assistantFontSize: 20,
      themeId: "dark",
      locale: "en-US",
      showCodexAssistant: false
    });
  });

  it("migrates invalid appearance settings to stable defaults", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(userDataDir, "settings"), { recursive: true });
    await writeFile(
      join(userDataDir, "settings", "app.json"),
      JSON.stringify({ notesRootDir: "D:/Notes", themeId: "unknown", locale: "fr-FR" }),
      "utf8"
    );

    await expect(readUserSettings({ userDataDir, fallbackNotesRootDir: "C:/notes" })).resolves.toMatchObject({
      themeId: "default_light",
      locale: "zh-CN"
    });
  });
});

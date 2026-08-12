import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultAssistantFontFamily, defaultPreviewFontFamily, defaultSourceFontFamily } from "../common/defaultUserSettings";
import {
  defaultLocaleId,
  defaultThemeId,
  normalizeLocaleId,
  normalizeThemeId,
  type AppLocaleId,
  type ThemeId
} from "../common/appearanceSettings";

export type UserSettings = {
  notesRootDir: string;
  defaultExportDir: string;
  sourceFontFamily: string;
  sourceFontSize: number;
  previewFontFamily: string;
  previewFontSize: number;
  assistantFontFamily: string;
  assistantFontSize: number;
  themeId: ThemeId;
  locale: AppLocaleId;
  showCodexAssistant: boolean;
  assistantOnlineEnabled?: boolean;
};

const legacyPreviewFontFamily = '"Inter", "Noto Sans SC", system-ui, sans-serif';

export async function readUserSettings(args: {
  userDataDir: string;
  fallbackNotesRootDir: string;
}): Promise<UserSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(args.userDataDir), "utf8")) as Partial<UserSettings>;
    return normalizeSettings(parsed, args.fallbackNotesRootDir);
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) {
      return normalizeSettings({}, args.fallbackNotesRootDir);
    }
    throw error;
  }
}

export async function writeUserSettings(args: {
  userDataDir: string;
  settings: UserSettings;
}): Promise<UserSettings> {
  const normalized = normalizeSettings(args.settings, args.settings.notesRootDir);
  const target = settingsPath(args.userDataDir);
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return normalized;
}

function normalizeSettings(settings: Partial<UserSettings>, fallbackNotesRootDir: string): UserSettings {
  return {
    notesRootDir: cleanPath(settings.notesRootDir) || fallbackNotesRootDir,
    defaultExportDir: cleanPath(settings.defaultExportDir),
    sourceFontFamily: settings.sourceFontFamily?.trim() || defaultSourceFontFamily,
    sourceFontSize: clampFontSize(settings.sourceFontSize, 13),
    previewFontFamily: normalizePreviewFontFamily(settings.previewFontFamily),
    previewFontSize: clampFontSize(settings.previewFontSize, 16),
    assistantFontFamily: settings.assistantFontFamily?.trim() || defaultAssistantFontFamily,
    assistantFontSize: clampFontSize(settings.assistantFontSize, 16),
    themeId: normalizeThemeId(settings.themeId ?? defaultThemeId),
    locale: normalizeLocaleId(settings.locale ?? defaultLocaleId),
    showCodexAssistant: settings.showCodexAssistant !== false,
    assistantOnlineEnabled: settings.assistantOnlineEnabled !== false
  };
}

function normalizePreviewFontFamily(fontFamily: string | undefined): string {
  const cleaned = fontFamily?.trim();
  if (!cleaned || cleaned === legacyPreviewFontFamily) {
    return defaultPreviewFontFamily;
  }
  return cleaned;
}

function cleanPath(path: string | undefined): string {
  return path?.trim() ?? "";
}

function clampFontSize(size: number | undefined, fallback: number): number {
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return fallback;
  }
  return Math.max(11, Math.min(28, Math.round(size)));
}

function settingsPath(userDataDir: string): string {
  return join(userDataDir, "settings", "app.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

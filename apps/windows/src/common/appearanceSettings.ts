export const themeIds = ["default_light", "reading", "high_contrast", "dark"] as const;
export type ThemeId = (typeof themeIds)[number];

export const localeIds = ["zh-CN", "en-US"] as const;
export type AppLocaleId = (typeof localeIds)[number];

export const defaultThemeId: ThemeId = "default_light";
export const defaultLocaleId: AppLocaleId = "zh-CN";

export const themeOptions: ReadonlyArray<{ id: ThemeId; label: string; detail: string }> = [
  { id: "default_light", label: "默认明亮", detail: "保持当前 MathNotes 视觉" },
  { id: "reading", label: "低干扰阅读", detail: "降低边框与状态色对比" },
  { id: "high_contrast", label: "高对比", detail: "增强文字、边界和焦点辨识度" },
  { id: "dark", label: "深色", detail: "适合弱光环境" }
];

export const localeOptions: ReadonlyArray<{ id: AppLocaleId; label: string; coverage: "complete" | "foundation" }> = [
  { id: "zh-CN", label: "简体中文", coverage: "complete" },
  { id: "en-US", label: "English（基础术语）", coverage: "foundation" }
];

export function normalizeThemeId(value: unknown): ThemeId {
  return themeIds.includes(value as ThemeId) ? (value as ThemeId) : defaultThemeId;
}

export function normalizeLocaleId(value: unknown): AppLocaleId {
  return localeIds.includes(value as AppLocaleId) ? (value as AppLocaleId) : defaultLocaleId;
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultMathPromptTemplate, type PromptTemplate, type PromptTemplateConfig } from "../common/promptTemplates";

export { defaultMathPromptTemplate, type PromptTemplate, type PromptTemplateConfig };

export async function readPromptTemplateConfig(args: { rootDir: string }): Promise<PromptTemplateConfig> {
  try {
    const stored = JSON.parse(await readFile(promptConfigPath(args.rootDir), "utf8")) as Partial<PromptTemplateConfig>;
    return normalizePromptTemplateConfig(stored);
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) {
      return normalizePromptTemplateConfig({});
    }
    throw error;
  }
}

export async function writePromptTemplateConfig(args: { rootDir: string; config: PromptTemplateConfig }): Promise<PromptTemplateConfig> {
  const normalized = normalizePromptTemplateConfig(args.config);
  const target = promptConfigPath(args.rootDir);
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    tmp,
    `${JSON.stringify(
      {
        activeTemplateId: normalized.activeTemplateId,
        templates: normalized.templates.filter((template) => !template.builtIn)
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await rename(tmp, target);
  return normalized;
}

export function getActivePromptTemplate(config: PromptTemplateConfig): PromptTemplate {
  return config.templates.find((template) => template.id === config.activeTemplateId) ?? defaultMathPromptTemplate;
}

function normalizePromptTemplateConfig(config: Partial<PromptTemplateConfig>): PromptTemplateConfig {
  const customTemplates = (config.templates ?? [])
    .filter((template) => template.id !== defaultMathPromptTemplate.id)
    .map(normalizeCustomTemplate)
    .filter((template): template is PromptTemplate => Boolean(template));
  const templates = [defaultMathPromptTemplate, ...dedupeTemplates(customTemplates)];
  const activeTemplateId = templates.some((template) => template.id === config.activeTemplateId)
    ? config.activeTemplateId ?? defaultMathPromptTemplate.id
    : defaultMathPromptTemplate.id;
  return {
    activeTemplateId,
    templates
  };
}

function normalizeCustomTemplate(template: Partial<PromptTemplate>): PromptTemplate | undefined {
  const id = sanitizeTemplateId(template.id);
  const content = template.content?.trim();
  if (!id || !content) {
    return undefined;
  }
  return {
    id,
    name: template.name?.trim() || "未命名提示词",
    content,
    builtIn: false,
    locked: false,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  };
}

function dedupeTemplates(templates: PromptTemplate[]): PromptTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    if (seen.has(template.id)) {
      return false;
    }
    seen.add(template.id);
    return true;
  });
}

function sanitizeTemplateId(id?: string): string {
  return (id ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function promptConfigPath(rootDir: string): string {
  return join(rootDir, "settings", "promptTemplates.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createEmptyNotationProfileConfig,
  notationProfileSchemaVersion,
  type NotationProfile,
  type NotationProfileConfig,
  type NotationRule,
  type NotationRuleKind,
  type NotationRuleStatus
} from "../common/notationProfiles";

export async function readNotationProfileConfig(args: { rootDir: string }): Promise<NotationProfileConfig> {
  const target = notationProfileConfigPath(args.rootDir);
  const primary = await tryRead(target);
  if (primary) return primary;
  const backup = await tryRead(`${target}.bak`);
  return backup ?? createEmptyNotationProfileConfig();
}

export async function writeNotationProfileConfig(args: {
  rootDir: string;
  config: NotationProfileConfig;
}): Promise<NotationProfileConfig> {
  const normalized = normalizeNotationProfileConfig(args.config);
  const target = notationProfileConfigPath(args.rootDir);
  const temp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(target, `${target}.bak`);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return normalized;
}

export function normalizeNotationProfileConfig(input: Partial<NotationProfileConfig>): NotationProfileConfig {
  const profiles = dedupeById((input.profiles ?? []).map(normalizeProfile).filter(Boolean) as NotationProfile[]);
  return {
    schemaVersion: notationProfileSchemaVersion,
    revision: clampVersion(input.revision),
    profiles
  };
}

export function notationProfileConfigPath(rootDir: string): string {
  return join(rootDir, "settings", "notation", "profiles.json");
}

async function tryRead(path: string): Promise<NotationProfileConfig | undefined> {
  try {
    return normalizeNotationProfileConfig(JSON.parse(await readFile(path, "utf8")) as Partial<NotationProfileConfig>);
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function normalizeProfile(value: Partial<NotationProfile>): NotationProfile | undefined {
  const id = safeId(value.id);
  const name = cleanText(value.name, 120);
  if (!id || !name) return undefined;
  const createdAt = safeDate(value.createdAt);
  return {
    id,
    name,
    description: cleanText(value.description, 500),
    enabled: value.enabled !== false,
    status: value.status === "retired" ? "retired" : "active",
    priority: clampNumber(value.priority, 0, -100, 100),
    version: clampVersion(value.version),
    rules: dedupeById((value.rules ?? []).map(normalizeRule).filter(Boolean) as NotationRule[]),
    createdAt,
    updatedAt: safeDate(value.updatedAt, createdAt)
  };
}

function normalizeRule(value: Partial<NotationRule>): NotationRule | undefined {
  const id = safeId(value.id);
  const pattern = cleanText(value.pattern, 160);
  const meaning = cleanText(value.meaning, 500);
  if (!id || !pattern || !meaning) return undefined;
  const createdAt = safeDate(value.createdAt);
  const status = normalizeStatus(value.status);
  return {
    id,
    kind: normalizeKind(value.kind),
    pattern,
    meaning,
    aliases: cleanStringList(value.aliases, 20, 160),
    keywords: cleanStringList(value.keywords, 20, 80),
    enabled: value.enabled !== false,
    status,
    version: clampVersion(value.version),
    source: { type: "user" },
    createdAt,
    updatedAt: safeDate(value.updatedAt, createdAt),
    approvedAt: status === "approved" ? safeDate(value.approvedAt, createdAt) : undefined
  };
}

function normalizeStatus(value: NotationRuleStatus | undefined): NotationRuleStatus {
  return value === "approved" || value === "rejected" || value === "retired" ? value : "candidate";
}

function normalizeKind(value: NotationRuleKind | undefined): NotationRuleKind {
  return value === "convention" || value === "definition" || value === "diagram_label" ? value : "symbol";
}

function safeId(value: string | undefined): string {
  return (value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function cleanText(value: string | undefined, max: number): string {
  return (value ?? "").trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}

function cleanStringList(value: string[] | undefined, maxItems: number, maxLength: number): string[] {
  return [...new Set((value ?? []).map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function safeDate(value: string | undefined, fallback = new Date(0).toISOString()): string {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function clampVersion(value: number | undefined): number {
  return clampNumber(value, 1, 1, Number.MAX_SAFE_INTEGER);
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function dedupeById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

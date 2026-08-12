import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildFaithfulTranscriptionPrompt,
  defaultFaithfulTranscriptionPromptContent
} from "../domain/faithfulTranscriptionPrompt";

export type PromptTemplate = {
  id: string;
  name: string;
  content: string;
  builtIn?: boolean;
  locked?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type PromptTemplateConfig = { activeTemplateId: string; templates: PromptTemplate[] };
export type NotationRuleStatus = "candidate" | "approved" | "rejected" | "retired";
export type NotationRuleKind = "symbol" | "convention" | "definition" | "diagram_label";
export type NotationRule = {
  id: string;
  kind: NotationRuleKind;
  pattern: string;
  meaning: string;
  aliases: string[];
  keywords: string[];
  enabled: boolean;
  status: NotationRuleStatus;
  version: number;
  source: { type: "user" };
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};
export type NotationProfile = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: "active" | "retired";
  priority: number;
  version: number;
  rules: NotationRule[];
  createdAt: string;
  updatedAt: string;
};
export type NotationProfileConfig = { schemaVersion: "nh1-v1"; revision: number; profiles: NotationProfile[] };
export type NotationConflict = { pattern: string; ruleIds: string[]; meanings: string[] };
export type NotationRuleReference = {
  profileId: string;
  profileName: string;
  profileVersion: number;
  ruleId: string;
  ruleVersion: number;
  pattern: string;
  meaning: string;
  hash: string;
};
export type NotationSelection = {
  schemaVersion: "nh1-v1";
  query: string;
  rules: NotationRuleReference[];
  conflicts: NotationConflict[];
  omittedByBudget: number;
  characterCount: number;
  selectionHash: string;
  promptFragment: string;
};
export type NotationPreviewInput = { query: string; profileIds?: string[]; maxRules?: number; maxCharacters?: number };
export type NotationPromptPreview = { selection: NotationSelection; fullPrompt: string };

const defaultTemplate: PromptTemplate = {
  id: "math_faithful_v1",
  name: "数学忠实转写",
  content: defaultFaithfulTranscriptionPromptContent,
  builtIn: true,
  locked: true
};

export class AiGuidanceSettingsService {
  private promptConfig: PromptTemplateConfig = normalizePromptConfig({});
  private notationConfig: NotationProfileConfig = emptyNotationConfig();

  constructor(private readonly settingsRootDir: string) {}

  async start(): Promise<void> {
    this.promptConfig = await readJsonOr(this.promptPath(), normalizePromptConfig({}), normalizePromptConfig);
    this.notationConfig = await this.readNotationConfig();
  }

  readPromptTemplates(): PromptTemplateConfig { return structuredClone(this.promptConfig); }
  readNotationProfiles(): NotationProfileConfig { return structuredClone(this.notationConfig); }

  async savePromptTemplates(input: PromptTemplateConfig): Promise<PromptTemplateConfig> {
    this.promptConfig = normalizePromptConfig(input);
    await atomicWrite(this.promptPath(), {
      activeTemplateId: this.promptConfig.activeTemplateId,
      templates: this.promptConfig.templates.filter((template) => !template.builtIn)
    });
    return this.readPromptTemplates();
  }

  async saveNotationProfiles(input: NotationProfileConfig): Promise<NotationProfileConfig> {
    this.notationConfig = normalizeNotationConfig(input);
    const target = this.notationPath();
    await mkdir(dirname(target), { recursive: true });
    try { await copyFile(target, `${target}.bak`); } catch (error) { if (!isMissing(error)) throw error; }
    await atomicWrite(target, this.notationConfig);
    return this.readNotationProfiles();
  }

  activePromptTemplateContent(): string {
    return this.promptConfig.templates.find((item) => item.id === this.promptConfig.activeTemplateId)?.content
      ?? defaultTemplate.content;
  }

  notationSelection(query: string, limits: Omit<NotationPreviewInput, "query"> = {}): NotationSelection {
    return selectNotationRules(this.notationConfig, { query, ...limits });
  }

  previewNotation(input: NotationPreviewInput): NotationPromptPreview {
    const selection = this.notationSelection(input.query, input);
    return {
      selection,
      fullPrompt: buildFaithfulTranscriptionPrompt(
        input.query,
        this.activePromptTemplateContent(),
        selection.promptFragment
      )
    };
  }

  private promptPath(): string { return join(this.settingsRootDir, "promptTemplates.json"); }
  private notationPath(): string { return join(this.settingsRootDir, "notation", "profiles.json"); }
  private async readNotationConfig(): Promise<NotationProfileConfig> {
    const primary = await tryReadJson(this.notationPath(), normalizeNotationConfig);
    const backup = primary ?? await tryReadJson(`${this.notationPath()}.bak`, normalizeNotationConfig);
    return backup ?? emptyNotationConfig();
  }
}

function normalizePromptConfig(input: Partial<PromptTemplateConfig>): PromptTemplateConfig {
  const custom = (input.templates ?? [])
    .filter((item) => item.id !== defaultTemplate.id)
    .map<PromptTemplate | undefined>((item) => {
      const id = safeId(item.id, 64);
      const content = clean(item.content, 80_000);
      if (!id || !content) return undefined;
      return {
        id,
        name: clean(item.name, 120) || "未命名提示词",
        content,
        builtIn: false,
        locked: false,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      } satisfies PromptTemplate;
    })
    .filter((item): item is PromptTemplate => Boolean(item));
  const templates = [defaultTemplate, ...dedupeById(custom)];
  return {
    activeTemplateId: templates.some((item) => item.id === input.activeTemplateId)
      ? input.activeTemplateId ?? defaultTemplate.id
      : defaultTemplate.id,
    templates
  };
}

function emptyNotationConfig(): NotationProfileConfig { return { schemaVersion: "nh1-v1", revision: 1, profiles: [] }; }

function normalizeNotationConfig(input: Partial<NotationProfileConfig>): NotationProfileConfig {
  const profiles = dedupeById((input.profiles ?? []).map(normalizeProfile).filter((item): item is NotationProfile => Boolean(item)));
  return { schemaVersion: "nh1-v1", revision: clamp(input.revision, 1, 1, Number.MAX_SAFE_INTEGER), profiles };
}

function normalizeProfile(input: Partial<NotationProfile>): NotationProfile | undefined {
  const id = safeId(input.id, 80);
  const name = clean(input.name, 120);
  if (!id || !name) return undefined;
  const createdAt = safeDate(input.createdAt);
  return {
    id,
    name,
    description: clean(input.description, 500),
    enabled: input.enabled !== false,
    status: input.status === "retired" ? "retired" : "active",
    priority: clamp(input.priority, 0, -100, 100),
    version: clamp(input.version, 1, 1, Number.MAX_SAFE_INTEGER),
    rules: dedupeById((input.rules ?? []).map(normalizeRule).filter((item): item is NotationRule => Boolean(item))),
    createdAt,
    updatedAt: safeDate(input.updatedAt, createdAt)
  };
}

function normalizeRule(input: Partial<NotationRule>): NotationRule | undefined {
  const id = safeId(input.id, 80);
  const pattern = clean(input.pattern, 160);
  const meaning = clean(input.meaning, 500);
  if (!id || !pattern || !meaning) return undefined;
  const createdAt = safeDate(input.createdAt);
  const status: NotationRuleStatus = ["approved", "rejected", "retired"].includes(input.status ?? "")
    ? input.status as NotationRuleStatus
    : "candidate";
  const kind: NotationRuleKind = ["convention", "definition", "diagram_label"].includes(input.kind ?? "")
    ? input.kind as NotationRuleKind
    : "symbol";
  return {
    id, kind, pattern, meaning,
    aliases: stringList(input.aliases, 20, 160),
    keywords: stringList(input.keywords, 20, 80),
    enabled: input.enabled !== false,
    status,
    version: clamp(input.version, 1, 1, Number.MAX_SAFE_INTEGER),
    source: { type: "user" },
    createdAt,
    updatedAt: safeDate(input.updatedAt, createdAt),
    approvedAt: status === "approved" ? safeDate(input.approvedAt, createdAt) : undefined
  };
}

function selectNotationRules(config: NotationProfileConfig, input: NotationPreviewInput): NotationSelection {
  const query = input.query.trim();
  const normalizedQuery = normalizeText(query);
  const allowed = input.profileIds?.length ? new Set(input.profileIds) : undefined;
  const candidates = config.profiles
    .filter((profile) => profile.enabled && profile.status === "active" && (!allowed || allowed.has(profile.id)))
    .flatMap((profile) => profile.rules
      .filter((rule) => rule.enabled && rule.status === "approved")
      .map((rule) => ({ profile, rule, score: score(rule, normalizedQuery) })))
    .filter((entry) => !normalizedQuery || entry.score > 0);
  const conflicts = collectConflicts(candidates);
  const conflictPatterns = new Set(conflicts.map((item) => normalizePattern(item.pattern)));
  const ranked = candidates
    .filter((item) => !conflictPatterns.has(normalizePattern(item.rule.pattern)))
    .sort(compareCandidates);
  const seen = new Set<string>();
  const rules: NotationRuleReference[] = [];
  const maxRules = clamp(input.maxRules, 6, 1, 50);
  const maxCharacters = clamp(input.maxCharacters, 1200, 100, 20_000);
  let characterCount = 0;
  let omittedByBudget = 0;
  for (const entry of ranked) {
    const key = `${normalizePattern(entry.rule.pattern)}\u0000${normalizeText(entry.rule.meaning)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stable = {
      profileId: entry.profile.id, profileVersion: entry.profile.version,
      ruleId: entry.rule.id, ruleVersion: entry.rule.version,
      pattern: entry.rule.pattern.trim(), meaning: entry.rule.meaning.trim()
    };
    const reference = { ...stable, profileName: entry.profile.name.trim(), hash: hash(stable) };
    const length = formatReference(reference).length + (rules.length ? 1 : 0);
    if (rules.length >= maxRules || characterCount + length > maxCharacters) { omittedByBudget += 1; continue; }
    rules.push(reference);
    characterCount += length;
  }
  const promptFragment = buildNotationFragment(rules, conflicts);
  return {
    schemaVersion: "nh1-v1", query, rules, conflicts, omittedByBudget, characterCount,
    selectionHash: hash({ schemaVersion: "nh1-v1", query, rules, conflicts, omittedByBudget }),
    promptFragment
  };
}

function buildNotationFragment(rules: NotationRuleReference[], conflicts: NotationConflict[]): string {
  if (!rules.length && !conflicts.length) return "";
  const lines = [
    "领域消歧参考（只作辨认提示，图片证据优先）：",
    "不得为了符合这些习惯而改写图片；证据冲突或看不清时保留原样并使用 `[不确定：...]`。",
    ...rules.map((rule) => `- ${formatReference(rule)}`)
  ];
  if (conflicts.length) {
    lines.push("以下记号存在互相冲突的规则，已排除，不得自动选择含义：");
    lines.push(...conflicts.map((item) => `- ${item.pattern}：${item.meanings.join(" / ")}`));
  }
  return lines.join("\n");
}

function collectConflicts(entries: Array<{ profile: NotationProfile; rule: NotationRule; score: number }>): NotationConflict[] {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = normalizePattern(entry.rule.pattern);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()]
    .filter((group) => new Set(group.map((item) => normalizeText(item.rule.meaning))).size > 1)
    .map((group) => ({
      pattern: [...group].sort(compareCandidates)[0].rule.pattern,
      ruleIds: group.map((item) => item.rule.id).sort(),
      meanings: [...new Set(group.map((item) => item.rule.meaning.trim()))].sort((a, b) => a.localeCompare(b, "zh-CN"))
    }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern, "zh-CN"));
}

function score(rule: NotationRule, query: string): number {
  if (!query) return 1;
  const pattern = normalizeText(rule.pattern);
  if (pattern && query.includes(pattern)) return 400 + Math.min(pattern.length, 50);
  const alias = rule.aliases.map(normalizeText).filter((item) => item && query.includes(item)).sort((a, b) => b.length - a.length)[0];
  if (alias) return 300 + Math.min(alias.length, 50);
  const keywordCount = rule.keywords.filter((item) => query.includes(normalizeText(item))).length;
  if (keywordCount) return 100 + keywordCount;
  return query.includes(normalizeText(rule.meaning)) ? 50 : 0;
}

function compareCandidates(a: { profile: NotationProfile; rule: NotationRule; score: number }, b: { profile: NotationProfile; rule: NotationRule; score: number }): number {
  return b.score - a.score || b.profile.priority - a.profile.priority || a.rule.pattern.localeCompare(b.rule.pattern, "zh-CN") || a.profile.id.localeCompare(b.profile.id) || a.rule.id.localeCompare(b.rule.id);
}
function formatReference(rule: NotationRuleReference): string { return `\`${rule.pattern}\` 表示 ${rule.meaning}（${rule.profileName}）`; }
function normalizePattern(value: string): string { return normalizeText(value).replace(/\s+/g, ""); }
function normalizeText(value: string): string { return value.trim().normalize("NFKC").toLocaleLowerCase("zh-CN"); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeId(value: string | undefined, max: number): string { return (value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, max); }
function clean(value: string | undefined, max: number): string { return (value ?? "").trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max); }
function stringList(value: string[] | undefined, maxItems: number, maxLength: number): string[] { return [...new Set((value ?? []).map((item) => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems); }
function safeDate(value: string | undefined, fallback = new Date(0).toISOString()): string { return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback; }
function clamp(value: number | undefined, fallback: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value as number))) : fallback; }
function dedupeById<T extends { id: string }>(items: T[]): T[] { const seen = new Set<string>(); return items.filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id))); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
async function atomicWrite(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temp, path); }
async function tryReadJson<T>(path: string, normalize: (input: T) => T): Promise<T | undefined> { try { return normalize(JSON.parse(await readFile(path, "utf8")) as T); } catch (error) { if (isMissing(error) || error instanceof SyntaxError) return undefined; throw error; } }
async function readJsonOr<T>(path: string, fallback: T, normalize: (input: T) => T): Promise<T> { return await tryReadJson(path, normalize) ?? fallback; }

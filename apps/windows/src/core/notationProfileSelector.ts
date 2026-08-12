import { createHash } from "node:crypto";
import type {
  NotationConflict,
  NotationPreviewInput,
  NotationProfile,
  NotationProfileConfig,
  NotationRule,
  NotationRuleReference,
  NotationSelection
} from "../common/notationProfiles";
import { notationProfileSchemaVersion } from "../common/notationProfiles";

const defaultMaxRules = 6;
const defaultMaxCharacters = 1200;

type RankedRule = {
  profile: NotationProfile;
  rule: NotationRule;
  score: number;
};

export function selectNotationRules(config: NotationProfileConfig, input: NotationPreviewInput): NotationSelection {
  const query = input.query.trim();
  const normalizedQuery = normalizeSearchText(query);
  const allowedProfileIds = input.profileIds?.length ? new Set(input.profileIds) : undefined;
  const eligible = config.profiles
    .filter((profile) => profile.enabled && profile.status === "active" && (!allowedProfileIds || allowedProfileIds.has(profile.id)))
    .flatMap((profile) =>
      profile.rules
        .filter((rule) => rule.enabled && rule.status === "approved")
        .map((rule) => ({ profile, rule, score: scoreRule(rule, normalizedQuery) }))
    )
    .filter((entry) => !normalizedQuery || entry.score > 0);

  const conflicts = collectConflicts(eligible);
  const conflictingPatterns = new Set(conflicts.map((conflict) => normalizePattern(conflict.pattern)));
  const ranked = dedupeRules(eligible.filter((entry) => !conflictingPatterns.has(normalizePattern(entry.rule.pattern)))).sort(compareRankedRules);
  const maxRules = clampInteger(input.maxRules, defaultMaxRules, 1, 50);
  const maxCharacters = clampInteger(input.maxCharacters, defaultMaxCharacters, 100, 20_000);
  const selected: NotationRuleReference[] = [];
  let characterCount = 0;
  let omittedByBudget = 0;

  for (const entry of ranked) {
    const reference = toReference(entry);
    const lineLength = formatReference(reference).length + (selected.length ? 1 : 0);
    if (selected.length >= maxRules || characterCount + lineLength > maxCharacters) {
      omittedByBudget += 1;
      continue;
    }
    selected.push(reference);
    characterCount += lineLength;
  }

  const promptFragment = buildNotationReferencePrompt(selected, conflicts);
  const selectionHash = hashJson({
    schemaVersion: notationProfileSchemaVersion,
    query,
    rules: selected,
    conflicts,
    omittedByBudget
  });

  return {
    schemaVersion: notationProfileSchemaVersion,
    query,
    rules: selected,
    conflicts,
    omittedByBudget,
    characterCount,
    selectionHash,
    promptFragment
  };
}

export function buildNotationReferencePrompt(rules: NotationRuleReference[], conflicts: NotationConflict[]): string {
  if (rules.length === 0 && conflicts.length === 0) return "";
  const lines = [
    "领域消歧参考（只作辨认提示，图片证据优先）：",
    "不得为了符合这些习惯而改写图片；证据冲突或看不清时保留原样并使用 `[不确定：...]`。"
  ];
  if (rules.length > 0) {
    lines.push(...rules.map((rule) => `- ${formatReference(rule)}`));
  }
  if (conflicts.length > 0) {
    lines.push("以下记号存在互相冲突的规则，已排除，不得自动选择含义：");
    lines.push(...conflicts.map((conflict) => `- ${conflict.pattern}：${conflict.meanings.join(" / ")}`));
  }
  return lines.join("\n");
}

function scoreRule(rule: NotationRule, query: string): number {
  if (!query) return 1;
  const pattern = normalizeSearchText(rule.pattern);
  if (pattern && query.includes(pattern)) return 400 + Math.min(pattern.length, 50);
  const matchingAlias = rule.aliases
    .map(normalizeSearchText)
    .filter(Boolean)
    .filter((alias) => query.includes(alias))
    .sort((left, right) => right.length - left.length)[0];
  if (matchingAlias) return 300 + Math.min(matchingAlias.length, 50);
  const keywordMatches = rule.keywords.filter((keyword) => query.includes(normalizeSearchText(keyword))).length;
  if (keywordMatches > 0) return 100 + keywordMatches;
  if (query.includes(normalizeSearchText(rule.meaning))) return 50;
  return 0;
}

function collectConflicts(entries: RankedRule[]): NotationConflict[] {
  const grouped = new Map<string, RankedRule[]>();
  for (const entry of entries) {
    const key = normalizePattern(entry.rule.pattern);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.values()]
    .filter((group) => new Set(group.map((entry) => normalizeSearchText(entry.rule.meaning))).size > 1)
    .map((group) => ({
      pattern: [...group].sort(compareRankedRules)[0].rule.pattern,
      ruleIds: group.map((entry) => entry.rule.id).sort(),
      meanings: [...new Set(group.map((entry) => entry.rule.meaning.trim()))].sort((left, right) => left.localeCompare(right, "zh-CN"))
    }))
    .sort((left, right) => left.pattern.localeCompare(right.pattern, "zh-CN"));
}

function dedupeRules(entries: RankedRule[]): RankedRule[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${normalizePattern(entry.rule.pattern)}\u0000${normalizeSearchText(entry.rule.meaning)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareRankedRules(left: RankedRule, right: RankedRule): number {
  return (
    right.score - left.score ||
    right.profile.priority - left.profile.priority ||
    left.rule.pattern.localeCompare(right.rule.pattern, "zh-CN") ||
    left.profile.id.localeCompare(right.profile.id) ||
    left.rule.id.localeCompare(right.rule.id)
  );
}

function toReference(entry: RankedRule): NotationRuleReference {
  const stable = {
    profileId: entry.profile.id,
    profileVersion: entry.profile.version,
    ruleId: entry.rule.id,
    ruleVersion: entry.rule.version,
    pattern: entry.rule.pattern.trim(),
    meaning: entry.rule.meaning.trim()
  };
  return {
    ...stable,
    profileName: entry.profile.name.trim(),
    hash: hashJson(stable)
  };
}

function formatReference(rule: NotationRuleReference): string {
  return `\`${rule.pattern}\` 表示 ${rule.meaning}（${rule.profileName}）`;
}

function normalizePattern(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function normalizeSearchText(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

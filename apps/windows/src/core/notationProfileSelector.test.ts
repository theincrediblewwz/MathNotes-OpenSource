import { describe, expect, it } from "vitest";
import type { NotationProfileConfig } from "../common/notationProfiles";
import { selectNotationRules } from "./notationProfileSelector";

const now = "2026-07-15T08:00:00.000Z";

describe("notationProfileSelector", () => {
  it("only selects enabled approved rules and produces stable hashes", () => {
    const config = fixtureConfig();
    const first = selectNotationRules(config, { query: "这里出现 X_+ 和稳定子空间" });
    const second = selectNotationRules(config, { query: "这里出现 X_+ 和稳定子空间" });

    expect(first).toEqual(second);
    expect(first.rules.map((rule) => rule.ruleId)).toEqual(["stable_space"]);
    expect(first.rules[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.selectionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.promptFragment).toContain("图片证据优先");
    expect(first.promptFragment).toContain("[不确定：...]");
  });

  it("reports conflicting meanings and excludes the conflicted pattern", () => {
    const config = fixtureConfig();
    config.profiles.push({
      ...config.profiles[0],
      id: "other_field",
      name: "另一套记号",
      priority: 5,
      rules: [approvedRule("unstable_conflict", "X_+", "不稳定子空间")]
    });

    const selected = selectNotationRules(config, { query: "X_+" });

    expect(selected.rules).toEqual([]);
    expect(selected.conflicts).toEqual([
      {
        pattern: "X_+",
        ruleIds: ["stable_space", "unstable_conflict"],
        meanings: ["不稳定子空间", "稳定子空间"]
      }
    ]);
    expect(selected.promptFragment).toContain("已排除");
  });

  it("uses deterministic ranking, deduplication and bounded budgets", () => {
    const config = fixtureConfig();
    config.profiles[0].rules.push(
      approvedRule("operator_a", "A", "生成元", ["generator"]),
      approvedRule("operator_b", "B", "边界算子", ["boundary"]),
      approvedRule("operator_a_duplicate", "A", "生成元", ["generator"])
    );

    const selected = selectNotationRules(config, {
      query: "X_+ A generator B boundary",
      maxRules: 2,
      maxCharacters: 1200
    });

    expect(selected.rules.map((rule) => rule.ruleId)).toEqual(["stable_space", "operator_a"]);
    expect(selected.omittedByBudget).toBe(1);
    expect(selected.characterCount).toBeLessThanOrEqual(1200);
  });
});

function fixtureConfig(): NotationProfileConfig {
  return {
    schemaVersion: "nh1-v1",
    revision: 1,
    profiles: [
      {
        id: "dynamical_systems",
        name: "动力系统",
        description: "课堂记号",
        enabled: true,
        status: "active",
        priority: 10,
        version: 1,
        createdAt: now,
        updatedAt: now,
        rules: [
          approvedRule("stable_space", "X_+", "稳定子空间", ["稳定子空间"]),
          { ...approvedRule("candidate_rule", "Y", "候选"), status: "candidate" },
          { ...approvedRule("disabled_rule", "Z", "已停用"), enabled: false },
          { ...approvedRule("retired_rule", "W", "已退役"), status: "retired" }
        ]
      }
    ]
  };
}

function approvedRule(id: string, pattern: string, meaning: string, keywords: string[] = []) {
  return {
    id,
    kind: "symbol" as const,
    pattern,
    meaning,
    aliases: [],
    keywords,
    enabled: true,
    status: "approved" as const,
    version: 1,
    source: { type: "user" as const },
    createdAt: now,
    updatedAt: now,
    approvedAt: now
  };
}

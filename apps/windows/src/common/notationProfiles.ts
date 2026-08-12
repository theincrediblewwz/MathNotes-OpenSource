export const notationProfileSchemaVersion = "nh1-v1" as const;

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
  source: {
    type: "user";
  };
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

export type NotationProfileConfig = {
  schemaVersion: typeof notationProfileSchemaVersion;
  revision: number;
  profiles: NotationProfile[];
};

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

export type NotationConflict = {
  pattern: string;
  ruleIds: string[];
  meanings: string[];
};

export type NotationSelection = {
  schemaVersion: typeof notationProfileSchemaVersion;
  query: string;
  rules: NotationRuleReference[];
  conflicts: NotationConflict[];
  omittedByBudget: number;
  characterCount: number;
  selectionHash: string;
  promptFragment: string;
};

export type NotationPreviewInput = {
  query: string;
  profileIds?: string[];
  maxRules?: number;
  maxCharacters?: number;
  config?: NotationProfileConfig;
};

export type NotationPromptPreview = {
  selection: NotationSelection;
  fullPrompt: string;
};

export function createEmptyNotationProfileConfig(): NotationProfileConfig {
  return {
    schemaVersion: notationProfileSchemaVersion,
    revision: 1,
    profiles: []
  };
}

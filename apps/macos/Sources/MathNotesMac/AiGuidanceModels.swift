import Foundation

struct MacPromptTemplate: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var content: String
    var builtIn: Bool?
    var locked: Bool?
    var createdAt: String?
    var updatedAt: String?
}

struct MacPromptTemplateConfig: Codable, Equatable, Sendable {
    var activeTemplateId: String
    var templates: [MacPromptTemplate]
}

struct MacNotationRuleSource: Codable, Equatable, Sendable { var type: String = "user" }

struct MacNotationRule: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var kind: String
    var pattern: String
    var meaning: String
    var aliases: [String]
    var keywords: [String]
    var enabled: Bool
    var status: String
    var version: Int
    var source: MacNotationRuleSource
    var createdAt: String
    var updatedAt: String
    var approvedAt: String?
}

struct MacNotationProfile: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var description: String
    var enabled: Bool
    var status: String
    var priority: Int
    var version: Int
    var rules: [MacNotationRule]
    var createdAt: String
    var updatedAt: String
}

struct MacNotationProfileConfig: Codable, Equatable, Sendable {
    var schemaVersion: String
    var revision: Int
    var profiles: [MacNotationProfile]
}

struct MacNotationPreviewRequest: Codable, Sendable {
    var query: String
    var profileIds: [String]?
    var maxRules: Int? = 6
    var maxCharacters: Int? = 1200
}

struct MacNotationConflict: Codable, Equatable, Sendable {
    var pattern: String
    var ruleIds: [String]
    var meanings: [String]
}

struct MacNotationSelection: Codable, Equatable, Sendable {
    var query: String
    var conflicts: [MacNotationConflict]
    var omittedByBudget: Int
    var characterCount: Int
    var selectionHash: String
    var promptFragment: String
}

struct MacNotationPromptPreview: Codable, Equatable, Sendable {
    var selection: MacNotationSelection
    var fullPrompt: String
}

extension MacPromptTemplate {
    static func userDraft() -> MacPromptTemplate {
        let now = ISO8601DateFormatter().string(from: Date())
        return MacPromptTemplate(
            id: "prompt_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())",
            name: "新提示词",
            content: "请忠实转写图片内容为 Markdown。",
            builtIn: false,
            locked: false,
            createdAt: now,
            updatedAt: now
        )
    }
}

extension MacNotationProfile {
    static func userDraft() -> MacNotationProfile {
        let now = ISO8601DateFormatter().string(from: Date())
        return MacNotationProfile(
            id: "profile_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())",
            name: "新领域",
            description: "",
            enabled: true,
            status: "active",
            priority: 0,
            version: 1,
            rules: [],
            createdAt: now,
            updatedAt: now
        )
    }
}

extension MacNotationRule {
    static func userDraft() -> MacNotationRule {
        let now = ISO8601DateFormatter().string(from: Date())
        return MacNotationRule(
            id: "rule_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())",
            kind: "symbol",
            pattern: "",
            meaning: "",
            aliases: [],
            keywords: [],
            enabled: true,
            status: "candidate",
            version: 1,
            source: MacNotationRuleSource(),
            createdAt: now,
            updatedAt: now,
            approvedAt: nil
        )
    }
}

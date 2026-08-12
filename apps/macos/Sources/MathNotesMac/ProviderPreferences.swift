import Foundation

enum ProviderPreset: String, Codable, CaseIterable, Identifiable, Sendable {
    case mimo = "mimo_2_5"
    case glm = "glm_5_2"
    case openAI = "openai_vision"
    case gemini
    case qwen
    case deepSeek = "deepseek"
    case custom = "custom_openai_compatible"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .mimo: "Mimo v2.5"
        case .glm: "GLM 5.2"
        case .openAI: "OpenAI Vision"
        case .gemini: "Gemini"
        case .qwen: "Qwen"
        case .deepSeek: "DeepSeek"
        case .custom: "自定义 OpenAI 兼容服务"
        }
    }
    var defaultModel: String {
        switch self {
        case .mimo: "mimo-v2.5"
        case .glm: "glm-5.2"
        case .openAI: "gpt-4.1-mini"
        case .gemini: "gemini-2.5-flash"
        case .qwen: "qwen3.7-plus"
        case .deepSeek: "deepseek-v4-flash"
        case .custom: ""
        }
    }
    var defaultEndpoint: String {
        switch self {
        case .mimo: "https://api.xiaomimimo.com/v1"
        case .glm: "https://api.z.ai/api/paas/v4/chat/completions"
        case .openAI: "https://api.openai.com/v1"
        case .gemini: "https://generativelanguage.googleapis.com/v1beta/openai"
        case .qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1"
        case .deepSeek: "https://api.deepseek.com"
        case .custom: ""
        }
    }

    var supportsRecognition: Bool { self != .deepSeek }
    var exposesEndpoint: Bool { self == .custom }

    static func options(for purpose: ProviderPurpose) -> [ProviderPreset] {
        allCases.filter { purpose == .assistant || $0.supportsRecognition }
    }
}

struct ProviderPreferenceRecord: Codable, Equatable, Sendable {
    let providerId: ProviderPreset
    let model: String
    let endpoint: String
}

enum ProviderPurpose: String, CaseIterable, Equatable, Sendable {
    case recognition
    case assistant

    var label: String { self == .recognition ? "识别模型" : "对话模型" }
    func keychainAccount(for preset: ProviderPreset) -> String { "\(rawValue):\(preset.rawValue)" }
}

enum ProviderPreferences {
    private static let legacyKey = "mathnotes.provider.settings.v1"
    private static func key(_ purpose: ProviderPurpose) -> String {
        purpose == .recognition ? legacyKey : "mathnotes.provider.assistant.settings.v1"
    }

    static func load(_ purpose: ProviderPurpose = .recognition, defaults: UserDefaults = .standard) -> ProviderPreferenceRecord? {
        guard let data = defaults.data(forKey: key(purpose)) else { return nil }
        return try? JSONDecoder().decode(ProviderPreferenceRecord.self, from: data)
    }

    static func save(_ record: ProviderPreferenceRecord, purpose: ProviderPurpose = .recognition, defaults: UserDefaults = .standard) throws {
        defaults.set(try JSONEncoder().encode(record), forKey: key(purpose))
    }

    static func clear(_ purpose: ProviderPurpose = .recognition, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key(purpose))
    }
}

enum ProviderSettingsError: LocalizedError {
    case missingAPIKey

    var errorDescription: String? { "请填写 API 密钥。" }
}

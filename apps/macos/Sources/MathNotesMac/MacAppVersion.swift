import Foundation

struct MacAppVersion {
    static let current = MacAppVersion(info: Bundle.main.infoDictionary ?? [:])

    let version: String
    let build: String

    init(info: [String: Any]) {
        version = Self.nonempty(info["CFBundleShortVersionString"]) ?? "开发版本"
        build = Self.nonempty(info["MathNotesBuildRevision"])
            ?? Self.nonempty(info["CFBundleVersion"])
            ?? "未记录"
    }

    var copyText: String { "MathNotes macOS\n版本：\(version)\n构建：\(build)" }

    private static func nonempty(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

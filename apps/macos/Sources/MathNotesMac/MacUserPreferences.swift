import AppKit
import Foundation
import SwiftUI

@MainActor
final class AppEditingState: ObservableObject {
    @Published var hasUnsavedSourceDrafts = false
}

enum MacPreferenceKeys {
    static let sourceFont = "mathnotes.typography.sourceFont"
    static let sourceFontSize = "mathnotes.typography.sourceFontSize"
    static let previewFont = "mathnotes.typography.previewFont"
    static let previewFontSize = "mathnotes.typography.previewFontSize"
    static let assistantFont = "mathnotes.typography.assistantFont"
    static let assistantFontSize = "mathnotes.typography.assistantFontSize"
    static let assistantPanelWidth = "mathnotes.assistant.panelWidth"
    static let assistantPanelHeight = "mathnotes.assistant.panelHeight"
    static let materialOpacity = "mathnotes.appearance.materialOpacity"
    static let materialBlur = "mathnotes.appearance.materialBlur"
}

enum MacSourceFontPreset: String, CaseIterable, Identifiable {
    case systemMono
    case menlo
    case monaco

    var id: String { rawValue }

    var label: String {
        switch self {
        case .systemMono: "系统等宽"
        case .menlo: "Menlo"
        case .monaco: "Monaco"
        }
    }

    func font(size: Double) -> Font {
        switch self {
        case .systemMono: .system(size: CGFloat(size), design: .monospaced)
        case .menlo: .custom("Menlo", size: CGFloat(size))
        case .monaco: .custom("Monaco", size: CGFloat(size))
        }
    }
}

enum MacPreviewFontPreset: String, CaseIterable, Identifiable {
    case system
    case newYork
    case helvetica

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "系统字体"
        case .newYork: "New York"
        case .helvetica: "Helvetica Neue"
        }
    }

    var cssFamily: String {
        switch self {
        case .system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
        case .newYork: "'New York', Georgia, serif"
        case .helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif"
        }
    }

    func font(size: Double) -> Font {
        switch self {
        case .system: .system(size: CGFloat(size))
        case .newYork: .custom("New York", size: CGFloat(size))
        case .helvetica: .custom("Helvetica Neue", size: CGFloat(size))
        }
    }
}

enum DirectoryPreferenceKind: String {
    case notesRoot
    case defaultExport

    var pathKey: String { "mathnotes.directory.\(rawValue).path" }
    var bookmarkKey: String { "mathnotes.directory.\(rawValue).bookmark" }
}

struct DirectoryPreferenceSnapshot {
    let path: String?
    let bookmark: Data?
}

enum DirectoryBookmarkStore {
    static func resolvedURL(
        for kind: DirectoryPreferenceKind,
        defaults: UserDefaults = .standard
    ) -> URL? {
        if let bookmark = defaults.data(forKey: kind.bookmarkKey) {
            var isStale = false
            if let url = try? URL(
                resolvingBookmarkData: bookmark,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            ) {
                if isStale { try? save(url, for: kind, defaults: defaults) }
                return url
            }
        }
        guard let path = defaults.string(forKey: kind.pathKey), !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    static func save(
        _ url: URL,
        for kind: DirectoryPreferenceKind,
        defaults: UserDefaults = .standard
    ) throws {
        let standardized = url.standardizedFileURL
        let bookmark = try standardized.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: [.isDirectoryKey],
            relativeTo: nil
        )
        defaults.set(standardized.path, forKey: kind.pathKey)
        defaults.set(bookmark, forKey: kind.bookmarkKey)
    }

    static func clear(_ kind: DirectoryPreferenceKind, defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: kind.pathKey)
        defaults.removeObject(forKey: kind.bookmarkKey)
    }

    static func snapshot(
        _ kind: DirectoryPreferenceKind,
        defaults: UserDefaults = .standard
    ) -> DirectoryPreferenceSnapshot {
        DirectoryPreferenceSnapshot(
            path: defaults.string(forKey: kind.pathKey),
            bookmark: defaults.data(forKey: kind.bookmarkKey)
        )
    }

    static func restore(
        _ snapshot: DirectoryPreferenceSnapshot,
        for kind: DirectoryPreferenceKind,
        defaults: UserDefaults = .standard
    ) {
        if let path = snapshot.path { defaults.set(path, forKey: kind.pathKey) }
        else { defaults.removeObject(forKey: kind.pathKey) }
        if let bookmark = snapshot.bookmark { defaults.set(bookmark, forKey: kind.bookmarkKey) }
        else { defaults.removeObject(forKey: kind.bookmarkKey) }
    }
}

enum MacTypographyPreferences {
    static let defaultSourceSize = 13.0
    static let defaultPreviewSize = 16.0
    static let defaultAssistantSize = 16.0

    static func sourcePreset(defaults: UserDefaults = .standard) -> MacSourceFontPreset {
        MacSourceFontPreset(rawValue: defaults.string(forKey: MacPreferenceKeys.sourceFont) ?? "") ?? .systemMono
    }

    static func previewPreset(defaults: UserDefaults = .standard) -> MacPreviewFontPreset {
        MacPreviewFontPreset(rawValue: defaults.string(forKey: MacPreferenceKeys.previewFont) ?? "") ?? .system
    }

    static func sourceSize(defaults: UserDefaults = .standard) -> Double {
        let value = defaults.double(forKey: MacPreferenceKeys.sourceFontSize)
        return value == 0 ? defaultSourceSize : min(24, max(10, value))
    }

    static func previewSize(defaults: UserDefaults = .standard) -> Double {
        let value = defaults.double(forKey: MacPreferenceKeys.previewFontSize)
        return value == 0 ? defaultPreviewSize : min(28, max(12, value))
    }

    static func assistantPreset(defaults: UserDefaults = .standard) -> MacPreviewFontPreset {
        MacPreviewFontPreset(rawValue: defaults.string(forKey: MacPreferenceKeys.assistantFont) ?? "") ?? .system
    }

    static func assistantSize(defaults: UserDefaults = .standard) -> Double {
        let value = defaults.double(forKey: MacPreferenceKeys.assistantFontSize)
        return value == 0 ? defaultAssistantSize : min(28, max(12, value))
    }

    static func save(
        sourcePreset: MacSourceFontPreset,
        sourceSize: Double,
        previewPreset: MacPreviewFontPreset,
        previewSize: Double,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(sourcePreset.rawValue, forKey: MacPreferenceKeys.sourceFont)
        defaults.set(min(24, max(10, sourceSize)), forKey: MacPreferenceKeys.sourceFontSize)
        defaults.set(previewPreset.rawValue, forKey: MacPreferenceKeys.previewFont)
        defaults.set(min(28, max(12, previewSize)), forKey: MacPreferenceKeys.previewFontSize)
    }

    static func styledPreviewHTML(_ html: String, preset: MacPreviewFontPreset, size: Double) -> String {
        let style = "<style id=\"mathnotes-user-typography\">html,body{font-family:\(preset.cssFamily);font-size:\(min(28, max(12, size)))px;}</style>"
        if let range = html.range(of: "</head>", options: .caseInsensitive) {
            var result = html
            result.insert(contentsOf: style, at: range.lowerBound)
            return result
        }
        return style + html
    }

    static func saveAssistant(
        preset: MacPreviewFontPreset,
        size: Double,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(preset.rawValue, forKey: MacPreferenceKeys.assistantFont)
        defaults.set(min(28, max(12, size)), forKey: MacPreferenceKeys.assistantFontSize)
    }

    static func styledAssistantHTML(_ html: String, preset: MacPreviewFontPreset, size: Double) -> String {
        let style = "<style id=\"mathnotes-assistant-typography\">html,body{font-family:\(preset.cssFamily);font-size:\(min(28, max(12, size)))px;} .katex{font-family:KaTeX_Main,serif;}</style>"
        if let range = html.range(of: "</head>", options: .caseInsensitive) {
            var result = html
            result.insert(contentsOf: style, at: range.lowerBound)
            return result
        }
        return style + html
    }
}

enum MacMaterialPreferences {
    static let defaultOpacity = 0.82
    static let defaultBlur = 0.62

    static func opacity(defaults: UserDefaults = .standard) -> Double {
        let value = defaults.object(forKey: MacPreferenceKeys.materialOpacity) as? Double
        return min(1, max(0.45, value ?? defaultOpacity))
    }

    static func blur(defaults: UserDefaults = .standard) -> Double {
        let value = defaults.object(forKey: MacPreferenceKeys.materialBlur) as? Double
        return min(1, max(0, value ?? defaultBlur))
    }

    static func save(
        opacity: Double,
        blur: Double,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(min(1, max(0.45, opacity)), forKey: MacPreferenceKeys.materialOpacity)
        defaults.set(min(1, max(0, blur)), forKey: MacPreferenceKeys.materialBlur)
    }
}

enum MacAssistantPanelPreferences {
    static func width(defaults: UserDefaults = .standard) -> Double {
        let value = defaults.double(forKey: MacPreferenceKeys.assistantPanelWidth)
        return min(760, max(380, value == 0 ? 500 : value))
    }

    static func height(defaults: UserDefaults = .standard) -> Double {
        let value = defaults.double(forKey: MacPreferenceKeys.assistantPanelHeight)
        return min(900, max(420, value == 0 ? 640 : value))
    }

    static func save(width: Double, height: Double, defaults: UserDefaults = .standard) {
        defaults.set(min(760, max(380, width)), forKey: MacPreferenceKeys.assistantPanelWidth)
        defaults.set(min(900, max(420, height)), forKey: MacPreferenceKeys.assistantPanelHeight)
    }
}

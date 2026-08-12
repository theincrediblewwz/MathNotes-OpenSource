import SwiftUI

enum AppAppearanceMode: String, CaseIterable, Identifiable {
    static let storageKey = "mathnotes.appearanceMode"

    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }

    var preferredColorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    static func load(defaults: UserDefaults = .standard) -> AppAppearanceMode {
        guard let rawValue = defaults.string(forKey: storageKey),
              let mode = AppAppearanceMode(rawValue: rawValue) else {
            return .system
        }
        return mode
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.storageKey)
    }
}

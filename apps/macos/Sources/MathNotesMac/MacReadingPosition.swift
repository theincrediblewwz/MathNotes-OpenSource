import Foundation

struct BlockNavigationRequest: Equatable {
    let id = UUID()
    let blockID: String
}

struct MacReadingPosition: Codable, Equatable {
    let blockID: String
    let fraction: Double
    var updatedAt = Date().timeIntervalSince1970
}

enum MacReadingPositionStore {
    private static let storageKey = "mathnotes.reading-positions.v1"

    static func key(source: String, hostID: String?, notebookID: String, sessionID: String) -> String {
        // JSON preserves component boundaries even for imported names containing separators.
        let parts = [source, hostID ?? "", notebookID, sessionID]
        return String(data: try! JSONEncoder().encode(parts), encoding: .utf8)!
    }

    static func load(_ key: String, defaults: UserDefaults = .standard) -> MacReadingPosition? {
        let position = entries(defaults)[key]
        guard let position, !position.blockID.isEmpty, position.fraction.isFinite,
              (0...1).contains(position.fraction) else { return nil }
        return position
    }

    static func save(_ position: MacReadingPosition, key: String, defaults: UserDefaults = .standard) {
        guard !position.blockID.isEmpty, position.fraction.isFinite, (0...1).contains(position.fraction) else { return }
        var values = entries(defaults)
        values[key] = position
        let recent = values.sorted { $0.value.updatedAt > $1.value.updatedAt }
        let bounded = Dictionary(uniqueKeysWithValues: recent.prefix(256).map { ($0.key, $0.value) })
        if let data = try? JSONEncoder().encode(bounded) { defaults.set(data, forKey: storageKey) }
    }

    private static func entries(_ defaults: UserDefaults) -> [String: MacReadingPosition] {
        guard let data = defaults.data(forKey: storageKey),
              let values = try? JSONDecoder().decode([String: MacReadingPosition].self, from: data) else { return [:] }
        return values
    }
}

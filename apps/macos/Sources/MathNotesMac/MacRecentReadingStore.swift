import Foundation

struct MacRecentReadingEntry: Codable, Equatable, Identifiable, Sendable {
    let sourceRawValue: String
    var hostId: String? = nil
    let notebookId: String
    let notebookTitle: String
    let sessionId: String
    let sessionTitle: String
    let openedAt: TimeInterval

    var id: String { "\(sourceRawValue):\(hostId.map { $0 + ":" } ?? "")\(notebookId)/\(sessionId)" }
}

enum MacRecentReadingStore {
    static let storageKey = "mathnotes.recent-reading.v1"
    static let maximumStoredCount = 24
    static let sidebarCount = 4

    static func load(defaults: UserDefaults = .standard) -> [MacRecentReadingEntry] {
        guard let data = defaults.data(forKey: storageKey),
              let entries = try? JSONDecoder().decode([MacRecentReadingEntry].self, from: data) else {
            return []
        }
        return Array(entries.sorted { $0.openedAt > $1.openedAt }.prefix(maximumStoredCount))
    }

    static func save(_ entries: [MacRecentReadingEntry], defaults: UserDefaults = .standard) {
        let bounded = Array(entries.sorted { $0.openedAt > $1.openedAt }.prefix(maximumStoredCount))
        guard let data = try? JSONEncoder().encode(bounded) else { return }
        defaults.set(data, forKey: storageKey)
    }

    static func recording(
        session: SessionCatalogItem,
        notebookTitle: String,
        source: WorkspaceSourceMode,
        hostId: String? = nil,
        now: Date = Date(),
        in entries: [MacRecentReadingEntry]
    ) -> [MacRecentReadingEntry] {
        let next = MacRecentReadingEntry(
            sourceRawValue: source.rawValue,
            hostId: hostId,
            notebookId: session.notebookId,
            notebookTitle: notebookTitle,
            sessionId: session.sessionId,
            sessionTitle: session.title,
            openedAt: now.timeIntervalSince1970
        )
        let remaining = entries.filter { $0.id != next.id }
        return Array(([next] + remaining).prefix(maximumStoredCount))
    }
}

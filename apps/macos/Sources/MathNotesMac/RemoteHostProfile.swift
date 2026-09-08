import Foundation

struct RemoteHostProfile: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var name: String
    var origin: String

    static let storageKey = "mathnotes.remote-hosts.v1"
    static let selectionKey = "mathnotes.remote-host-selection.v1"

    static func load(defaults: UserDefaults = .standard) -> [Self] {
        guard let data = defaults.data(forKey: storageKey),
              let profiles = try? JSONDecoder().decode([Self].self, from: data) else { return [] }
        var seen = Set<String>()
        return profiles.filter { UUID(uuidString: $0.id) != nil && seen.insert($0.id).inserted }
    }
    static func save(_ profiles: [Self], defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(profiles) else { return }
        defaults.set(data, forKey: storageKey)
    }
    var directory: URL {
        let root: URL
        if let isolated = ProcessInfo.processInfo.environment["MATHNOTES_PHASE1A_ROOT"] {
            root = URL(fileURLWithPath: isolated)
        } else {
            root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appending(path: "MathNotes")
        }
        return root.appending(path: "RemoteLibraries").appending(path: id)
    }
}

extension Notification.Name {
    static let mathNotesWorkspaceChanged = Notification.Name("MathNotes.workspaceChanged")
}

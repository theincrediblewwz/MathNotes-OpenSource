import SwiftUI

// Real product views, isolated runtime and in-memory synthetic credentials.
// UI interactions are performed separately through CUA, never by this harness.
@main
struct RemoteAcceptanceApp: App {
    @StateObject private var supervisor: SidecarSupervisor
    @StateObject private var companionReader: CompanionReaderStore
    @StateObject private var editingState = AppEditingState()
    @StateObject private var assistantWindow = SessionAssistantWindowCoordinator()

    init() {
        let root = ProcessInfo.processInfo.environment["MATHNOTES_ACCEPTANCE_ROOT"]!
        let fixture = try! JSONDecoder().decode(Fixture.self,
            from: Data(contentsOf: URL(fileURLWithPath: root + "/host-ready.json")))
        _supervisor = StateObject(wrappedValue: SidecarSupervisor(configuration: Self.configuration(root + "/local")))
        _companionReader = StateObject(wrappedValue: CompanionReaderStore(credentialProvider: {
            (origin: fixture.origin, token: fixture.token)
        }, profileDefaults: .standard, replicaConfiguration: { hostID in
            Self.configuration(root + "/RemoteLibraries/" + hostID, replicaID: hostID)
        }))
    }
    var body: some Scene {
        WindowGroup("MathNotes 远程目录验收") {
            ContentView(supervisor: supervisor, companionReader: companionReader,
                editingState: editingState, assistantWindow: assistantWindow)
        }
        .defaultSize(width: 1120, height: 720)
        .windowResizability(.contentMinSize)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
    private struct Fixture: Decodable { var origin: String; var token: String }
    private static func configuration(_ root: String, replicaID: String? = nil) -> SidecarConfiguration {
        let token = UUID().uuidString + UUID().uuidString
        let runtime = Bundle.main.resourceURL!.appending(path: "MathNotesRuntime")
        var environment = ["PATH": "/usr/bin:/bin", "MATHNOTES_LOCAL_TOKEN": token,
            "MATHNOTES_COMPANION_ENABLED": "0", "MATHNOTES_USER_DATA_DIR": root + "/data",
            "MATHNOTES_NOTES_ROOT_DIR": root + "/notes", "MATHNOTES_TEMP_DIR": root + "/temp",
            "MATHNOTES_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier)]
        if let replicaID { environment["MATHNOTES_REPLICA_HOST_ID"] = replicaID }
        return SidecarConfiguration(executableURL: runtime.appending(path: "bin/node"),
            arguments: [runtime.appending(path: "core-server.mjs").path], environment: environment, token: token, companionHostToken: token)
    }
}

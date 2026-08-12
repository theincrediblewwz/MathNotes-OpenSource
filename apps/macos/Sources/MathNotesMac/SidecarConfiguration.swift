import Foundation

struct SidecarConfiguration: Sendable {
    let executableURL: URL
    let arguments: [String]
    let environment: [String: String]
    let token: String
    let companionHostToken: String

    static func development(
        notesRootURL: URL? = nil,
        environment source: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> Self {
        let fileManager = FileManager.default
        let repositoryRoot = source["MATHNOTES_REPO_ROOT"] ?? fileManager.currentDirectoryPath
        let bundledRuntime = Bundle.main.resourceURL?.appending(path: "MathNotesRuntime")
        let bundledScript = bundledRuntime?.appending(path: "core-server.mjs").path
        let repositoryScript = URL(fileURLWithPath: repositoryRoot)
            .appending(path: "output/macos-sidecar/core-server.mjs").path
        let script = source["MATHNOTES_SIDECAR_SCRIPT"]
            ?? bundledScript.flatMap { fileManager.fileExists(atPath: $0) ? $0 : nil }
            ?? repositoryScript
        guard fileManager.fileExists(atPath: script) else {
            throw ConfigurationError.sidecarMissing(script)
        }

        let configuredNode = source["MATHNOTES_NODE_EXECUTABLE"]
        let bundledNode = bundledRuntime?.appending(path: "bin/node").path
        let nodeExecutable = configuredNode
            ?? bundledNode.flatMap { fileManager.isExecutableFile(atPath: $0) ? $0 : nil }
        let developmentRoot = source["MATHNOTES_PHASE1A_ROOT"]
            ?? fileManager.homeDirectoryForCurrentUser.appending(path: "data/MathNotes-dev/phase1a").path
        let token = source["MATHNOTES_LOCAL_TOKEN"] ?? "\(UUID().uuidString)\(UUID().uuidString)"
        let companionHostToken = try resolveCompanionHostToken(environment: source)
        let bundledPWA = Bundle.main.resourceURL?.appending(path: "MathNotesPWA")
        let repositoryPWA = URL(fileURLWithPath: repositoryRoot).appending(path: "apps/pwa/dist")
        let pwaRoot = source["MATHNOTES_PWA_STATIC_ROOT_DIR"]
            ?? bundledPWA.flatMap { fileManager.fileExists(atPath: $0.path) ? $0.path : nil }
            ?? (fileManager.fileExists(atPath: repositoryPWA.path) ? repositoryPWA.path : nil)
        var childEnvironment = source
        childEnvironment["MATHNOTES_LOCAL_TOKEN"] = token
        childEnvironment["MATHNOTES_COMPANION_ENABLED"] = "1"
        childEnvironment["MATHNOTES_COMPANION_TOKEN"] = companionHostToken
        childEnvironment["MATHNOTES_COMPANION_PORT"] = source["MATHNOTES_COMPANION_PORT"] ?? "1051"
        if let pwaRoot { childEnvironment["MATHNOTES_PWA_STATIC_ROOT_DIR"] = pwaRoot }
        childEnvironment["MATHNOTES_USER_DATA_DIR"] = URL(fileURLWithPath: developmentRoot).appending(path: "user-data").path
        childEnvironment["MATHNOTES_NOTES_ROOT_DIR"] = notesRootURL?.path
            ?? source["MATHNOTES_NOTES_ROOT_DIR"]
            ?? URL(fileURLWithPath: developmentRoot).appending(path: "notes").path
        childEnvironment["MATHNOTES_TEMP_DIR"] = URL(fileURLWithPath: developmentRoot).appending(path: "temp").path
        childEnvironment["MATHNOTES_APP_VERSION"] = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "phase1a-dev"
        childEnvironment["MATHNOTES_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        return SidecarConfiguration(
            executableURL: URL(fileURLWithPath: nodeExecutable ?? "/usr/bin/env"),
            arguments: nodeExecutable == nil ? ["node", script] : [script],
            environment: childEnvironment,
            token: token,
            companionHostToken: companionHostToken
        )
    }

    private static func resolveCompanionHostToken(environment: [String: String]) throws -> String {
        if let configured = environment["MATHNOTES_COMPANION_TOKEN"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !configured.isEmpty {
            return configured
        }
        let store = KeychainCredentialStore(service: CompanionHostCredential.service)
        if let saved = try store.read(account: CompanionHostCredential.account), !saved.isEmpty {
            return saved
        }
        let generated = CompanionHostTokenPolicy.generate()
        try store.write(generated, account: CompanionHostCredential.account)
        return generated
    }
}

enum CompanionHostCredential {
    static let service = "com.mathnotes.companion-host"
    static let account = "pairing-token"
}

enum ConfigurationError: LocalizedError {
    case sidecarMissing(String)

    var errorDescription: String? {
        switch self {
        case let .sidecarMissing(path): "未找到 Sidecar：\(path)"
        }
    }
}

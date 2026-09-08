import Foundation
import Security

@main
struct SupervisorSmoke {
    @MainActor static func main() async throws {
        try keychainReadsAreNoninteractiveAndRestoreProcessState()
        try await startupExitRetryAndCancellationAreIsolated()
        print("MACOS_SUPERVISOR_EXIT_SIGNAL_RETRY_RESTART_CHALLENGE_OK")
    }
}

@MainActor
func startupExitRetryAndCancellationAreIsolated() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let node = env["MATHNOTES_TEST_NODE"], let realScript = env["MATHNOTES_TEST_SIDECAR"] else {
        throw FixtureError.missingConfiguration
    }
    let root = FileManager.default.temporaryDirectory.appending(path: "mathnotes-supervisor-\(UUID())")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let script = root.appending(path: "fixture.mjs")
    let token = UUID().uuidString + UUID().uuidString
    let companionToken = UUID().uuidString + UUID().uuidString
    let supervisor = SidecarSupervisor(configuration: SidecarConfiguration(
        executableURL: URL(fileURLWithPath: node), arguments: [script.path],
        environment: [
            "PATH": "/usr/bin:/bin", "MATHNOTES_LOCAL_TOKEN": token,
            "MATHNOTES_COMPANION_TOKEN": companionToken, "MATHNOTES_COMPANION_ENABLED": "1",
            "MATHNOTES_COMPANION_PORT": "1051", "MATHNOTES_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier),
            "MATHNOTES_USER_DATA_DIR": root.appending(path: "user-data").path,
            "MATHNOTES_NOTES_ROOT_DIR": root.appending(path: "notes").path,
            "MATHNOTES_TEMP_DIR": root.appending(path: "temp").path
        ], token: token, companionHostToken: companionToken
    ))
    defer { supervisor.stop() }
    func replaceScript(_ source: String) throws { try Data(source.utf8).write(to: script, options: .atomic) }
    func settle() async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while supervisor.state == .starting && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        try expect(supervisor.state != .starting)
    }
    func failedMessage() throws -> String {
        guard case let .failed(message) = supervisor.state else { throw FixtureError.expectedFailure }
        return message
    }

    try replaceScript("process.kill(process.pid, 'SIGKILL');")
    supervisor.start()
    try await settle()
    try expect(try failedMessage().contains("信号 9"))

    try replaceScript("process.exit(7);")
    supervisor.retry()
    try await settle()
    try expect(try failedMessage().contains("退出码 7"))

    let realSource = try Data(contentsOf: URL(fileURLWithPath: realScript))
    try realSource.write(to: script, options: .atomic)
    supervisor.retry()
    try await settle()
    guard case .ready = supervisor.state else { throw FixtureError.expectedReady }
    let challenge = try await supervisor.createCompanionPairingChallenge()
    try expect(!challenge.challengeId.isEmpty)
    try expect(!challenge.userCode.isEmpty)
    if case let .loaded(notebooks) = supervisor.catalogState {
        try expect(notebooks.count == 1 && notebooks[0].sessions.count == 1)
        try expect(notebooks[0].sessions[0].title == "手机照片")
    } else { throw FixtureError.assertionFailed }
    _ = try await supervisor.createCompanionPairingChallenge()
    if case let .loaded(notebooks) = supervisor.catalogState {
        try expect(notebooks.count == 1 && notebooks[0].sessions.count == 1)
    } else { throw FixtureError.assertionFailed }

    // A cancelled launch must not reset the state/deadline/process of its successor.
    supervisor.stop()
    supervisor.start()
    supervisor.stop()
    try expect(supervisor.state == .idle)
    try replaceScript("setInterval(() => {}, 1000);")
    supervisor.start()
    try await Task.sleep(for: .milliseconds(100))
    try expect(supervisor.state == .starting)
    supervisor.stop()
    try realSource.write(to: script, options: .atomic)
    supervisor.start()
    try await settle()
    try await Task.sleep(for: .milliseconds(200))
    guard case .ready = supervisor.state else { throw FixtureError.expectedReady }
    supervisor.stop()
    try expect(supervisor.state == .idle)
    // Let graceful Node shutdown finish before deleting only this fixture's data.
    try await Task.sleep(for: .seconds(1))
}

private func expect(_ condition: @autoclosure () throws -> Bool) throws {
    guard try condition() else { throw FixtureError.assertionFailed }
}

private func keychainReadsAreNoninteractiveAndRestoreProcessState() throws {
    func interactionAllowed() throws -> Bool {
        var value = DarwinBoolean(false)
        try expect(SecKeychainGetUserInteractionAllowed(&value) == errSecSuccess)
        return value.boolValue
    }
    let before = try interactionAllowed()
    try KeychainCredentialStore.withInteractionAllowed(false) {
        try expect(try !interactionAllowed())
    }
    try expect(try interactionAllowed() == before)
    do {
        try KeychainCredentialStore.withInteractionAllowed(false) { throw FixtureError.expectedFailure }
    } catch FixtureError.expectedFailure { }
    try expect(try interactionAllowed() == before)
    // Random nonexistent service: never reads, adds or removes a real credential.
    let store = KeychainCredentialStore(service: "com.mathnotes.test.\(UUID())")
    try expect(try store.read(account: "nonexistent") == nil)
    try expect(try interactionAllowed() == before)
    print("MACOS_KEYCHAIN_NONINTERACTIVE_READ_AND_RESTORE_OK")
}
private enum FixtureError: Error { case expectedFailure, expectedReady, missingConfiguration, assertionFailed }

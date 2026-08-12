import CryptoKit
import Foundation

@MainActor
enum MacRuntimeDiagnostics {
    private enum Key {
        static let isRunning = "mathnotes.diagnostics.isRunning"
        static let previousExitWasClean = "mathnotes.diagnostics.previousExitWasClean"
        static let interruptedRunCount = "mathnotes.diagnostics.interruptedRunCount"
        static let lastSessionOpenMilliseconds = "mathnotes.diagnostics.lastSessionOpenMilliseconds"
        static let lastSessionBlockCount = "mathnotes.diagnostics.lastSessionBlockCount"
        static let lastSessionOpenedAt = "mathnotes.diagnostics.lastSessionOpenedAt"
        static let lastSessionHash = "mathnotes.diagnostics.lastSessionHash"
        static let lastSessionStage = "mathnotes.diagnostics.lastSessionStage"
        static let lastSessionFailureKind = "mathnotes.diagnostics.lastSessionFailureKind"
    }

    private static var didBeginLaunch = false

    static func beginLaunch(defaults: UserDefaults = .standard) {
        guard !didBeginLaunch else { return }
        didBeginLaunch = true
        let previousWasInterrupted = defaults.bool(forKey: Key.isRunning)
        defaults.set(!previousWasInterrupted, forKey: Key.previousExitWasClean)
        if previousWasInterrupted {
            defaults.set(defaults.integer(forKey: Key.interruptedRunCount) + 1, forKey: Key.interruptedRunCount)
        }
        defaults.set(true, forKey: Key.isRunning)
    }

    static func markCleanExit(defaults: UserDefaults = .standard) {
        defaults.set(false, forKey: Key.isRunning)
        defaults.set(true, forKey: Key.previousExitWasClean)
    }

    static func recordSessionOpen(
        notebookID: String,
        sessionID: String,
        milliseconds: Int,
        blockCount: Int,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(sessionHash(notebookID: notebookID, sessionID: sessionID), forKey: Key.lastSessionHash)
        defaults.set("ready", forKey: Key.lastSessionStage)
        defaults.removeObject(forKey: Key.lastSessionFailureKind)
        defaults.set(max(0, milliseconds), forKey: Key.lastSessionOpenMilliseconds)
        defaults.set(max(0, blockCount), forKey: Key.lastSessionBlockCount)
        defaults.set(ISO8601DateFormatter().string(from: Date()), forKey: Key.lastSessionOpenedAt)
    }

    static func beginSessionOpen(
        notebookID: String,
        sessionID: String,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(sessionHash(notebookID: notebookID, sessionID: sessionID), forKey: Key.lastSessionHash)
        defaults.set("fetching_manifest", forKey: Key.lastSessionStage)
        defaults.removeObject(forKey: Key.lastSessionFailureKind)
    }

    static func recordSessionOpenFailure(
        reason: String,
        defaults: UserDefaults = .standard
    ) {
        defaults.set("failed", forKey: Key.lastSessionStage)
        defaults.set(reason, forKey: Key.lastSessionFailureKind)
    }

    static func previousExitSummary(defaults: UserDefaults = .standard) -> String {
        defaults.bool(forKey: Key.previousExitWasClean) ? "正常退出" : "异常或强制退出"
    }

    static func interruptedRunCount(defaults: UserDefaults = .standard) -> Int {
        defaults.integer(forKey: Key.interruptedRunCount)
    }

    static func lastSessionOpenSummary(defaults: UserDefaults = .standard) -> String {
        let milliseconds = defaults.integer(forKey: Key.lastSessionOpenMilliseconds)
        let blocks = defaults.integer(forKey: Key.lastSessionBlockCount)
        guard milliseconds > 0 else { return "尚无记录" }
        return "\(milliseconds) ms · \(blocks) 个内容段"
    }

    static func lastSessionStageSummary(defaults: UserDefaults = .standard) -> String {
        let stage = defaults.string(forKey: Key.lastSessionStage) ?? "none"
        let sessionHash = defaults.string(forKey: Key.lastSessionHash) ?? "none"
        return "\(stage) · \(sessionHash)"
    }

    static func lastSessionFailureSummary(defaults: UserDefaults = .standard) -> String {
        defaults.string(forKey: Key.lastSessionFailureKind) ?? "无"
    }

    private static func sessionHash(notebookID: String, sessionID: String) -> String {
        let digest = SHA256.hash(data: Data("\(notebookID)/\(sessionID)".utf8))
        return digest.prefix(6).map { String(format: "%02x", $0) }.joined()
    }
}

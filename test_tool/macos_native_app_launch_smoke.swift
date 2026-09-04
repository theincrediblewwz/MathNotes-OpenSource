import AppKit
import CoreGraphics
import Foundation

guard (3...4).contains(CommandLine.arguments.count) else {
    fputs("usage: macos_native_app_launch_smoke <app-path> <screenshot-path> [local|companion|phone]\n", stderr)
    exit(2)
}

let appURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let executableURL = appURL.appending(path: "Contents/MacOS/MathNotes")
let screenshotURL = URL(fileURLWithPath: CommandLine.arguments[2])
let sourceMode = CommandLine.arguments.count == 4 ? CommandLine.arguments[3] : "local"
guard sourceMode == "local" || sourceMode == "companion" || sourceMode == "phone" else {
    fputs("source mode must be local, companion, or phone\n", stderr)
    exit(2)
}
let fileManager = FileManager.default
let temporaryRoot = fileManager.temporaryDirectory.appending(path: "mathnotes-native-ui-\(UUID().uuidString)")
let notesRoot = temporaryRoot.appending(path: "notes")

try fileManager.createDirectory(at: screenshotURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try fileManager.createDirectory(at: notesRoot, withIntermediateDirectories: true)

var occupiedCompanionPort: Process?
var companionPortWasAlreadyOccupied = false
let tailscaleFixtureAddress = "100.88.42.7"
var tailscaleFixtureURL: URL?
if sourceMode == "phone" {
    let fixtureURL = temporaryRoot.appending(path: "tailscale-read-only-fixture")
    let fixtureScript = """
    #!/bin/sh
    if [ "$1" = "ip" ] && [ "$2" = "-4" ]; then
      printf '%s\\n' '\(tailscaleFixtureAddress)'
      exit 0
    fi
    printf '%s\\n' 'unsupported read-only fixture command' >&2
    exit 2
    """
    try Data(fixtureScript.utf8).write(to: fixtureURL, options: .atomic)
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fixtureURL.path)
    tailscaleFixtureURL = fixtureURL

    let fixture = Process()
    let fixtureOutput = Pipe()
    fixture.executableURL = appURL.appending(path: "Contents/Resources/MathNotesRuntime/bin/node")
    fixture.arguments = [
        "-e",
        """
        const server = require('node:net').createServer();
        server.once('error', (error) => {
          if (error.code === 'EADDRINUSE') process.stdout.write('ALREADY_OCCUPIED\\n');
          else { process.stderr.write(String(error) + '\\n'); process.exitCode = 2; }
        });
        server.listen(1051, '0.0.0.0', () => process.stdout.write('READY\\n'));
        """
    ]
    fixture.standardOutput = fixtureOutput
    fixture.standardError = FileHandle.standardError
    try fixture.run()
    let fixtureStatus = String(
        decoding: fixtureOutput.fileHandleForReading.availableData,
        as: UTF8.self
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    switch fixtureStatus {
    case "READY":
        occupiedCompanionPort = fixture
    case "ALREADY_OCCUPIED":
        companionPortWasAlreadyOccupied = true
    default:
        if fixture.isRunning { fixture.terminate() }
        throw NSError(
            domain: "MathNotesNativeAppLaunchSmoke",
            code: 7,
            userInfo: [NSLocalizedDescriptionKey: "could not establish occupied Companion port fixture: \(fixtureStatus)"]
        )
    }
}

let application = Process()
application.executableURL = executableURL
application.currentDirectoryURL = temporaryRoot
let workspaceSource = sourceMode == "companion" ? "companion" : "local"
var launchArguments = ["-mathnotes.workspace.source.v1", workspaceSource]
if sourceMode == "phone" {
    launchArguments.append("-mathnotes.open-phone-connection")
}
application.arguments = launchArguments
var environment = ProcessInfo.processInfo.environment
environment["MATHNOTES_NOTES_ROOT_DIR"] = notesRoot.path
environment["MATHNOTES_REPO_ROOT"] = appURL.deletingLastPathComponent().path
if let tailscaleFixtureURL {
    environment["MATHNOTES_TAILSCALE_CLI"] = tailscaleFixtureURL.path
}
application.environment = environment

defer {
    if occupiedCompanionPort?.isRunning == true {
        occupiedCompanionPort?.terminate()
        occupiedCompanionPort?.waitUntilExit()
    }
    if application.isRunning {
        application.terminate()
        application.waitUntilExit()
    }
    try? fileManager.removeItem(at: temporaryRoot)
}

try application.run()
let deadline = Date().addingTimeInterval(35)
var discoveredWindow: [String: Any]?

while Date() < deadline && application.isRunning {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    discoveredWindow = windows.first { window in
        guard let ownerPID = window[kCGWindowOwnerPID as String] as? Int,
              ownerPID == Int(application.processIdentifier),
              let layer = window[kCGWindowLayer as String] as? Int,
              layer == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? Double,
              let height = bounds["Height"] as? Double else {
            return false
        }
        return width >= 640 && height >= 480
    }
    if discoveredWindow != nil { break }
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
}

guard application.isRunning else {
    throw NSError(
        domain: "MathNotesNativeAppLaunchSmoke",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "MathNotes exited before presenting a window (status \(application.terminationStatus))"]
    )
}

guard let window = discoveredWindow else {
    throw NSError(
        domain: "MathNotesNativeAppLaunchSmoke",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "MathNotes did not present a visible 640x480 application window within 35 seconds"]
    )
}

// The production supervisor has a 15 second startup deadline. Waiting beyond it
// guarantees that the acceptance screenshot captures QR/no-network/failure,
// never the transient preparing spinner.
let settleSeconds = sourceMode == "phone" ? 18 : sourceMode == "companion" ? 3 : 0.5
let settleDeadline = Date().addingTimeInterval(settleSeconds)
while Date() < settleDeadline && application.isRunning {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
guard application.isRunning else {
    throw NSError(
        domain: "MathNotesNativeAppLaunchSmoke",
        code: 4,
        userInfo: [NSLocalizedDescriptionKey: "MathNotes exited while settling the \(sourceMode) source state"]
    )
}

let authenticationWindows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] ?? []
if let authenticationWindow = authenticationWindows.first(where: { candidate in
    let owner = (candidate[kCGWindowOwnerName as String] as? String ?? "").lowercased()
    return owner.contains("securityagent")
}) {
    let owner = authenticationWindow[kCGWindowOwnerName as String] as? String ?? "SecurityAgent"
    let title = authenticationWindow[kCGWindowName as String] as? String ?? ""
    throw NSError(
        domain: "MathNotesNativeAppLaunchSmoke",
        code: 8,
        userInfo: [NSLocalizedDescriptionKey: "MathNotes launch presented an automatic Keychain prompt: \(owner) \(title)"]
    )
}

var captureWindow = window
if sourceMode == "phone" {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    guard let phoneWindow = windows.first(where: { candidate in
        guard let ownerPID = candidate[kCGWindowOwnerPID as String] as? Int,
              ownerPID == Int(application.processIdentifier),
              let layer = candidate[kCGWindowLayer as String] as? Int,
              layer == 0,
              let bounds = candidate[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? Double,
              let height = bounds["Height"] as? Double else {
            return false
        }
        return width >= 580 && width <= 800 && height >= 520
    }) else {
        throw NSError(
            domain: "MathNotesNativeAppLaunchSmoke",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "MathNotes did not present the focused phone connection sheet"]
        )
    }
    captureWindow = phoneWindow
}

guard let windowNumber = captureWindow[kCGWindowNumber as String] as? Int else {
    throw NSError(
        domain: "MathNotesNativeAppLaunchSmoke",
        code: 6,
        userInfo: [NSLocalizedDescriptionKey: "MathNotes target window has no Core Graphics window number"]
    )
}

let screenshot = Process()
screenshot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
screenshot.arguments = ["-x", "-l", String(windowNumber), screenshotURL.path]
try screenshot.run()
let screenshotDeadline = Date().addingTimeInterval(15)
while screenshot.isRunning && Date() < screenshotDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
if screenshot.isRunning {
    screenshot.terminate()
    screenshot.waitUntilExit()
}
guard screenshot.terminationStatus == 0,
      fileManager.fileExists(atPath: screenshotURL.path),
      (try fileManager.attributesOfItem(atPath: screenshotURL.path)[.size] as? NSNumber)?.intValue ?? 0 > 10_000 else {
    throw NSError(
        domain: "MathNotesNativeAppLaunchSmoke",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "visible MathNotes window was found, but its screenshot could not be captured"]
    )
}

let title = captureWindow[kCGWindowName as String] as? String ?? ""
let owner = captureWindow[kCGWindowOwnerName as String] as? String ?? ""
print("macOS native app launch smoke passed")
print("source=\(sourceMode)")
if sourceMode == "phone" {
    print("occupiedCompanionPort=1051 source=\(companionPortWasAlreadyOccupied ? "preexisting" : "acceptance-listener")")
    print("tailscaleFixture=\(tailscaleFixtureAddress) mode=read-only-ipv4")
}
print("pid=\(application.processIdentifier) window=\(windowNumber) owner=\(owner) title=\(title)")
print("screenshot=\(screenshotURL.path)")

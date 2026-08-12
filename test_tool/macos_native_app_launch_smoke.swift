import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("usage: macos_native_app_launch_smoke <app-path> <screenshot-path>\n", stderr)
    exit(2)
}

let appURL = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let executableURL = appURL.appending(path: "Contents/MacOS/MathNotes")
let screenshotURL = URL(fileURLWithPath: CommandLine.arguments[2])
let fileManager = FileManager.default
let temporaryRoot = fileManager.temporaryDirectory.appending(path: "mathnotes-native-ui-\(UUID().uuidString)")
let notesRoot = temporaryRoot.appending(path: "notes")

try fileManager.createDirectory(at: screenshotURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try fileManager.createDirectory(at: notesRoot, withIntermediateDirectories: true)

let application = Process()
application.executableURL = executableURL
application.currentDirectoryURL = temporaryRoot
var environment = ProcessInfo.processInfo.environment
environment["MATHNOTES_NOTES_ROOT_DIR"] = notesRoot.path
environment["MATHNOTES_REPO_ROOT"] = appURL.deletingLastPathComponent().path
application.environment = environment

defer {
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
guard let window = discoveredWindow,
      let windowNumber = window[kCGWindowNumber as String] as? Int else {
    throw NSError(
        domain: "MathNotesNativeAppLaunchSmoke",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "MathNotes did not present a visible 640x480 application window within 35 seconds"]
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

let title = window[kCGWindowName as String] as? String ?? ""
let owner = window[kCGWindowOwnerName as String] as? String ?? ""
print("macOS native app launch smoke passed")
print("pid=\(application.processIdentifier) window=\(windowNumber) owner=\(owner) title=\(title)")
print("screenshot=\(screenshotURL.path)")

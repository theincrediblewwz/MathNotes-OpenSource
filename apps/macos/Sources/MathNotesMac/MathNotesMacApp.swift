import AppKit
import SwiftUI

@MainActor
final class MathNotesMacLifecycleDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        MacRuntimeDiagnostics.markCleanExit()
    }
}

@main
struct MathNotesMacApp: App {
    @NSApplicationDelegateAdaptor(MathNotesMacLifecycleDelegate.self) private var lifecycleDelegate
    @StateObject private var supervisor = SidecarSupervisor()
    @StateObject private var companionReader = CompanionReaderStore()
    @StateObject private var editingState = AppEditingState()
    @StateObject private var assistantWindow = SessionAssistantWindowCoordinator()
    @AppStorage(AppAppearanceMode.storageKey) private var appearanceModeRawValue = AppAppearanceMode.system.rawValue

    private var appearanceMode: AppAppearanceMode {
        AppAppearanceMode(rawValue: appearanceModeRawValue) ?? .system
    }

    init() {
        MacRuntimeDiagnostics.beginLaunch()
    }

    var body: some Scene {
        WindowGroup {
            ContentView(
                supervisor: supervisor,
                companionReader: companionReader,
                editingState: editingState,
                assistantWindow: assistantWindow
            )
                .preferredColorScheme(appearanceMode.preferredColorScheme)
        }
        .defaultSize(width: 1120, height: 720)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandMenu("笔记") {
                Button("刷新目录") {
                    NotificationCenter.default.post(name: .mathNotesReloadCatalog, object: nil)
                }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }

        Window("学习助手", id: "session-assistant") {
            SessionAssistantWindowRoot(
                coordinator: assistantWindow,
                supervisor: supervisor
            )
            .preferredColorScheme(appearanceMode.preferredColorScheme)
        }
        .defaultSize(width: 520, height: 680)
        .windowResizability(.contentMinSize)
        .windowStyle(.hiddenTitleBar)

        Settings {
            ProviderSettingsView(supervisor: supervisor, editingState: editingState)
                .preferredColorScheme(appearanceMode.preferredColorScheme)
        }
    }
}

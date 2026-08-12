import AppKit
import SwiftUI

private final class AssistantWindowChromeView: NSView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.styleMask.insert(.fullSizeContentView)
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
    }
}

struct AssistantWindowChromeConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        AssistantWindowChromeView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) { }
}

private final class AssistantWindowDragView: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

struct AssistantWindowDragSurface: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        AssistantWindowDragView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) { }
}

@MainActor
struct SessionAssistantWindowContext {
    let session: SessionCatalogItem
    let manifest: ReadonlySessionManifest
    let activeBlockID: String?
    let selectedText: String
    let selectedTextBlockID: String?
    let onSelectionEditRequested: (() -> Void)?
    let onSessionChanged: () async -> Void
}

@MainActor
final class SessionAssistantWindowCoordinator: ObservableObject {
    @Published private(set) var context: SessionAssistantWindowContext?

    func present(_ context: SessionAssistantWindowContext) {
        self.context = context
    }

    func clear() {
        context = nil
    }
}

struct SessionAssistantWindowRoot: View {
    @ObservedObject var coordinator: SessionAssistantWindowCoordinator
    @ObservedObject var supervisor: SidecarSupervisor
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        Group {
            if let context = coordinator.context {
                SessionAssistantPanel(
                    session: context.session,
                    manifest: context.manifest,
                    activeBlockID: context.activeBlockID,
                    selectedText: context.selectedText,
                    selectedTextBlockID: context.selectedTextBlockID,
                    supervisor: supervisor,
                    onSelectionEditRequested: context.onSelectionEditRequested,
                    onSessionChanged: context.onSessionChanged,
                    onClose: { dismissWindow(id: "session-assistant") }
                )
            } else {
                ContentUnavailableView(
                    "尚未选择笔记",
                    systemImage: "sparkles",
                    description: Text("从笔记窗口打开学习助手。")
                )
            }
        }
        .frame(minWidth: 420, minHeight: 480)
        .background(MathNotesTheme.canvas)
        .ignoresSafeArea(.container, edges: .top)
        .background(AssistantWindowChromeConfigurator())
    }
}

import AppKit
import SwiftUI

/// Extension-based filtering also accepts ZIP files whose type metadata came
/// from Windows, without consulting Launch Services for each selection.
@MainActor
enum SharePackagePicker {
    static func supports(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        if ["zip", "md", "markdown"].contains(url.pathExtension.lowercased()) { return true }
        return url.hasDirectoryPath || (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    }

    static func isDroppedPackage(_ url: URL) -> Bool {
        url.isFileURL && (url.pathExtension.lowercased() == "zip" || url.hasDirectoryPath ||
            (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true)
    }

    private final class Filter: NSObject, NSOpenSavePanelDelegate {
        func panel(_ sender: Any, shouldEnable url: URL) -> Bool { SharePackagePicker.supports(url) }
    }

    static func choose(parent: NSWindow) async -> URL? {
        let panel = NSOpenPanel()
        let filter = Filter()
        panel.title = "导入分享包"
        panel.prompt = "导入"
        panel.message = "选择 ZIP、分享文件夹或 Markdown 正文。ZIP 无需先解压。"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.delegate = filter
        // Do not combine folder and dynamically inferred Markdown UTIs. The
        // delegate enables folders and supported extensions independently.
        panel.allowedContentTypes = []
        panel.allowsOtherFileTypes = true
        let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in
            let complete: (NSApplication.ModalResponse) -> Void = { result in
                panel.orderOut(nil)
                continuation.resume(returning: result)
            }
            panel.beginSheetModal(for: parent, completionHandler: complete)
        }
        withExtendedLifetime(filter) {}
        return response == .OK ? panel.url : nil
    }
}

struct SharePackageImportStatus: ViewModifier {
    let isImporting: Bool
    @Binding var error: String?
    @Binding var notice: String?

    func body(content: Content) -> some View {
        content.overlay {
            if isImporting {
                ZStack {
                    MathNotesTheme.canvas.opacity(0.65)
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("正在导入正文、内容块和资源…")
                    }
                    .padding(28)
                    .background(MathNotesTheme.sidebar, in: RoundedRectangle(cornerRadius: 16))
                }
            }
        }
        .alert("分享包已导入", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("好", role: .cancel) { notice = nil }
        } message: { Text(notice ?? "") }
        .alert("无法导入分享包", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("好", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }
}

/// Keep the initiating workspace window even while SwiftUI dismisses its sheet;
/// NSApp.keyWindow/mainWindow may be nil or refer to another workspace then.
@MainActor
final class SharePackagePanelHost {
    weak var window: NSWindow?
}

struct SharePackagePanelAnchor: NSViewRepresentable {
    let host: SharePackagePanelHost
    final class AnchorView: NSView {
        var host: SharePackagePanelHost?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            host?.window = window
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
    func makeNSView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.host = host
        return view
    }
    func updateNSView(_ view: AnchorView, context: Context) { host.window = view.window }
}

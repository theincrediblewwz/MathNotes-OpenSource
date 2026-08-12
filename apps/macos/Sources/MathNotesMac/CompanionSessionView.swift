import AppKit
import SwiftUI
import WebKit

struct CompanionSessionView: View {
    let session: SessionCatalogItem
    @ObservedObject var store: CompanionReaderStore
    @State private var document: CompanionRemoteDocument?
    @State private var error: String?
    @State private var reloadID = 0
    @AppStorage(MacPreferenceKeys.previewFont) private var previewFontRawValue =
        MacPreviewFontPreset.system.rawValue
    @AppStorage(MacPreferenceKeys.previewFontSize) private var previewFontSize =
        MacTypographyPreferences.defaultPreviewSize

    var body: some View {
        ZStack {
            MathNotesTheme.canvas.ignoresSafeArea()
            if let document {
                let preset = MacPreviewFontPreset(rawValue: previewFontRawValue) ?? .system
                CompanionDocumentWebView(
                    html: MacTypographyPreferences.styledPreviewHTML(
                        document.html,
                        preset: preset,
                        size: previewFontSize
                    )
                )
                .overlay(alignment: .topTrailing) {
                    Label(
                        document.missingAssetCount == 0 ? "远程只读" : "正文已就绪 · 素材同步中",
                        systemImage: document.missingAssetCount == 0 ? "lock.open.display" : "arrow.triangle.2.circlepath"
                    )
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .mathNotesControlSurface()
                    .padding(MathNotesTheme.Spacing.standard)
                }
            } else if let error {
                ContentUnavailableView {
                    Label("无法读取远程笔记", systemImage: "exclamationmark.icloud")
                } description: {
                    Text(error)
                } actions: {
                    Button("重新读取") { reloadID += 1 }
                }
            } else {
                VStack(spacing: MathNotesTheme.Spacing.standard) {
                    ProgressView()
                    Text("正在读取远程笔记")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .task(id: "\(session.id):\(reloadID)") {
            document = nil
            error = nil
            do {
                let initial = try await store.loadDocument(session)
                try Task.checkCancellation()
                document = initial
                let hydrated = await store.loadAssets(for: initial)
                try Task.checkCancellation()
                document = hydrated
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
            }
        }
        .accessibilityLabel("远程只读 Session \(session.title)")
    }
}

private struct CompanionDocumentWebView: NSViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        context.coordinator.html = html
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.html != html else { return }
        context.coordinator.html = html
        view.loadHTMLString(html, baseURL: nil)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.navigationDelegate = nil
        view.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var html = ""

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                return .allow
            }
            if url.scheme == "https" || url.scheme == "http" {
                NSWorkspace.shared.open(url)
            }
            return .cancel
        }
    }
}

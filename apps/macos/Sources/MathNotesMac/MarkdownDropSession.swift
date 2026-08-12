import Foundation
import SwiftUI
@preconcurrency import WebKit

struct DroppedMarkdownDocument: Identifiable, Equatable, Sendable {
    let id: UUID
    let name: String
    let markdown: String

    init(id: UUID = UUID(), name: String, markdown: String) {
        self.id = id
        self.name = name
        self.markdown = markdown
    }

    var title: String {
        URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent
    }
}

enum MarkdownDropReader {
    static let maximumBytes = 2 * 1024 * 1024

    static func read(_ urls: [URL]) throws -> [DroppedMarkdownDocument] {
        guard !urls.isEmpty else { throw MarkdownDropError.noFiles }
        return try urls.map { url in
            let ext = url.pathExtension.lowercased()
            guard ext == "md" || ext == "markdown" else { throw MarkdownDropError.unsupported(url.lastPathComponent) }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true else { throw MarkdownDropError.unsupported(url.lastPathComponent) }
            guard (values.fileSize ?? 0) <= maximumBytes else { throw MarkdownDropError.tooLarge(url.lastPathComponent) }
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            guard data.count <= maximumBytes else { throw MarkdownDropError.tooLarge(url.lastPathComponent) }
            guard let markdown = String(data: data, encoding: .utf8) else { throw MarkdownDropError.invalidUTF8(url.lastPathComponent) }
            guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MarkdownDropError.empty(url.lastPathComponent) }
            return DroppedMarkdownDocument(name: url.lastPathComponent, markdown: markdown)
        }
    }
}

enum MarkdownDropError: LocalizedError {
    case noFiles, unsupported(String), tooLarge(String), invalidUTF8(String), empty(String)

    var errorDescription: String? {
        switch self {
        case .noFiles: "没有检测到可导入的 Markdown 文件。"
        case let .unsupported(name): "不支持的文件：\(name)。请拖入 .md 或 .markdown 文件。"
        case let .tooLarge(name): "\(name) 超过 2 MiB，未执行导入。"
        case let .invalidUTF8(name): "\(name) 不是有效的 UTF-8 Markdown。"
        case let .empty(name): "\(name) 是空文档，未执行导入。"
        }
    }
}

struct TemporaryMarkdownSessionView: View {
    let documents: [DroppedMarkdownDocument]
    @ObservedObject var supervisor: SidecarSupervisor
    let onDiscard: () -> Void
    let onSave: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: MathNotesTheme.Spacing.section) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("TEMPORARY SESSION").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(documents.first?.title ?? "导入的 Markdown").font(.title2.weight(.semibold))
                    Text("尚未归入任何 Notebook · \(documents.count) 个文本块").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("放弃", role: .destructive, action: onDiscard)
                Button(action: onSave) { Label("保存到笔记", systemImage: "tray.and.arrow.down") }
                    .buttonStyle(.borderedProminent)
            }
            .padding(MathNotesTheme.Spacing.section)
            Divider()
            ScrollView {
                LazyVStack(spacing: MathNotesTheme.Spacing.section) {
                    ForEach(documents) { document in
                        TemporaryMarkdownBlock(document: document, supervisor: supervisor)
                    }
                }
                .padding(MathNotesTheme.Spacing.page)
            }
        }
        .background(MathNotesTheme.canvas)
        .accessibilityIdentifier("temporary-markdown-session")
    }
}

struct MarkdownArchiveSheet: View {
    let documents: [DroppedMarkdownDocument]
    let notebooks: [NotebookCatalogItem]
    let onCancel: () -> Void
    let onConfirm: (MarkdownArchiveDestination) -> Void
    @State private var useNewNotebook = false
    @State private var notebookId = ""
    @State private var newTitle = ""

    var body: some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
            Text("保存临时 Session").font(.title2.weight(.semibold))
            Text("请选择所属 Notebook。保存后每个 Markdown 文件仍是一个独立文本块。")
                .font(.callout).foregroundStyle(.secondary)
            Picker("目标", selection: $useNewNotebook) {
                Text("现有 Notebook").tag(false)
                Text("新建 Notebook").tag(true)
            }
            .pickerStyle(.segmented)
            .disabled(notebooks.isEmpty)
            if useNewNotebook || notebooks.isEmpty {
                TextField("Notebook 名称", text: $newTitle).textFieldStyle(.roundedBorder)
            } else {
                Picker("Notebook", selection: $notebookId) {
                    ForEach(notebooks) { notebook in Text(notebook.title).tag(notebook.notebookId) }
                }
            }
            HStack {
                Spacer()
                Button("取消", role: .cancel, action: onCancel)
                Button("保存") {
                    if useNewNotebook || notebooks.isEmpty { onConfirm(.new(title: newTitle.trimmingCharacters(in: .whitespacesAndNewlines))) }
                    else { onConfirm(.existing(notebookId: notebookId)) }
                }
                .buttonStyle(.borderedProminent)
                .disabled((useNewNotebook || notebooks.isEmpty) ? newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : notebookId.isEmpty)
            }
        }
        .padding(MathNotesTheme.Spacing.section)
        .frame(width: 440)
        .onAppear {
            notebookId = notebooks.first?.notebookId ?? ""
            newTitle = documents.first?.title ?? "导入的 Markdown"
            useNewNotebook = notebooks.isEmpty
        }
    }
}

enum MarkdownArchiveDestination {
    case existing(notebookId: String)
    case new(title: String)
}

private struct TemporaryMarkdownBlock: View {
    let document: DroppedMarkdownDocument
    @ObservedObject var supervisor: SidecarSupervisor
    @State private var html: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "doc.text")
                Text(document.name).font(.callout.weight(.semibold))
                Spacer()
            }
            .padding(.horizontal, MathNotesTheme.Spacing.section)
            .padding(.vertical, MathNotesTheme.Spacing.standard)
            Divider()
            if let html {
                TemporaryMarkdownWebView(html: html).frame(minHeight: 180)
            } else if let error {
                ContentUnavailableView("无法渲染", systemImage: "exclamationmark.triangle", description: Text(error))
                    .frame(minHeight: 160)
            } else {
                ProgressView("正在渲染").frame(maxWidth: .infinity, minHeight: 160)
            }
        }
        .background(MathNotesTheme.sidebar)
        .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel))
        .overlay(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel).stroke(MathNotesTheme.separator.opacity(0.45)))
        .task(id: document.id) {
            do { html = try await supervisor.previewStandaloneMarkdown(document.markdown) }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct TemporaryMarkdownWebView: NSViewRepresentable {
    let html: String
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        view.loadHTMLString(html, baseURL: nil)
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded = ""
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.navigationType == .other ? .allow : .cancel
        }
    }
}

import SwiftUI

private enum MacSessionPreviewState: Equatable {
    case idle
    case loading
    case loaded(String)
    case failed(String)
}

struct MacNotebookBrowser: View {
    let notebooks: [NotebookCatalogItem]
    let sourceMode: WorkspaceSourceMode
    let supervisor: SidecarSupervisor
    let companionReader: CompanionReaderStore
    let initialNotebookID: String?
    let onCreateNotebook: () -> Void
    let onCreateSession: (NotebookCatalogItem) -> Void
    let onOpenSession: (SessionCatalogItem) -> Void
    let onClose: () -> Void

    @State private var openedNotebookID: String?
    @State private var searchText = ""
    @State private var hoveredSessionID: String?
    @State private var previewSessionID: String?
    @State private var previewState: MacSessionPreviewState = .idle

    init(
        notebooks: [NotebookCatalogItem],
        sourceMode: WorkspaceSourceMode,
        supervisor: SidecarSupervisor,
        companionReader: CompanionReaderStore,
        initialNotebookID: String?,
        onCreateNotebook: @escaping () -> Void,
        onCreateSession: @escaping (NotebookCatalogItem) -> Void,
        onOpenSession: @escaping (SessionCatalogItem) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.notebooks = notebooks
        self.sourceMode = sourceMode
        self.supervisor = supervisor
        self.companionReader = companionReader
        self.initialNotebookID = initialNotebookID
        self.onCreateNotebook = onCreateNotebook
        self.onCreateSession = onCreateSession
        self.onOpenSession = onOpenSession
        self.onClose = onClose
        _openedNotebookID = State(initialValue: initialNotebookID)
    }

    var body: some View {
        VStack(spacing: 0) {
            browserHeader
            Divider()
            Group {
                if let notebook = openedNotebook {
                    sessionBrowser(notebook)
                } else {
                    notebookBrowser
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 820, idealWidth: 940, minHeight: 560, idealHeight: 660)
        .background(MathNotesTheme.canvas)
        .tint(MathNotesTheme.accent)
    }

    private var browserHeader: some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            if openedNotebook != nil {
                Button {
                    openedNotebookID = nil
                    hoveredSessionID = nil
                    previewState = .idle
                } label: {
                    Label("返回 Notebooks", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("返回 Notebooks")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(openedNotebook?.title ?? "打开 Notebooks")
                    .font(.title2.weight(.semibold))
                Text(openedNotebook == nil ? "选择一个文件夹" : "选择一个 Session；停留指针可预览正文")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            TextField("搜索 Notebook 或 Session", text: $searchText)
                .textFieldStyle(.roundedBorder)
                .frame(width: 250)
                .accessibilityLabel("搜索 Notebook 或 Session")
            if sourceMode == .local {
                if let notebook = openedNotebook {
                    Button {
                        onCreateSession(notebook)
                    } label: {
                        Label("新建 Session", systemImage: "doc.badge.plus")
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button {
                        onCreateNotebook()
                    } label: {
                        Label("新建 Notebook", systemImage: "folder.badge.plus")
                    }
                    .buttonStyle(.bordered)
                }
            }
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭 Notebooks")
        }
        .padding(.horizontal, MathNotesTheme.Spacing.section)
        .padding(.vertical, 16)
    }

    @ViewBuilder
    private var notebookBrowser: some View {
        let filtered = filteredNotebooks
        if filtered.isEmpty {
            ContentUnavailableView.search(text: searchText)
        } else {
            ScrollView {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 190, maximum: 230), spacing: 18)],
                    spacing: 18
                ) {
                    ForEach(filtered) { notebook in
                        notebookFolder(notebook)
                    }
                }
                .padding(MathNotesTheme.Spacing.page)
            }
            .accessibilityLabel("Notebook 文件夹")
        }
    }

    private func notebookFolder(_ notebook: NotebookCatalogItem) -> some View {
        Button {
            openedNotebookID = notebook.notebookId
            searchText = ""
        } label: {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 58, weight: .regular))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(MathNotesTheme.accent)
                Spacer(minLength: 4)
                Text(notebook.title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Text("\(notebook.sessionCount) 个 Session")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(18)
            .frame(maxWidth: .infinity, minHeight: 174, alignment: .leading)
            .background(MathNotesTheme.sidebar, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(MathNotesTheme.separator.opacity(0.72))
            }
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Notebook \(notebook.title)，\(notebook.sessionCount) 个 Session")
    }

    @ViewBuilder
    private func sessionBrowser(_ notebook: NotebookCatalogItem) -> some View {
        let sessions = filteredSessions(in: notebook)
        if sessions.isEmpty {
            ContentUnavailableView(
                searchText.isEmpty ? "还没有 Session" : "没有匹配的 Session",
                systemImage: "doc.text.magnifyingglass",
                description: Text(searchText.isEmpty ? "可以在这个 Notebook 中新建一份笔记。" : "尝试其他关键词。")
            )
        } else {
            ScrollView {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 210, maximum: 280), spacing: 16)],
                    spacing: 16
                ) {
                    ForEach(sessions) { session in
                        sessionCard(session, notebook: notebook)
                    }
                }
                .padding(MathNotesTheme.Spacing.page)
            }
            .accessibilityLabel("\(notebook.title) 中的 Sessions")
        }
    }

    private func sessionCard(_ session: SessionCatalogItem, notebook: NotebookCatalogItem) -> some View {
        Button {
            onOpenSession(session)
            onClose()
        } label: {
            HStack(alignment: .top, spacing: MathNotesTheme.Spacing.standard) {
                Image(systemName: "doc.text")
                    .font(.title2)
                    .foregroundStyle(MathNotesTheme.accent)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 6) {
                    Text(session.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(sessionDetail(session))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
            .background(
                hoveredSessionID == session.id ? MathNotesTheme.accentSoft : MathNotesTheme.sidebar,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(MathNotesTheme.separator.opacity(0.72))
            }
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredSessionID = hovering ? session.id : (hoveredSessionID == session.id ? nil : hoveredSessionID)
            if hovering {
                previewSessionID = session.id
                previewState = .loading
            }
        }
        .popover(
            isPresented: Binding(
                get: { hoveredSessionID == session.id },
                set: { if !$0, hoveredSessionID == session.id { hoveredSessionID = nil } }
            ),
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .trailing
        ) {
            sessionPreview(session, notebook: notebook)
                .frame(width: 360, height: 300)
                .task(id: session.id) { await loadPreview(session) }
        }
        .accessibilityLabel("Session \(session.title)，位于 \(notebook.title)")
    }

    private func sessionPreview(_ session: SessionCatalogItem, notebook: NotebookCatalogItem) -> some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(.headline)
                    .lineLimit(2)
                Text(notebook.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Divider()
            Group {
                switch previewState {
                case .idle, .loading:
                    VStack(spacing: 10) {
                        ProgressView()
                        Text("正在准备预览")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case let .loaded(markdown):
                    ScrollView {
                        Text(previewText(markdown))
                            .font(.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case let .failed(message):
                    ContentUnavailableView(
                        "暂时无法预览",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text(message)
                    )
                }
            }
        }
        .padding(18)
        .background(MathNotesTheme.canvas)
    }

    @MainActor
    private func loadPreview(_ session: SessionCatalogItem) async {
        previewSessionID = session.id
        previewState = .loading
        do {
            let markdown: String
            if sourceMode == .local {
                let manifest = try await supervisor.fetchSessionManifest(session)
                var parts: [String] = []
                for block in manifest.blocks where block.type == "markdown" && parts.count < 3 {
                    try Task.checkCancellation()
                    let payload = try await supervisor.fetchSessionBlock(session, blockId: block.id)
                    if case let .markdown(content) = payload.content,
                       !content.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        parts.append(content.markdown)
                    }
                }
                markdown = parts.joined(separator: "\n\n---\n\n")
            } else {
                markdown = try await companionReader.loadDocument(session).markdown
            }
            try Task.checkCancellation()
            guard previewSessionID == session.id else { return }
            previewState = .loaded(markdown.isEmpty ? "这份笔记还没有正文。" : markdown)
        } catch is CancellationError {
            return
        } catch {
            guard previewSessionID == session.id else { return }
            previewState = .failed(error.localizedDescription)
        }
    }

    private var openedNotebook: NotebookCatalogItem? {
        guard let openedNotebookID else { return nil }
        return notebooks.first { $0.notebookId == openedNotebookID }
    }

    private var filteredNotebooks: [NotebookCatalogItem] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return notebooks }
        return notebooks.filter { notebook in
            notebook.title.localizedCaseInsensitiveContains(query) ||
                notebook.sessions.contains { $0.title.localizedCaseInsensitiveContains(query) }
        }
    }

    private func filteredSessions(in notebook: NotebookCatalogItem) -> [SessionCatalogItem] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return notebook.sessions }
        return notebook.sessions.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }

    private func sessionDetail(_ session: SessionCatalogItem) -> String {
        guard let date = ISO8601DateFormatter().date(from: session.updatedAt) else {
            return session.status == "draft" ? "草稿" : session.status
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func previewText(_ markdown: String) -> AttributedString {
        let bounded = String(markdown.prefix(4_000))
        return (try? AttributedString(markdown: bounded)) ?? AttributedString(bounded)
    }
}

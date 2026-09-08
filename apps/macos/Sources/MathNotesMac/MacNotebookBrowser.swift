import SwiftUI

private enum MacSessionPreviewState: Equatable {
    case idle
    case loading
    case loaded([ContinuousMarkdownBlock])
    case failed(String)
}

struct MacNotebookBrowser: View {
    let notebooks: [NotebookCatalogItem]
    let sourceMode: WorkspaceSourceMode
    let supervisor: SidecarSupervisor
    @ObservedObject var companionReader: CompanionReaderStore
    let initialNotebookID: String?
    let hasUnsavedDrafts: Bool
    let onCreateNotebook: () -> Void
    let onCreateSession: (NotebookCatalogItem) -> Void
    let onOpenSession: (SessionCatalogItem) -> Void
    let onImportSharePackage: (String?) -> Void
    let onClose: () -> Void

    @State private var managementTarget: BrowserManagementTarget?
    @State private var renameTitle = ""
    @State private var showRename = false
    @State private var showDelete = false
    @State private var showTrash = false
    @State private var trashEntries: [WorkspaceTrashEntry] = []
    @State private var isManaging = false
    @State private var isLoadingTrash = true
    @State private var managementError: String?
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
        hasUnsavedDrafts: Bool = false,
        onCreateNotebook: @escaping () -> Void,
        onCreateSession: @escaping (NotebookCatalogItem) -> Void,
        onOpenSession: @escaping (SessionCatalogItem) -> Void,
        onImportSharePackage: @escaping (String?) -> Void = { _ in },
        onClose: @escaping () -> Void
    ) {
        self.notebooks = notebooks
        self.sourceMode = sourceMode
        self.supervisor = supervisor
        self.companionReader = companionReader
        self.initialNotebookID = initialNotebookID
        self.hasUnsavedDrafts = hasUnsavedDrafts
        self.onCreateNotebook = onCreateNotebook
        self.onCreateSession = onCreateSession
        self.onOpenSession = onOpenSession
        self.onImportSharePackage = onImportSharePackage
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
        .overlayPreferenceValue(SessionPreviewAnchorKey.self) { anchors in
            GeometryReader { geometry in
                if let id = hoveredSessionID,
                   let anchor = anchors[id],
                   let notebook = openedNotebook,
                   let session = notebook.sessions.first(where: { $0.id == id }) {
                    let card = geometry[anchor]
                    let width: CGFloat = 360
                    let height: CGFloat = 320
                    let x = card.maxX + width + 12 <= geometry.size.width
                        ? card.maxX + 12 : max(12, card.minX - width - 12)
                    let y = max(12, min(card.minY, geometry.size.height - height - 12))
                    sessionPreview(session, notebook: notebook)
                        .frame(width: width, height: height)
                        .background(MathNotesTheme.sidebar, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(MathNotesTheme.separator))
                        .shadow(color: .black.opacity(0.15), radius: 18, y: 6)
                        .position(x: x + width / 2, y: y + height / 2)
                        .task(id: session.id) { await loadPreview(session) }
                }
            }
            // Hover content must not intercept pointer events on another card.
            .allowsHitTesting(false)
        }
        .frame(minWidth: 820, idealWidth: 940, minHeight: 560, idealHeight: 660)
        .background(MathNotesTheme.canvas)
        .tint(MathNotesTheme.accent)
        .alert("重命名", isPresented: $showRename) {
            TextField("名称", text: $renameTitle)
            Button("取消", role: .cancel) {}
            Button("保存") {
                if let target = managementTarget { runManagement(target.request("rename", title: renameTitle)) }
            }
            .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("移至废纸篓？", isPresented: $showDelete, titleVisibility: .visible) {
            Button("移至废纸篓", role: .destructive) {
                if let target = managementTarget { runManagement(target.request("trash")) }
            }
        } message: {
            Text("“\(managementTarget?.title ?? "")”及其素材会完整保留，可从 Notebooks 的废纸篓恢复。")
        }
        .alert("操作未完成", isPresented: Binding(get: { managementError != nil && !showTrash }, set: { if !$0 { managementError = nil } })) {
            Button("好") { managementError = nil }
        } message: { Text(managementError ?? "") }
        .sheet(isPresented: $showTrash) { trashView }
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
                Button { onImportSharePackage(openedNotebook?.notebookId) } label: {
                    Label("导入", systemImage: "square.and.arrow.down")
                }
                .disabled(hasUnsavedDrafts)
                .help("导入分享包 ZIP、文件夹或 Markdown（含 assets 资源）")
            }
            if canManageWorkspace {
                if let notebook = openedNotebook {
                    Button {
                        onCreateSession(notebook)
                    } label: {
                        Label("新建 Session", systemImage: "doc.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Button {
                        onCreateNotebook()
                    } label: {
                        Label("新建 Notebook", systemImage: "folder.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            if canManageWorkspace {
                Button { hoveredSessionID = nil; showTrash = true } label: { Image(systemName: "trash") }
                    .help("废纸篓：恢复已删除笔记")
                    .accessibilityLabel("打开笔记废纸篓")
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
        .contextMenu { managementMenu(BrowserManagementTarget(notebookId: notebook.notebookId, sessionId: nil, title: notebook.title)) }
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
            hoveredSessionID = nil
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
            if hovering {
                hoveredSessionID = session.id
                if previewSessionID != session.id {
                    previewSessionID = session.id
                    previewState = .loading
                }
            } else {
                dismissPreview(for: session.id)
            }
        }
        .onDisappear { dismissPreview(for: session.id) }
        .anchorPreference(key: SessionPreviewAnchorKey.self, value: .bounds) {
            [session.id: $0]
        }
        .contextMenu { managementMenu(BrowserManagementTarget(notebookId: notebook.notebookId, sessionId: session.sessionId, title: session.title)) }
        .accessibilityLabel("Session \(session.title)，位于 \(notebook.title)")
    }

    @ViewBuilder
    private func managementMenu(_ target: BrowserManagementTarget) -> some View {
        if canManageWorkspace {
            Button("重命名…") {
                hoveredSessionID = nil
                managementTarget = target
                renameTitle = target.title
                showRename = true
            }
            .disabled(isManaging || hasUnsavedDrafts)
            Button("移至废纸篓…", role: .destructive) {
                hoveredSessionID = nil
                managementTarget = target
                showDelete = true
            }
            .disabled(isManaging || hasUnsavedDrafts)
            if hasUnsavedDrafts { Text("请先保存当前编辑") }
        }
    }

    private func runManagement(_ input: WorkspaceManageRequest) {
        guard !isManaging, !hasUnsavedDrafts else { return }
        isManaging = true
        managementError = nil
        Task {
            defer { isManaging = false }
            do {
                try await supervisor.manageWorkspace(input)
                if input.action == "trash", input.sessionId == nil { openedNotebookID = nil }
                if showTrash { trashEntries = try await supervisor.workspaceTrash() }
            } catch { managementError = error.localizedDescription }
        }
    }

    private var canManageWorkspace: Bool {
        sourceMode == .local || (companionReader.replicaSupervisor != nil && companionReader.syncResult?.catalogManagementAvailable == true)
    }

    private var trashView: some View {
        MacWorkspaceTrashView(
            entries: trashEntries,
            isLoading: isLoadingTrash,
            isRestoring: isManaging,
            hasUnsavedDrafts: hasUnsavedDrafts,
            error: managementError,
            onRestore: { entry in
                runManagement(WorkspaceManageRequest(action: "restore", notebookId: entry.notebookId,
                    sessionId: entry.sessionId, deletionId: entry.id))
            },
            onClose: { showTrash = false }
        )
        .task {
            isLoadingTrash = true
            managementError = nil
            defer { isLoadingTrash = false }
            do { trashEntries = try await supervisor.workspaceTrash() }
            catch { managementError = error.localizedDescription }
        }
    }

    private func dismissPreview(for sessionID: String) {
        // A previous card's exit must not dismiss a newer card's preview.
        guard hoveredSessionID == sessionID else { return }
        hoveredSessionID = nil
        previewSessionID = nil
        previewState = .idle
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
                case let .loaded(blocks):
                    if blocks.isEmpty {
                        ContentUnavailableView("这份笔记还没有正文", systemImage: "doc.text")
                    } else {
                        StableSessionMarkdownWebView(blocks: blocks, activeBlockID: .constant(nil), compact: true)
                            .accessibilityIdentifier("session-hover-rendered-preview")
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
            let blocks = try await MacSessionPreviewLoader.load(
                session, sourceMode: sourceMode, supervisor: supervisor, companionReader: companionReader
            )
            try Task.checkCancellation()
            guard !Task.isCancelled, hoveredSessionID == session.id, previewSessionID == session.id else { return }
            previewState = .loaded(blocks)
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, hoveredSessionID == session.id, previewSessionID == session.id else { return }
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
}

@MainActor
enum MacSessionPreviewLoader {
    static func load(
        _ session: SessionCatalogItem,
        sourceMode: WorkspaceSourceMode,
        supervisor: SidecarSupervisor,
        companionReader: CompanionReaderStore
    ) async throws -> [ContinuousMarkdownBlock] {
        if sourceMode == .local || companionReader.replicaSupervisor != nil {
            let manifest = try await supervisor.fetchSessionManifest(session)
            var blocks: [ContinuousMarkdownBlock] = []
            let groups = sessionMarkdownGroups(manifest.blocks.filter { $0.renderInNote && $0.type == "markdown" })
            for group in groups.prefix(3) {
                try Task.checkCancellation()
                guard let first = group.first else { continue }
                var pieces: [String] = []
                var singleHTML = ""
                for block in group {
                    let payload = try await supervisor.fetchSessionBlock(session, blockId: block.id)
                    if case let .markdown(content) = payload.content {
                        pieces.append(content.markdown)
                        singleHTML = content.html
                    }
                }
                let markdown = pieces.joined()
                guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let html = group.count > 1 ? try await supervisor.previewMarkdown(session, blockId: first.id, markdown: markdown) : singleHTML
                blocks.append(ContinuousMarkdownBlock(id: first.id, order: first.order,
                    html: markdownBodyFragment(html), version: first.updatedAt, memberIDs: group.map(\.id)))
            }
            return blocks
        }
        let document = try await companionReader.loadDocument(session)
        // Remote HTML must not enter the script-enabled local reading shell.
        // Render its Markdown with the local sanitizer and formula renderer.
        let html = try await supervisor.previewStandaloneMarkdown(document.markdown)
        return [ContinuousMarkdownBlock(
            id: session.id, order: 0, html: markdownBodyFragment(html), version: document.manifest.revision
        )]
    }
}

private struct SessionPreviewAnchorKey: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] { [:] }
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

private struct BrowserManagementTarget {
    let notebookId: String
    let sessionId: String?
    let title: String
    func request(_ action: String, title: String? = nil) -> WorkspaceManageRequest {
        WorkspaceManageRequest(action: action, notebookId: notebookId, sessionId: sessionId, title: title)
    }
}

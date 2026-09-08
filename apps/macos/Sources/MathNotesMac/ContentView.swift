import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @ObservedObject var supervisor: SidecarSupervisor
    @ObservedObject var companionReader: CompanionReaderStore
    @ObservedObject var editingState: AppEditingState
    @ObservedObject var assistantWindow: SessionAssistantWindowCoordinator
    @Environment(\.openSettings) private var openSettings
    @AppStorage(WorkspaceSourceMode.storageKey) private var sourceModeRawValue =
        WorkspaceSourceMode.local.rawValue
    @State private var selectedSession: SessionCatalogItem?
    @State private var selectedNotebookId: String?
    @State private var pendingSession: SessionCatalogItem?
    @State private var recentReading = MacRecentReadingStore.load()
    @State private var showNotebookBrowser = false
    @State private var showRemoteSync = false
    @State private var showPhoneConnection = ProcessInfo.processInfo.arguments.contains(
        "-mathnotes.open-phone-connection"
    )
    @State private var searchText = ""
    @State private var creationTarget: WorkspaceCreationTarget?
    @State private var creationTitle = ""
    @State private var creationError: String?
    @State private var isCreating = false
    @State private var pendingMarkdownDocuments: [DroppedMarkdownDocument] = []
    @State private var temporaryMarkdownDocuments: [DroppedMarkdownDocument] = []
    @State private var showMarkdownDropChoice = false
    @State private var showMarkdownArchive = false
    @State private var showTemporaryDiscard = false
    @State private var markdownDropError: String?
    @State private var isImportingMarkdown = false
    @State private var sessionRefreshNonce = 0
    @State private var isImportingSharePackage = false
    @State private var sharePackageError: String?

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                sidebarHeader
                recentReadingSidebar
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                notebookBrowserAction
            }
            .navigationSplitViewColumnWidth(min: 246, ideal: 292, max: 360)
            .background(MathNotesTheme.sidebar)
        } detail: {
            detailPane
        }
        .tint(MathNotesTheme.accent)
        .frame(minWidth: 780, minHeight: 500)
        .dropDestination(for: URL.self) { urls, _ in
            Task { await handleMarkdownDrop(urls) }
            return !urls.isEmpty
        }
        .task {
            supervisor.startIfNeeded()
            if sourceMode == .companion { companionReader.reloadCatalog() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .mathNotesReloadCatalog)) { _ in
            guard !editingState.hasUnsavedSourceDrafts else { return }
            if sourceMode == .companion { companionReader.reloadSavedConnection() }
            else { reloadActiveCatalog() }
        }
        .onChange(of: companionReader.activeHostID) { _, _ in
            guard sourceMode == .companion, !editingState.hasUnsavedSourceDrafts else { return }
            selectedSession = nil
            selectedNotebookId = nil
        }
        .sheet(isPresented: $showRemoteSync) {
            RemoteSyncStatusSheet(store: companionReader, editingState: editingState)
        }
        .onChange(of: sourceModeRawValue) { _, _ in
            selectedSession = nil
            selectedNotebookId = nil
            showNotebookBrowser = false
            editingState.hasUnsavedSourceDrafts = false
            if sourceMode == .companion {
                companionReader.reloadCatalog()
            } else {
                companionReader.clear()
                supervisor.reloadCatalog()
            }
        }
        .onChange(of: availableSessionIDs) { _, ids in
            guard case .loaded = activeCatalogState else { return }
            if let selectedSession, !ids.contains(selectedSession.id) {
                self.selectedSession = nil
            }
        }
        .onChange(of: loadedNotebooks) { _, notebooks in
            if let selectedSession,
               let updated = notebooks.flatMap(\.sessions).first(where: { $0.id == selectedSession.id }),
               updated != selectedSession {
                self.selectedSession = updated
            }
        }
        .sheet(item: $creationTarget) { target in
            creationSheet(target)
        }
        .sheet(isPresented: $showPhoneConnection) {
            PhoneConnectionSheet(
                supervisor: supervisor,
                onOpenSettings: { openSettings() }
            )
        }
        .sheet(isPresented: $showNotebookBrowser) {
            MacNotebookBrowser(
                notebooks: loadedNotebooks,
                sourceMode: sourceMode,
                supervisor: workspaceSupervisor ?? supervisor,
                companionReader: companionReader,
                initialNotebookID: selectedSession?.notebookId ?? selectedNotebookId,
                hasUnsavedDrafts: editingState.hasUnsavedSourceDrafts,
                onCreateNotebook: { beginCreationAfterBrowserDismiss(.notebook) },
                onCreateSession: { notebook in
                    beginCreationAfterBrowserDismiss(
                        .session(notebookId: notebook.notebookId, notebookTitle: notebook.title)
                    )
                },
                onOpenSession: requestSessionSelection,
                onImportSharePackage: beginSharePackageImport,
                onClose: { showNotebookBrowser = false }
            )
        }
        .sheet(isPresented: $isImportingSharePackage) {
            VStack(spacing: 14) {
                ProgressView()
                Text("正在导入正文和资源…")
            }
            .frame(width: 320, height: 140)
            .interactiveDismissDisabled()
        }
        .alert("无法导入分享包", isPresented: Binding(get: { sharePackageError != nil }, set: { if !$0 { sharePackageError = nil } })) {
            Button("好", role: .cancel) { sharePackageError = nil }
        } message: { Text(sharePackageError ?? "") }
        .sheet(isPresented: $showMarkdownArchive) {
            MarkdownArchiveSheet(
                documents: temporaryMarkdownDocuments,
                notebooks: loadedNotebooks,
                onCancel: { showMarkdownArchive = false },
                onConfirm: { destination in Task { await archiveTemporaryMarkdown(destination) } }
            )
        }
        .confirmationDialog(
            "当前没有打开 Session",
            isPresented: $showMarkdownDropChoice,
            titleVisibility: .visible
        ) {
            Button("新建 Notebook 和 Session") { Task { await createNotebookForPendingMarkdown() } }
            Button("暂存阅读") {
                temporaryMarkdownDocuments = pendingMarkdownDocuments
                pendingMarkdownDocuments = []
                editingState.hasUnsavedSourceDrafts = true
            }
            Button("取消", role: .cancel) { pendingMarkdownDocuments = [] }
        } message: {
            Text("可以立即归档，也可以先打开一个不属于任何笔记的临时 Session。")
        }
        .alert("放弃临时 Session？", isPresented: $showTemporaryDiscard) {
            Button("继续阅读", role: .cancel) { }
            Button("放弃", role: .destructive) {
                temporaryMarkdownDocuments = []
                editingState.hasUnsavedSourceDrafts = false
            }
        } message: {
            Text("临时 Markdown 尚未保存到 Notebook，放弃后无法从 MathNotes 恢复。")
        }
        .alert("无法导入 Markdown", isPresented: Binding(
            get: { markdownDropError != nil },
            set: { if !$0 { markdownDropError = nil } }
        )) {
            Button("好", role: .cancel) { markdownDropError = nil }
        } message: { Text(markdownDropError ?? "未知错误") }
        .alert("还有未保存的修改", isPresented: Binding(
            get: { pendingSession != nil },
            set: { if !$0 { pendingSession = nil } }
        )) {
            Button("继续编辑", role: .cancel) { pendingSession = nil }
            Button("放弃并切换", role: .destructive) {
                if let pendingSession { openSession(pendingSession) }
                pendingSession = nil
                editingState.hasUnsavedSourceDrafts = false
            }
        } message: {
            Text("当前 Session 的源码修改还没有保存。")
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(temporaryMarkdownDocuments.first?.title ?? selectedSession?.title ?? "MathNotes")
                    .font(.headline)
                    .lineLimit(1)
                    .padding(.horizontal, MathNotesTheme.Spacing.section)
                    .padding(.vertical, 8)
                    .frame(minWidth: 180)
                    .accessibilityIdentifier("workspace-toolbar-title")
            }
        }
    }

    private var sidebarHeader: some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("最近阅读")
                        .font(.title2.weight(.semibold))
                    Text(sourceMode == .local ? "这台 Mac 上的笔记" : "来自已连接电脑")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                sidebarPhoneConnectionAction
            }
            HStack(spacing: 6) {
                Picker("笔记来源", selection: $sourceModeRawValue) {
                    ForEach(WorkspaceSourceMode.allCases) { source in
                        Text(source.title).tag(source.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(editingState.hasUnsavedSourceDrafts)
                .help(
                    editingState.hasUnsavedSourceDrafts
                        ? "请先保存当前修改，再切换笔记来源"
                        : "切换本机笔记与远程主机的独立副本"
                )
                .frame(width: sourceMode == .companion ? 108 : nil)
                if sourceMode == .companion {
                    Menu {
                        ForEach(companionReader.hostProfiles) { host in
                            Button(host.name) { companionReader.selectHost(host) }
                        }
                        Divider()
                        Button("添加 / 管理主机…") {
                            ProviderSettingsSection.select(.companion)
                            openSettings()
                        }
                    } label: {
                        Text(companionReader.activeHost?.name ?? "选择主机").lineLimit(1)
                    }
                    .menuStyle(.borderlessButton)
                    .disabled(editingState.hasUnsavedSourceDrafts)
                    Button { showRemoteSync = true } label: {
                        Image(systemName: (companionReader.syncResult?.conflictCount ?? 0) > 0
                            ? "exclamationmark.arrow.triangle.2.circlepath" : "arrow.triangle.2.circlepath")
                            .frame(width: 24, height: 26)
                    }
                    .buttonStyle(.plain)
                    .help(companionReader.isSynchronizing ? "正在同步" : companionReader.syncMessage ?? "同步与本地副本")
                    .accessibilityLabel("远程同步状态")
                }
            }
            if editingState.hasUnsavedSourceDrafts {
                Text("保存当前修改后，即可切换本机与远程。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, MathNotesTheme.Spacing.section)
        .padding(.top, MathNotesTheme.Spacing.section)
        .padding(.bottom, MathNotesTheme.Spacing.standard)
    }

    private var sidebarPhoneConnectionAction: some View {
        Button { showPhoneConnection = true } label: {
            Image(systemName: "qrcode")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(MathNotesTheme.accent)
                .frame(width: 34, height: 34)
                .background(MathNotesTheme.accentSoft, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .help("连接手机：显示二维码")
        .accessibilityLabel("连接手机，显示二维码")
        .accessibilityIdentifier("sidebar-phone-connection")
    }

    private var sidebarSettingsAction: some View {
        Button { openSettings() } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 17, weight: .medium))
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("设置外观、连接与 AI 服务")
        .accessibilityLabel("打开设置")
    }

    @ViewBuilder
    private var recentReadingSidebar: some View {
        switch activeCatalogState {
        case .idle, .loading:
            loadingState
        case let .failed(message):
            ContentUnavailableView {
                Label("无法读取笔记", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("重新读取") { reloadActiveCatalog() }
                if sourceMode == .companion {
                    Button("连接设置") {
                        ProviderSettingsSection.select(.companion)
                        openSettings()
                    }
                }
            }
        case let .loaded(notebooks):
            recentReadingList(notebooks)
        }
    }

    private var notebookBrowserAction: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 8) {
                Button { showNotebookBrowser = true } label: {
                    Label("打开 Notebooks", systemImage: "folder")
                        .font(.callout.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 5)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityLabel("打开 Notebooks")
                sidebarSettingsAction
            }
            .padding(MathNotesTheme.Spacing.section)
        }
    }

    private var loadingState: some View {
        VStack(spacing: MathNotesTheme.Spacing.standard) {
            ProgressView()
                .controlSize(.small)
            Text("正在读取笔记")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("正在读取笔记目录")
    }

    @ViewBuilder
    private func recentReadingList(_ notebooks: [NotebookCatalogItem]) -> some View {
        let items = recentReadingItems(in: notebooks)
        if items.isEmpty {
            ContentUnavailableView(
                "还没有最近阅读",
                systemImage: "clock",
                description: Text(notebooks.isEmpty ? "先新建或连接一份笔记。" : "从 Notebooks 打开 Session 后会显示在这里。")
            )
            .frame(maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(items) { item in
                        recentReadingRow(item)
                    }
                }
                .padding(.horizontal, MathNotesTheme.Spacing.standard)
                .padding(.vertical, 4)
            }
            .accessibilityLabel("最近阅读")
        }
    }

    private func recentReadingRow(_ item: MacRecentSessionItem) -> some View {
        Button {
            requestSessionSelection(item.session)
        } label: {
            HStack(spacing: MathNotesTheme.Spacing.standard) {
                Image(systemName: "clock")
                    .foregroundStyle(MathNotesTheme.accent)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.session.title)
                        .font(.body.weight(.medium))
                        .lineLimit(2)
                        .foregroundStyle(.primary)
                    Text(item.notebookTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                Text(relativeOpenedTime(item.entry.openedAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                selectedSession?.id == item.session.id ? MathNotesTheme.accentSoft : Color.clear,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!temporaryMarkdownDocuments.isEmpty)
        .accessibilityLabel("最近阅读，\(item.session.title)，\(item.notebookTitle)")
        .accessibilityAddTraits(selectedSession?.id == item.session.id ? .isSelected : [])
    }

    @ViewBuilder
    private func catalogList(_ notebooks: [NotebookCatalogItem]) -> some View {
        let filtered = CatalogSearch.filter(notebooks, query: searchText)
        if notebooks.isEmpty {
            ContentUnavailableView(
                "还没有笔记",
                systemImage: "books.vertical",
                description: Text("选择笔记目录后，Notebook 会显示在这里。")
            )
        } else if filtered.isEmpty {
            ContentUnavailableView.search(text: searchText)
        } else {
            List {
                ForEach(filtered) { notebook in
                    Section {
                        if notebook.sessions.isEmpty {
                            Text("暂无 Session")
                                .font(.callout)
                                .foregroundStyle(.tertiary)
                        } else {
                            ForEach(notebook.sessions) { session in
                                sessionRow(session)
                            }
                        }
                    } header: {
                        notebookHeader(notebook)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .searchable(text: $searchText, placement: .sidebar, prompt: "搜索笔记")
            .accessibilityLabel("笔记目录")
        }
    }

    private func notebookHeader(_ notebook: NotebookCatalogItem) -> some View {
        Button {
            selectedNotebookId = notebook.notebookId
        } label: {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                Image(systemName: selectedNotebookId == notebook.notebookId ? "folder.fill" : "folder")
                    .foregroundStyle(MathNotesTheme.accent)
                Text(notebook.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: MathNotesTheme.Spacing.compact)
                Text("\(notebook.sessionCount)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Notebook \(notebook.title)，\(notebook.sessionCount) 个 Session")
    }

    private func sessionRow(_ session: SessionCatalogItem) -> some View {
        Button {
            requestSessionSelection(session)
        } label: {
            HStack(spacing: MathNotesTheme.Spacing.standard) {
                Image(systemName: selectedSession?.id == session.id ? "doc.text.fill" : "doc.text")
                    .foregroundStyle(selectedSession?.id == session.id ? MathNotesTheme.accent : .secondary)
                    .frame(width: 17)
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.title)
                        .font(.body.weight(selectedSession?.id == session.id ? .medium : .regular))
                        .lineLimit(2)
                        .foregroundStyle(.primary)
                    Text(sessionSubtitle(session))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!temporaryMarkdownDocuments.isEmpty)
        .listRowBackground(selectedSession?.id == session.id ? MathNotesTheme.accentSoft : Color.clear)
        .accessibilityLabel("Session \(session.title)，\(session.status == "draft" ? "草稿" : session.status)")
        .accessibilityAddTraits(selectedSession?.id == session.id ? .isSelected : [])
    }

    @ViewBuilder
    private var detailPane: some View {
        if !temporaryMarkdownDocuments.isEmpty {
            TemporaryMarkdownSessionView(
                documents: temporaryMarkdownDocuments,
                supervisor: supervisor,
                onDiscard: { showTemporaryDiscard = true },
                onSave: { showMarkdownArchive = true }
            )
        } else if let selectedSession {
            if let workspaceSupervisor {
                ReadonlySessionView(
                    session: selectedSession,
                    supervisor: workspaceSupervisor,
                    assistantWindow: assistantWindow,
                    onOpenRelatedSource: openRelatedSource,
                    onOpenSession: requestSessionSelection,
                    onDirtyStateChanged: { editingState.hasUnsavedSourceDrafts = $0 },
                    readingLocationKey: MacReadingPositionStore.key(
                        source: sourceMode.rawValue,
                        hostID: workspaceSupervisor === supervisor ? nil : companionReader.activeHostID,
                        notebookID: selectedSession.notebookId, sessionID: selectedSession.sessionId
                    )
                )
                .id("\(companionReader.activeHostID ?? "local"):\(sourceMode.rawValue):\(selectedSession.id):\(sessionRefreshNonce)")
            } else {
                CompanionSessionView(session: selectedSession, store: companionReader)
            }
        } else {
            ContentUnavailableView(
                "选择一个 Session",
                systemImage: "doc.text.magnifyingglass",
                description: Text("从左侧目录打开笔记。")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(MathNotesTheme.canvas)
        }
    }

    private var coreStatus: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(statusTitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            if activeSourceFailed {
                Button("重连") { reconnectActiveSource() }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(MathNotesTheme.accent)
            }
        }
        .padding(.horizontal, MathNotesTheme.Spacing.standard)
        .frame(height: 36)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(statusTitle)
    }

    private var sidebarSummary: String {
        guard case let .loaded(notebooks) = activeCatalogState else { return statusTitle }
        let sessionCount = notebooks.reduce(0) { $0 + $1.sessions.count }
        return "\(notebooks.count) 个 Notebook · \(sessionCount) 个 Session"
    }

    private var availableSessionIDs: Set<String> {
        guard case let .loaded(notebooks) = activeCatalogState else { return [] }
        return Set(notebooks.flatMap(\.sessions).map(\.id))
    }

    private var loadedNotebooks: [NotebookCatalogItem] {
        guard case let .loaded(notebooks) = activeCatalogState else { return [] }
        return notebooks
    }

    private func recentReadingItems(in notebooks: [NotebookCatalogItem]) -> [MacRecentSessionItem] {
        let notebookByID = Dictionary(uniqueKeysWithValues: notebooks.map { ($0.notebookId, $0) })
        return recentReading
            .filter { $0.sourceRawValue == sourceMode.rawValue && (sourceMode == .local || $0.hostId == companionReader.activeHostID) }
            .compactMap { entry in
                guard let notebook = notebookByID[entry.notebookId],
                      let session = notebook.sessions.first(where: { $0.sessionId == entry.sessionId }) else {
                    return nil
                }
                return MacRecentSessionItem(
                    entry: entry,
                    session: session,
                    notebookTitle: notebook.title
                )
            }
            .prefix(MacRecentReadingStore.sidebarCount)
            .map { $0 }
    }

    private var preferredNotebook: NotebookCatalogItem? {
        if let notebookId = selectedSession?.notebookId ?? selectedNotebookId,
           let match = loadedNotebooks.first(where: { $0.notebookId == notebookId }) {
            return match
        }
        return loadedNotebooks.first
    }

    private var isCoreReady: Bool {
        if case .ready = supervisor.state { return true }
        return false
    }

    private var statusTitle: String {
        if sourceMode == .companion {
            switch companionReader.state {
            case .idle: return "远程笔记尚未连接"
            case .loading: return "正在连接远程笔记"
            case .ready: return "远程笔记已连接 · 只读"
            case .failed: return "远程笔记连接失败"
            }
        }
        return switch supervisor.state {
        case .idle: "核心尚未启动"
        case .starting: "正在准备笔记核心"
        case .ready: "笔记核心已连接"
        case .stopping: "正在安全停止"
        case .failed: "笔记核心连接失败"
        }
    }

    private var statusColor: Color {
        if sourceMode == .companion {
            switch companionReader.state {
            case .ready: return MathNotesTheme.accent
            case .failed: return MathNotesTheme.failure
            case .loading: return MathNotesTheme.warning
            case .idle: return .secondary
            }
        }
        return switch supervisor.state {
        case .ready: MathNotesTheme.accent
        case .failed: MathNotesTheme.failure
        case .starting, .stopping: MathNotesTheme.warning
        case .idle: .secondary
        }
    }

    private func sessionSubtitle(_ session: SessionCatalogItem) -> String {
        let state = session.status == "draft" ? "草稿" : session.status
        guard let date = ISO8601DateFormatter().date(from: session.updatedAt) else { return state }
        return "\(state) · \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    private func requestSessionSelection(_ session: SessionCatalogItem) {
        guard selectedSession?.id != session.id else {
            recordRecentReading(session)
            return
        }
        selectedNotebookId = session.notebookId
        if editingState.hasUnsavedSourceDrafts {
            pendingSession = session
        } else {
            openSession(session)
        }
    }

    private func openRelatedSource(_ source: SessionAssistantRelatedSource) {
        guard workspaceSupervisor != nil,
              let notebook = loadedNotebooks.first(where: { $0.notebookId == source.notebookId }),
              let session = notebook.sessions.first(where: { $0.sessionId == source.sessionId }) else { return }
        requestSessionSelection(session)
    }

    private func beginSharePackageImport(notebookID: String?) {
        guard sourceMode == .local, !editingState.hasUnsavedSourceDrafts, !isImportingSharePackage else { return }
        showNotebookBrowser = false
        Task { @MainActor in
            await Task.yield()
            let panel = NSOpenPanel()
            panel.title = "导入分享包"
            panel.message = "选择 Windows/Mac 分享包文件夹、ZIP，或与 assets 文件夹相邻的 Markdown。"
            panel.canChooseFiles = true
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.allowedContentTypes = [.zip, .folder, UTType(filenameExtension: "md") ?? .plainText, UTType(filenameExtension: "markdown") ?? .plainText]
            guard panel.runModal() == .OK, let url = panel.url else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            isImportingSharePackage = true
            defer { isImportingSharePackage = false }
            do {
                let result = try await supervisor.importSharePackage(packagePath: url.path, notebookId: notebookID)
                selectedNotebookId = result.session.notebookId
                openSession(result.session)
                sessionRefreshNonce += 1
            } catch { sharePackageError = error.localizedDescription }
        }
    }

    private func openSession(_ session: SessionCatalogItem) {
        selectedNotebookId = session.notebookId
        selectedSession = session
        recordRecentReading(session)
    }

    private func recordRecentReading(_ session: SessionCatalogItem) {
        let notebookTitle = loadedNotebooks.first(where: { $0.notebookId == session.notebookId })?.title
            ?? session.notebookId
        recentReading = MacRecentReadingStore.recording(
            session: session,
            notebookTitle: notebookTitle,
            source: sourceMode,
            hostId: sourceMode == .companion ? companionReader.activeHostID : nil,
            in: recentReading
        )
        MacRecentReadingStore.save(recentReading)
    }

    private func relativeOpenedTime(_ timestamp: TimeInterval) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: Date(timeIntervalSince1970: timestamp), relativeTo: Date())
    }

    @MainActor
    private func handleMarkdownDrop(_ urls: [URL]) async {
        guard !isImportingMarkdown else { return }
        isImportingMarkdown = true
        defer { isImportingMarkdown = false }
        do {
            let documents = try MarkdownDropReader.read(urls)
            if !temporaryMarkdownDocuments.isEmpty {
                temporaryMarkdownDocuments.append(contentsOf: documents)
                editingState.hasUnsavedSourceDrafts = true
            } else if let workspaceSupervisor, let selectedSession {
                for document in documents {
                    _ = try await workspaceSupervisor.appendMarkdown(
                        selectedSession, markdown: document.markdown, sourceName: document.name
                    )
                }
                sessionRefreshNonce += 1
            } else {
                pendingMarkdownDocuments = documents
                showMarkdownDropChoice = true
            }
        } catch {
            markdownDropError = error.localizedDescription
        }
    }

    @MainActor
    private func createNotebookForPendingMarkdown() async {
        let documents = pendingMarkdownDocuments
        pendingMarkdownDocuments = []
        guard let first = documents.first else { return }
        do {
            let notebook = try await supervisor.createNotebook(title: first.title)
            let session = try await supervisor.createSession(notebookId: notebook.notebookId, title: first.title)
            try await populateImportedSession(session, documents: documents)
            selectedNotebookId = notebook.notebookId
            openSession(session)
            sessionRefreshNonce += 1
            editingState.hasUnsavedSourceDrafts = false
        } catch {
            markdownDropError = error.localizedDescription
        }
    }

    @MainActor
    private func archiveTemporaryMarkdown(_ destination: MarkdownArchiveDestination) async {
        guard let first = temporaryMarkdownDocuments.first else { return }
        do {
            let notebookId: String
            switch destination {
            case let .existing(existing): notebookId = existing
            case let .new(title): notebookId = try await supervisor.createNotebook(title: title).notebookId
            }
            let session = try await supervisor.createSession(notebookId: notebookId, title: first.title)
            try await populateImportedSession(session, documents: temporaryMarkdownDocuments)
            temporaryMarkdownDocuments = []
            showMarkdownArchive = false
            selectedNotebookId = notebookId
            openSession(session)
            sessionRefreshNonce += 1
            editingState.hasUnsavedSourceDrafts = false
        } catch {
            markdownDropError = error.localizedDescription
        }
    }

    private func populateImportedSession(
        _ session: SessionCatalogItem,
        documents: [DroppedMarkdownDocument]
    ) async throws {
        let starter = try await supervisor.fetchSessionManifest(session).blocks.map(\.id)
        for document in documents {
            _ = try await supervisor.appendMarkdown(session, markdown: document.markdown, sourceName: document.name)
        }
        if !starter.isEmpty {
            let current = try await supervisor.fetchSessionManifest(session)
            _ = try await supervisor.deleteSessionBlocks(
                session,
                blockIds: starter,
                baseRevision: current.revision
            )
        }
    }

    private var sourceMode: WorkspaceSourceMode {
        WorkspaceSourceMode(rawValue: sourceModeRawValue) ?? .local
    }

    private var workspaceSupervisor: SidecarSupervisor? {
        sourceMode == .local ? supervisor : companionReader.replicaSupervisor
    }

    private var activeCatalogState: CatalogState {
        sourceMode == .local ? supervisor.catalogState : companionReader.catalogState
    }

    private var activeSourceFailed: Bool {
        if sourceMode == .local {
            if case .failed = supervisor.state { return true }
        } else if case .failed = companionReader.state {
            return true
        }
        return false
    }

    private func reloadActiveCatalog() {
        if sourceMode == .local {
            supervisor.reloadCatalog()
        } else {
            companionReader.reloadCatalog()
        }
    }

    private func reconnectActiveSource() {
        if sourceMode == .local {
            supervisor.retry()
        } else {
            companionReader.reloadCatalog()
        }
    }

    private func beginCreation(_ target: WorkspaceCreationTarget) {
        creationTitle = target.defaultTitle
        creationError = nil
        creationTarget = target
    }

    private func beginCreationAfterBrowserDismiss(_ target: WorkspaceCreationTarget) {
        showNotebookBrowser = false
        Task { @MainActor in
            await Task.yield()
            beginCreation(target)
        }
    }

    private func creationSheet(_ target: WorkspaceCreationTarget) -> some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
                Text(target.title)
                    .font(.title2.weight(.semibold))
                Text(target.subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            TextField("名称", text: $creationTitle)
                .textFieldStyle(.roundedBorder)
                .onSubmit { Task { await performCreation(target) } }
            if let creationError {
                Label(creationError, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(MathNotesTheme.failure)
            }
            HStack {
                Spacer()
                Button("取消", role: .cancel) { creationTarget = nil }
                    .keyboardShortcut(.cancelAction)
                    .disabled(isCreating)
                Button(isCreating ? "正在创建" : "创建") {
                    Task { await performCreation(target) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isCreating || creationTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(MathNotesTheme.Spacing.section)
        .frame(width: 420)
        .background(MathNotesTheme.canvas)
        .tint(MathNotesTheme.accent)
    }

    @MainActor
    private func performCreation(_ target: WorkspaceCreationTarget) async {
        guard !isCreating, let workspaceSupervisor else { return }
        isCreating = true
        creationError = nil
        defer { isCreating = false }
        do {
            switch target {
            case .notebook:
                let notebook = try await workspaceSupervisor.createNotebook(title: creationTitle)
                selectedNotebookId = notebook.notebookId
            case let .session(notebookId, _):
                let session = try await workspaceSupervisor.createSession(notebookId: notebookId, title: creationTitle)
                openSession(session)
                editingState.hasUnsavedSourceDrafts = false
            }
            creationTarget = nil
        } catch {
            creationError = error.localizedDescription
        }
    }
}

private struct MacRecentSessionItem: Identifiable {
    let entry: MacRecentReadingEntry
    let session: SessionCatalogItem
    let notebookTitle: String

    var id: String { entry.id }
}

private enum WorkspaceCreationTarget: Identifiable {
    case notebook
    case session(notebookId: String, notebookTitle: String)

    var id: String {
        switch self {
        case .notebook: "notebook"
        case let .session(notebookId, _): "session:\(notebookId)"
        }
    }

    var title: String {
        switch self {
        case .notebook: "新建 Notebook"
        case .session: "新建 Session"
        }
    }

    var subtitle: String {
        switch self {
        case .notebook: "Notebook 用来归类同一课程或研究方向的 Session。"
        case let .session(_, notebookTitle): "将创建在「\(notebookTitle)」中，并准备首个可编辑文本块。"
        }
    }

    var defaultTitle: String {
        switch self {
        case .notebook: "未命名笔记本"
        case .session: "未命名 Session"
        }
    }
}

import AppKit
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
@preconcurrency import WebKit

struct ReadonlySessionView: View {
    let session: SessionCatalogItem
    @ObservedObject var supervisor: SidecarSupervisor
    @ObservedObject var assistantWindow: SessionAssistantWindowCoordinator
    let onDirtyStateChanged: (Bool) -> Void
    @Environment(\.openWindow) private var openWindow
    @State private var state: ManifestLoadState = .loading
    @State private var isSelectingImage = false
    @State private var isImportingImage = false
    @State private var isSelectingPdf = false
    @State private var isImportingPdf = false
    @State private var importError: String?
    @State private var isExporting = false
    @State private var exportError: String?
    @State private var exportNotice: String?
    @State private var selectedBlockID: String?
    @State private var recognitionActivity: SessionRecognitionTask?
    @State private var recognitionActivityDraft = ""
    @State private var recognitionActivityMessage = ""
    @State private var recognitionActivitySequence = 0
    @State private var isRecognitionActivityExpanded = false
    @State private var dismissedRecognitionTaskID: String?
    @State private var companionUploadActivity: SessionCompanionUploadActivity?
    @State private var recentRecognitionTasks: [SessionRecognitionTask] = []
    @State private var isActivityPanelExpanded = false
    @State private var isManifestLoading = false
    @State private var needsManifestReload = false
    @StateObject private var sourceWorkspace = SessionSourceWorkspace()
    @SceneStorage("mathnotes.workbench.compactPane") private var compactPaneRawValue = WorkbenchPane.preview.rawValue
    @SceneStorage("mathnotes.workbench.displayMode") private var displayModeRawValue = WorkbenchDisplayMode.split.rawValue

    var body: some View {
        Group {
            switch state {
            case .loading:
                sessionSkeleton
            case let .failed(message):
                ContentUnavailableView {
                    Label("无法读取正文", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("重新读取") { Task { await load() } }
                }
            case let .loaded(manifest):
                sessionContent(manifest)
            }
        }
        .background(MathNotesTheme.canvas)
        .task(id: session.id) {
            await load()
            guard !Task.isCancelled else { return }
            await monitorRecognitionActivity()
        }
        .onChange(of: sourceWorkspace.hasDirtyDrafts) { _, isDirty in
            onDirtyStateChanged(isDirty)
        }
        .fileImporter(
            isPresented: $isSelectingImage,
            allowedContentTypes: [.png, .jpeg, .webP],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { importError = error.localizedDescription }
                return
            }
            Task { await importImage(url) }
        }
        .fileImporter(
            isPresented: $isSelectingPdf,
            allowedContentTypes: [.pdf],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else {
                if case let .failure(error) = result { importError = error.localizedDescription }
                return
            }
            Task { await importPdf(url) }
        }
        .alert("无法导入素材", isPresented: Binding(
            get: { importError != nil },
            set: { if !$0 { importError = nil } }
        )) {
            Button("好", role: .cancel) { importError = nil }
        } message: {
            Text(importError ?? "未知错误")
        }
        .alert("无法导出笔记", isPresented: Binding(
            get: { exportError != nil },
            set: { if !$0 { exportError = nil } }
        )) {
            Button("好", role: .cancel) { exportError = nil }
        } message: {
            Text(exportError ?? "未知错误")
        }
        .alert("导出完成", isPresented: Binding(
            get: { exportNotice != nil },
            set: { if !$0 { exportNotice = nil } }
        )) {
            Button("好", role: .cancel) { exportNotice = nil }
        } message: {
            Text(exportNotice ?? "Markdown 已保存。")
        }
    }

    private var sessionSkeleton: some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
            ProgressView()
                .controlSize(.small)
            Text("正在打开正文")
                .font(.callout)
                .foregroundStyle(.secondary)
            RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel)
                .fill(MathNotesTheme.sidebar)
                .frame(height: 120)
        }
        .padding(MathNotesTheme.Spacing.page)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("正在打开 Session 正文")
    }

    private func sessionContent(_ manifest: ReadonlySessionManifest) -> some View {
        let sourceBlocks = manifest.blocks.filter { $0.renderInNote && $0.type == "markdown" }
        let previewBlocks = sourceBlocks
        return GeometryReader { geometry in
            if geometry.size.width < 760 {
                VStack(spacing: 0) {
                    Picker("工作区", selection: compactPaneBinding) {
                        ForEach(WorkbenchPane.allCases) { pane in
                            Label(pane.label, systemImage: pane.systemImage).tag(pane)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .padding(5)
                    .mathNotesControlSurface(interactive: true)
                    .padding(.horizontal, MathNotesTheme.Spacing.section)
                    .padding(.vertical, MathNotesTheme.Spacing.compact)

                    if compactPane == .source {
                        sourcePane(manifest, blocks: sourceBlocks)
                    } else {
                        previewPane(manifest, blocks: previewBlocks)
                    }
                }
            } else if displayMode == .reading {
                previewPane(manifest, blocks: previewBlocks)
                    .frame(maxWidth: .infinity)
            } else {
                HSplitView {
                    sourcePane(manifest, blocks: sourceBlocks)
                        .frame(minWidth: 300, idealWidth: 420, maxWidth: 720)
                    previewPane(manifest, blocks: previewBlocks)
                        .frame(minWidth: 360)
                }
            }
        }
        .overlay(alignment: .bottomTrailing) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                activityToggle
                previewActionCluster(manifest)
            }
            .padding(MathNotesTheme.Spacing.page)
        }
        .onChange(of: selectedBlockID) { _, blockID in
            if let blockID { sourceWorkspace.activate(blockID: blockID) }
        }
        .accessibilityLabel("Session \(manifest.title) 的源码与预览工作区")
    }

    private func sourcePane(_ manifest: ReadonlySessionManifest, blocks: [SessionBlockManifest]) -> some View {
        SessionSourcePane(
            session: session,
            manifest: manifest,
            blocks: blocks,
            selectedBlockID: $selectedBlockID,
            workspace: sourceWorkspace,
            supervisor: supervisor,
            onReordered: { reordered in applyManifest(reordered) },
            onSessionChanged: { await load() }
        )
    }

    private func previewPane(_ manifest: ReadonlySessionManifest, blocks: [SessionBlockManifest]) -> some View {
        SessionContinuousPreview(
            session: session,
            sessionRevision: manifest.revision,
            blocks: blocks,
            activeBlockID: $selectedBlockID,
            workspace: sourceWorkspace,
            supervisor: supervisor
        )
        .accessibilityLabel("Session \(manifest.title) 的连续预览")
    }

    private func previewActionCluster(_ manifest: ReadonlySessionManifest) -> some View {
        HStack(spacing: MathNotesTheme.Spacing.compact) {
            Button {
                displayModeRawValue = (
                    displayMode == .reading
                        ? WorkbenchDisplayMode.split
                        : WorkbenchDisplayMode.reading
                ).rawValue
            } label: {
                Image(systemName: displayMode == .reading ? "rectangle.split.2x1" : "book.closed")
                    .frame(width: 30, height: 30)
                    .frame(width: 40, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(displayMode == .reading ? "恢复左侧 Markdown 源码区" : "收起源码区，只阅读渲染结果")
            .accessibilityLabel(displayMode == .reading ? "显示源码" : "进入阅读模式")

            Button {
                assistantWindow.present(SessionAssistantWindowContext(
                    session: session,
                    manifest: manifest,
                    activeBlockID: selectedBlockID,
                    selectedText: sourceWorkspace.selectedExcerpt,
                    selectedTextBlockID: sourceWorkspace.selectedExcerptBlockID,
                    onSessionChanged: { await load() }
                ))
                openWindow(id: "session-assistant")
            } label: {
                Image(systemName: "sparkles")
                    .frame(width: 30, height: 30)
                    .frame(width: 40, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("按当前 Session、内容段或选中文字向 AI 提问")
            .accessibilityLabel("打开学习助手")

            Menu {
                Button {
                    Task { await exportMarkdown(manifest) }
                } label: {
                    Label("导出 Markdown", systemImage: "square.and.arrow.up")
                }
                .disabled(isExporting || isImportingImage || isImportingPdf)

                Divider()

                Button {
                    isSelectingImage = true
                } label: {
                    Label("导入图片", systemImage: "photo.badge.plus")
                }
                .disabled(isImportingImage || isImportingPdf)

                Button {
                    isSelectingPdf = true
                } label: {
                    Label("导入 PDF", systemImage: "doc.badge.plus")
                }
                .disabled(isImportingImage || isImportingPdf)
            } label: {
                if isExporting || isImportingImage || isImportingPdf {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 30, height: 30)
                        .frame(width: 40, height: 44)
                } else {
                    Image(systemName: "ellipsis")
                        .frame(width: 30, height: 30)
                        .frame(width: 40, height: 44)
                        .contentShape(Rectangle())
                }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("导入与导出")
            .accessibilityLabel("更多笔记操作")
        }
        .background {
            MathNotesMaterialBackground(shape: Capsule())
                .frame(height: 34)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session-preview-floating-actions")
    }

    private var activityToggle: some View {
        Button {
            isActivityPanelExpanded.toggle()
        } label: {
            Image(systemName: hasActiveSessionActivity ? "arrow.up.arrow.down.circle.fill" : "clock.arrow.circlepath")
                .frame(width: 30, height: 30)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
                .foregroundStyle(hasActiveSessionActivity ? MathNotesTheme.accent : .primary)
        }
        .buttonStyle(.plain)
        .background {
            MathNotesMaterialBackground(shape: Circle())
                .frame(width: 34, height: 34)
        }
        .help("接收与识别活动")
        .accessibilityLabel(isActivityPanelExpanded ? "收起接收与识别活动" : "展开接收与识别活动")
        .accessibilityIdentifier("session-activity-toggle")
        .popover(isPresented: $isActivityPanelExpanded, arrowEdge: .bottom) {
            sessionActivityPanel
                .frame(width: 360)
                .padding(MathNotesTheme.Spacing.standard)
        }
    }

    private var sessionActivityPanel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
                if let upload = companionUploadActivity {
                    companionUploadActivityCard(upload)
                }
                if let task = recognitionActivity, dismissedRecognitionTaskID != task.id {
                    recognitionActivityCard(task)
                }
                ForEach(recentRecognitionTasks.filter { $0.id != recognitionActivity?.id }.prefix(6)) { task in
                    compactRecognitionHistoryRow(task)
                }
                if companionUploadActivity == nil && recentRecognitionTasks.isEmpty {
                    Text("还没有接收或识别记录")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(MathNotesTheme.Spacing.section)
                }
            }
        }
        .frame(maxHeight: 440)
        .accessibilityIdentifier("session-activity-panel")
    }

    private var hasActiveSessionActivity: Bool {
        companionUploadActivity?.status == "receiving" || recognitionActivity?.isTerminal == false
    }

    private func compactRecognitionHistoryRow(_ task: SessionRecognitionTask) -> some View {
        HStack(spacing: MathNotesTheme.Spacing.compact) {
            Image(systemName: task.status == "succeeded" ? "checkmark.circle" : "exclamationmark.triangle")
                .foregroundStyle(task.status == "succeeded" ? MathNotesTheme.accent : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(recognitionActivityTitle(task))
                    .font(.caption.weight(.medium))
                Text(task.updatedAt)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(MathNotesTheme.Spacing.standard)
        .frame(maxWidth: .infinity)
    }

    private func load(showLoading: Bool = true) async {
        if isManifestLoading {
            needsManifestReload = true
            return
        }
        isManifestLoading = true
        defer { isManifestLoading = false }

        repeat {
            needsManifestReload = false
            if showLoading, case .loaded = state {
                // Keep readable content on screen during an explicit refresh.
            } else if showLoading {
                state = .loading
            }
            do {
                let startedAt = Date()
                MacRuntimeDiagnostics.beginSessionOpen(
                    notebookID: session.notebookId,
                    sessionID: session.sessionId
                )
                let manifest = try await supervisor.fetchSessionManifest(session)
                MacRuntimeDiagnostics.recordSessionOpen(
                    notebookID: session.notebookId,
                    sessionID: session.sessionId,
                    milliseconds: Int(Date().timeIntervalSince(startedAt) * 1_000),
                    blockCount: manifest.blocks.count
                )
                applyManifest(manifest)
            } catch is CancellationError {
                return
            } catch {
                MacRuntimeDiagnostics.recordSessionOpenFailure(
                    reason: error is SidecarProtocolError ? "sidecar_protocol" : "unexpected_error"
                )
                if showLoading, case .loaded = state {
                    recognitionActivityMessage = "正文刷新暂时失败，将随下一次活动重试。"
                } else if showLoading {
                    state = .failed(error.localizedDescription)
                } else {
                    recognitionActivityMessage = "正文刷新暂时失败，将随下一次活动重试。"
                }
            }
        } while needsManifestReload && !Task.isCancelled
    }

    private func refreshManifestAfterActivity() async {
        await load(showLoading: false)
        supervisor.reloadCatalog()
    }

    private func activityPollDelay(hasActiveTask: Bool, upload: SessionCompanionUploadActivity?) -> Duration {
        if hasActiveTask || upload?.status == "receiving" { return .milliseconds(120) }
        return NSApp.isActive ? .seconds(8) : .seconds(30)
    }

    private func activeRecognitionCandidate(
        tasks: [SessionRecognitionTask],
        knownTaskIDs: Set<String>,
        baselineLoaded: Bool
    ) -> SessionRecognitionTask? {
        if let active = tasks.first(where: { !$0.isTerminal }) {
            return active
        }
        if let current = recognitionActivity {
            return tasks.first(where: { $0.id == current.id })
        }
        return baselineLoaded ? tasks.first(where: { !knownTaskIDs.contains($0.id) }) : nil
    }

    private func importImage(_ url: URL) async {
        guard case let .loaded(manifest) = state else { return }
        isImportingImage = true
        importError = nil
        let hasAccess = url.startAccessingSecurityScopedResource()
        defer {
            if hasAccess { url.stopAccessingSecurityScopedResource() }
            isImportingImage = false
        }
        do {
            let bytes = try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: url, options: [.mappedIfSafe])
            }.value
            let result = try await supervisor.importSessionImage(
                session,
                fileName: url.lastPathComponent,
                bytes: bytes,
                baseRevision: manifest.revision
            )
            applyManifest(result.manifest)
        } catch is CancellationError {
            return
        } catch {
            importError = error.localizedDescription
        }
    }

    private func monitorRecognitionActivity() async {
        var knownTaskIDs = Set<String>()
        var baselineLoaded = false
        var activitySequence: Int?
        var refreshedTerminalTaskIDs = Set<String>()

        while !Task.isCancelled {
            do {
                let hadBaseline = baselineLoaded
                let shouldLongPoll = baselineLoaded
                    && recognitionActivity?.isTerminal != false
                    && companionUploadActivity?.status != "receiving"
                let snapshot = try await supervisor.recognitionTaskSnapshot(
                    session,
                    afterActivitySequence: shouldLongPoll ? activitySequence : nil,
                    waitMilliseconds: shouldLongPoll ? 20_000 : 0
                )
                activitySequence = snapshot.activitySequence ?? activitySequence
                let tasks = snapshot.tasks
                let recentTasks = Array(tasks.prefix(8))
                if recentRecognitionTasks != recentTasks {
                    recentRecognitionTasks = recentTasks
                }
                let upload = try await supervisor.companionUploadActivity(session)
                if companionUploadActivity != upload {
                    companionUploadActivity = upload
                }
                let candidate = activeRecognitionCandidate(
                    tasks: tasks,
                    knownTaskIDs: knownTaskIDs,
                    baselineLoaded: baselineLoaded
                )

                if !baselineLoaded {
                    knownTaskIDs = Set(tasks.map(\.id))
                    baselineLoaded = true
                } else {
                    knownTaskIDs.formUnion(tasks.map(\.id))
                }

                if let candidate {
                    if recognitionActivity?.id != candidate.id {
                        if companionUploadActivity != nil {
                            companionUploadActivity = nil
                        }
                        recognitionActivity = candidate
                        recognitionActivityDraft = ""
                        recognitionActivityMessage = candidate.status == "pending"
                            ? "手机素材已写入笔记，等待识别服务。"
                            : "正在接收识别输出。"
                        recognitionActivitySequence = 0
                        dismissedRecognitionTaskID = nil
                        isRecognitionActivityExpanded = false
                        isActivityPanelExpanded = true
                        await load(showLoading: false)
                    } else if recognitionActivity != candidate {
                        recognitionActivity = candidate
                    }

                    let events = try await supervisor.recognitionEvents(
                        session,
                        taskId: candidate.id,
                        afterSequence: recognitionActivitySequence
                    )
                    var appendedDraft = ""
                    var latestSequence = recognitionActivitySequence
                    var latestTask = recognitionActivity
                    var latestMessage = recognitionActivityMessage
                    for event in events {
                        latestSequence = max(latestSequence, event.sequence)
                        latestTask = event.task
                        latestMessage = event.message
                        if event.type == "stdout", let delta = event.delta {
                            appendedDraft += delta
                        }
                    }
                    recognitionActivitySequence = latestSequence
                    if recognitionActivity != latestTask { recognitionActivity = latestTask }
                    if recognitionActivityMessage != latestMessage { recognitionActivityMessage = latestMessage }
                    if !appendedDraft.isEmpty {
                        recognitionActivityDraft += appendedDraft
                        sourceWorkspace.setRecognitionDraft(
                            recognitionActivityDraft,
                            blockID: latestTask?.transcriptBlockId ?? candidate.transcriptBlockId
                        )
                    }

                    if let current = recognitionActivity,
                       current.isTerminal,
                       !refreshedTerminalTaskIDs.contains(current.id) {
                        refreshedTerminalTaskIDs.insert(current.id)
                        await refreshManifestAfterActivity()
                        if case let .loaded(manifest) = state,
                           let finalBlock = manifest.blocks.first(where: { $0.id == current.transcriptBlockId }) {
                            await sourceWorkspace.load(
                                session: session,
                                block: finalBlock,
                                supervisor: supervisor,
                                force: true
                            )
                        }
                        sourceWorkspace.clearRecognitionDraft(blockID: current.transcriptBlockId)
                    }
                }
                if upload?.status == "receiving" {
                    isActivityPanelExpanded = true
                }
                if !hadBaseline || shouldLongPoll {
                    continue
                }
                try await Task.sleep(for: activityPollDelay(
                    hasActiveTask: candidate?.isTerminal == false,
                    upload: upload
                ))
            } catch is CancellationError {
                return
            } catch {
                recognitionActivityMessage = "活动同步暂时中断，正在自动重试。"
                try? await Task.sleep(for: NSApp.isActive ? .seconds(8) : .seconds(30))
            }
        }
    }

    private func companionUploadActivityCard(_ activity: SessionCompanionUploadActivity) -> some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text(activity.status == "receiving" ? "正在接收手机素材" : "素材已到达，正在写入笔记")
                        .font(.callout.weight(.semibold))
                    if let fileName = activity.fileName {
                        Text(fileName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            if let progress = activity.progress {
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
            } else {
                ProgressView()
                    .progressViewStyle(.linear)
            }
            HStack {
                Text(ByteCountFormatter.string(fromByteCount: Int64(activity.receivedBytes), countStyle: .file))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                if let totalBytes = activity.totalBytes, totalBytes > 0 {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(totalBytes), countStyle: .file))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(MathNotesTheme.Spacing.standard)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("session-companion-upload-activity")
    }

    private func recognitionActivityCard(_ task: SessionRecognitionTask) -> some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                if task.isTerminal {
                    Image(systemName: task.status == "succeeded" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(task.status == "succeeded" ? MathNotesTheme.accent : MathNotesTheme.failure)
                } else {
                    ProgressView().controlSize(.small)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(recognitionActivityTitle(task))
                        .font(.callout.weight(.semibold))
                    Text(recognitionActivityDetail(task))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: MathNotesTheme.Spacing.section)
                Button {
                    isRecognitionActivityExpanded.toggle()
                } label: {
                    Image(systemName: isRecognitionActivityExpanded ? "chevron.down" : "chevron.up")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isRecognitionActivityExpanded ? "收起识别活动" : "展开识别活动")
                if task.isTerminal {
                    Button {
                        dismissedRecognitionTaskID = task.id
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭识别活动")
                }
            }

            if isRecognitionActivityExpanded {
                Divider()
                if !recognitionActivityDraft.isEmpty {
                    ScrollView {
                        Text(recognitionActivityDraft)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                    .frame(maxHeight: 150)
                } else {
                    Text(task.status == "pending" ? "等待识别服务输出……" : "正在等待第一段文字……")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    if let provider = task.providerName {
                        Text(provider)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    if let firstOutputMs = task.timing?.firstOutputMs {
                        Text("首字 \(firstOutputMs) ms")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    if task.canCancel {
                        Button("中断") {
                            Task {
                                recognitionActivity = try? await supervisor.cancelRecognition(
                                    session,
                                    taskId: task.id
                                )
                            }
                        }
                    }
                }
            }
        }
        .padding(MathNotesTheme.Spacing.standard)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("session-recognition-activity")
    }

    private func recognitionActivityTitle(_ task: SessionRecognitionTask) -> String {
        switch task.status {
        case "pending": "手机素材已接收"
        case "running": "正在识别并更新笔记"
        case "succeeded": "识别完成，笔记已更新"
        case "cancelled": "识别已中断"
        default: "识别没有完成"
        }
    }

    private func recognitionActivityDetail(_ task: SessionRecognitionTask) -> String {
        if task.status == "failed", let reason = task.error?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
            return reason
        }
        if task.status == "cancelled" { return "任务已中断，素材仍保留在笔记中。" }
        return recognitionActivityMessage
    }

    private func importPdf(_ url: URL) async {
        guard case let .loaded(manifest) = state else { return }
        isImportingPdf = true
        importError = nil
        let hasAccess = url.startAccessingSecurityScopedResource()
        defer {
            if hasAccess { url.stopAccessingSecurityScopedResource() }
            isImportingPdf = false
        }
        do {
            let bytes = try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: url, options: [.mappedIfSafe])
            }.value
            let result = try await supervisor.importSessionPdf(
                session,
                fileName: url.lastPathComponent,
                bytes: bytes,
                baseRevision: manifest.revision
            )
            applyManifest(result.manifest)
        } catch is CancellationError {
            return
        } catch {
            importError = error.localizedDescription
        }
    }

    private func exportMarkdown(_ manifest: ReadonlySessionManifest) async {
        isExporting = true
        exportError = nil
        exportNotice = nil
        defer { isExporting = false }
        do {
            let exported = try await supervisor.createSessionExport(session, baseRevision: manifest.revision)
            let bytes = try await supervisor.downloadSessionExport(session)
            let panel = NSSavePanel()
            panel.title = "导出 Markdown"
            panel.nameFieldStringValue = exported.fileName
            panel.allowedContentTypes = [.plainText]
            panel.canCreateDirectories = true
            let preferredExportURL = DirectoryBookmarkStore.resolvedURL(for: .defaultExport)
            let hasExportAccess = preferredExportURL?.startAccessingSecurityScopedResource() ?? false
            if let preferredExportURL { panel.directoryURL = preferredExportURL }
            defer {
                if hasExportAccess { preferredExportURL?.stopAccessingSecurityScopedResource() }
            }
            guard panel.runModal() == .OK, let target = panel.url else { return }
            let hasTargetAccess = target.startAccessingSecurityScopedResource()
            defer { if hasTargetAccess { target.stopAccessingSecurityScopedResource() } }
            try bytes.write(to: target, options: .atomic)
            exportNotice = "已保存 \(exported.exportedBlocks) 个内容段。"
        } catch is CancellationError {
            return
        } catch {
            exportError = error.localizedDescription
        }
    }

    private var compactPane: WorkbenchPane {
        WorkbenchPane(rawValue: compactPaneRawValue) ?? .preview
    }

    private var compactPaneBinding: Binding<WorkbenchPane> {
        Binding(
            get: { compactPane },
            set: { compactPaneRawValue = $0.rawValue }
        )
    }

    private var displayMode: WorkbenchDisplayMode {
        WorkbenchDisplayMode(rawValue: displayModeRawValue) ?? .split
    }

    private func applyManifest(_ manifest: ReadonlySessionManifest) {
        sourceWorkspace.prepare(sessionID: session.id, revision: manifest.revision, blocks: manifest.blocks)
        let visibleIDs = Set(manifest.blocks.filter(\.renderInNote).map(\.id))
        if selectedBlockID == nil || !visibleIDs.contains(selectedBlockID ?? "") {
            selectedBlockID = manifest.blocks.first(where: \.renderInNote)?.id
        }
        state = .loaded(manifest)
    }
}

private enum WorkbenchPane: String, CaseIterable, Identifiable {
    case source
    case preview

    var id: String { rawValue }
    var label: String { self == .source ? "源码" : "预览" }
    var systemImage: String { self == .source ? "chevron.left.forwardslash.chevron.right" : "doc.richtext" }
}

@MainActor
private final class SessionSourceWorkspace: ObservableObject {
    @Published private(set) var payloads: [String: ReadonlySessionBlock] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var loadingIDs: Set<String> = []
    @Published private(set) var savingIDs: Set<String> = []
    @Published var drafts: [String: String] = [:]
    @Published private(set) var originals: [String: String] = [:]
    @Published private(set) var hasDirtyDrafts = false
    @Published private(set) var selectedExcerpt = ""
    @Published private(set) var selectedExcerptBlockID: String?
    @Published private(set) var recognitionDrafts: [String: String] = [:]

    private var sessionID: String?
    private var revision: String?
    private var loadedUpdatedAt: [String: String] = [:]

    func prepare(sessionID: String, revision: String, blocks: [SessionBlockManifest]) {
        if self.sessionID != sessionID {
            self.sessionID = sessionID
            self.revision = revision
            payloads.removeAll()
            errors.removeAll()
            loadingIDs.removeAll()
            savingIDs.removeAll()
            drafts.removeAll()
            originals.removeAll()
            selectedExcerpt = ""
            selectedExcerptBlockID = nil
            recognitionDrafts.removeAll()
            loadedUpdatedAt.removeAll()
            hasDirtyDrafts = false
            return
        }

        if self.revision != revision {
            // Keep the last complete projection mounted while clean blocks refresh.
            // `load` replaces clean drafts and preserves only genuinely dirty ones.
            self.revision = revision
        }

        let validIDs = Set(blocks.map(\.id))
        payloads = payloads.filter { validIDs.contains($0.key) }
        errors = errors.filter { validIDs.contains($0.key) }
        loadingIDs.formIntersection(validIDs)
        savingIDs.formIntersection(validIDs)
        drafts = drafts.filter { validIDs.contains($0.key) }
        originals = originals.filter { validIDs.contains($0.key) }
        recognitionDrafts = recognitionDrafts.filter { validIDs.contains($0.key) }
        loadedUpdatedAt = loadedUpdatedAt.filter { validIDs.contains($0.key) }
        if let selectedExcerptBlockID, !validIDs.contains(selectedExcerptBlockID) {
            selectedExcerpt = ""
            self.selectedExcerptBlockID = nil
        }
        refreshDirtyState()
    }

    func load(
        session: SessionCatalogItem,
        block: SessionBlockManifest,
        supervisor: SidecarSupervisor,
        force: Bool = false
    ) async {
        if !force, payloads[block.id] != nil, loadedUpdatedAt[block.id] == block.updatedAt { return }
        guard !loadingIDs.contains(block.id) else { return }
        loadingIDs.insert(block.id)
        errors[block.id] = nil
        let preserveDraft = isDirty(blockID: block.id)
        defer { loadingIDs.remove(block.id) }
        do {
            let payload = try await supervisor.fetchSessionBlock(session, blockId: block.id)
            store(payload, resetDraft: !preserveDraft)
        } catch is CancellationError {
            return
        } catch {
            errors[block.id] = error.localizedDescription
        }
    }

    func setDraft(_ markdown: String, blockID: String) {
        drafts[blockID] = markdown
        refreshDirtyState()
    }

    func setSelection(_ selection: String, blockID: String) {
        selectedExcerpt = selection
        selectedExcerptBlockID = selection.isEmpty ? nil : blockID
    }

    func activate(blockID: String) {
        guard selectedExcerptBlockID != nil, selectedExcerptBlockID != blockID else { return }
        selectedExcerpt = ""
        selectedExcerptBlockID = nil
    }

    func setRecognitionDraft(_ markdown: String, blockID: String) {
        recognitionDrafts[blockID] = markdown
    }

    func clearRecognitionDraft(blockID: String) {
        recognitionDrafts[blockID] = nil
    }

    func resetDraft(blockID: String) {
        drafts[blockID] = originals[blockID]
        refreshDirtyState()
    }

    func isDirty(blockID: String) -> Bool {
        guard let draft = drafts[blockID], let original = originals[blockID] else { return false }
        return draft != original
    }

    func beginSaving(blockID: String) { savingIDs.insert(blockID) }
    func endSaving(blockID: String) { savingIDs.remove(blockID) }

    func applySaved(_ payload: ReadonlySessionBlock) {
        store(payload, resetDraft: true)
    }

    private func store(_ payload: ReadonlySessionBlock, resetDraft: Bool) {
        payloads[payload.block.id] = payload
        loadedUpdatedAt[payload.block.id] = payload.block.updatedAt
        errors[payload.block.id] = nil
        guard case let .markdown(markdown) = payload.content else { return }
        originals[payload.block.id] = markdown.markdown
        if resetDraft { drafts[payload.block.id] = markdown.markdown }
        refreshDirtyState()
    }

    private func refreshDirtyState() {
        hasDirtyDrafts = drafts.contains { blockID, draft in
            originals[blockID].map { $0 != draft } ?? false
        }
    }
}

private struct SessionSourcePane: View {
    let session: SessionCatalogItem
    let manifest: ReadonlySessionManifest
    let blocks: [SessionBlockManifest]
    @Binding var selectedBlockID: String?
    @ObservedObject var workspace: SessionSourceWorkspace
    @ObservedObject var supervisor: SidecarSupervisor
    let onReordered: (ReadonlySessionManifest) -> Void
    let onSessionChanged: () async -> Void
    @State private var batchSelection: Set<String> = []
    @State private var isOrganizing = false
    @State private var organizeStatus: String?
    @State private var organizeFailed = false
    @State private var pendingMoveTarget: SessionTransferTarget?
    @State private var isSelectionMode = false

    var body: some View {
        VStack(spacing: 0) {
            if blocks.isEmpty {
                ContentUnavailableView(
                    "还没有源码块",
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    description: Text("导入素材或添加 Markdown 后会显示在这里。")
                )
            } else {
                if isSelectionMode {
                    organizeBar
                    Divider()
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        Group {
                            if blocks.count <= 40 {
                                VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
                                    sourceRows
                                }
                            } else {
                                LazyVStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
                                    sourceRows
                                }
                            }
                        }
                        .padding(MathNotesTheme.Spacing.standard)
                    }
                }
            }
        }
        .background(MathNotesTheme.canvas)
        .accessibilityLabel("Session \(manifest.title) 的 Markdown 源码")
        .onChange(of: blocks.map(\.id)) { _, blockIDs in
            batchSelection.formIntersection(Set(blockIDs))
            if batchSelection.isEmpty { isSelectionMode = false }
        }
        .confirmationDialog(
            "移动 \(batchSelection.count) 个内容段？",
            isPresented: Binding(
                get: { pendingMoveTarget != nil },
                set: { if !$0 { pendingMoveTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let target = pendingMoveTarget {
                Button("移动到 \(target.label)", role: .destructive) {
                    pendingMoveTarget = nil
                    Task { await transfer(to: target.session, mode: "move") }
                }
            }
            Button("取消", role: .cancel) { pendingMoveTarget = nil }
        } message: {
            Text("目标写入成功后才会清理当前 Session；如果清理失败，目标副本仍会保留并明确提示。")
        }
    }

    @ViewBuilder
    private var sourceRows: some View {
        ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
            SessionSourceBlockView(
                session: session,
                sessionRevision: manifest.revision,
                manifest: block,
                displayOrdinal: index + 1,
                isActive: selectedBlockID == block.id,
                isBatchSelected: batchSelection.contains(block.id),
                isSelectionMode: isSelectionMode,
                workspace: workspace,
                supervisor: supervisor,
                onActivate: { selectedBlockID = block.id },
                onToggleBatchSelection: {
                    if batchSelection.contains(block.id) {
                        batchSelection.remove(block.id)
                    } else {
                        batchSelection.insert(block.id)
                    }
                },
                onBeginBatchSelection: {
                    isSelectionMode = true
                    batchSelection.insert(block.id)
                },
                onManifestChanged: onReordered,
                onSessionChanged: onSessionChanged
            )
            .id(block.id)
        }
    }

    private var organizeBar: some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                Button(batchSelection.count == blocks.count ? "取消全选" : "全选") {
                    if batchSelection.count == blocks.count {
                        batchSelection.removeAll()
                    } else {
                        batchSelection = Set(blocks.map(\.id))
                    }
                }
                .buttonStyle(.borderless)

                Button("退出多选") {
                    batchSelection.removeAll()
                    isSelectionMode = false
                }
                .buttonStyle(.borderless)

                Spacer()

                Button {
                    Task { await reorder("up") }
                } label: {
                    Label("上移", systemImage: "arrow.up")
                }
                .disabled(!canOrganize)
                .help("将所选内容段整体上移；显示编号会按新顺序重新从 1 排列")

                Button {
                    Task { await reorder("down") }
                } label: {
                    Label("下移", systemImage: "arrow.down")
                }
                .disabled(!canOrganize)
                .help("将所选内容段整体下移；显示编号会按新顺序重新从 1 排列")

                Menu {
                    if transferTargets.isEmpty {
                        Text("请先新建另一个 Session")
                    } else {
                        Menu("复制到") {
                            ForEach(transferTargets) { target in
                                Button(target.label) {
                                    Task { await transfer(to: target.session, mode: "copy") }
                                }
                            }
                        }
                        Menu("移动到") {
                            ForEach(transferTargets) { target in
                                Button(target.label) {
                                    pendingMoveTarget = target
                                }
                            }
                        }
                    }
                } label: {
                    Label("发送到", systemImage: "arrow.right.doc.on.clipboard")
                }
                .disabled(!canOrganize || transferTargets.isEmpty)
            }

            if workspace.hasDirtyDrafts {
                Label("请先保存或还原源码草稿，再整理内容段。", systemImage: "pencil.and.list.clipboard")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let organizeStatus {
                Label(organizeStatus, systemImage: organizeFailed ? "exclamationmark.triangle" : "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(organizeFailed ? MathNotesTheme.failure : MathNotesTheme.accent)
            }
        }
        .padding(.horizontal, MathNotesTheme.Spacing.section)
        .padding(.vertical, MathNotesTheme.Spacing.compact)
        .background(MathNotesTheme.sidebar.opacity(0.24))
        .accessibilityIdentifier("session-block-organize-bar")
    }

    private var canOrganize: Bool {
        !batchSelection.isEmpty && !workspace.hasDirtyDrafts && !isOrganizing
    }

    private var selectedBlockIDsInOrder: [String] {
        blocks.compactMap { batchSelection.contains($0.id) ? $0.id : nil }
    }

    private var transferTargets: [SessionTransferTarget] {
        guard case let .loaded(notebooks) = supervisor.catalogState else { return [] }
        return notebooks.flatMap { notebook in
            notebook.sessions.compactMap { candidate in
                guard candidate.id != session.id else { return nil }
                return SessionTransferTarget(
                    session: candidate,
                    label: "\(notebook.title) / \(candidate.title)"
                )
            }
        }
    }

    private func reorder(_ direction: String) async {
        let ids = selectedBlockIDsInOrder
        guard !ids.isEmpty else { return }
        isOrganizing = true
        organizeStatus = nil
        defer { isOrganizing = false }
        do {
            let reordered = try await supervisor.reorderSessionBlocks(
                session,
                blockIds: ids,
                direction: direction
            )
            onReordered(reordered)
            organizeFailed = false
            organizeStatus = direction == "up" ? "所选内容段已上移。" : "所选内容段已下移。"
        } catch {
            organizeFailed = true
            organizeStatus = error.localizedDescription
        }
    }

    private func transfer(to target: SessionCatalogItem, mode: String) async {
        let ids = selectedBlockIDsInOrder
        guard !ids.isEmpty else { return }
        isOrganizing = true
        organizeStatus = nil
        defer { isOrganizing = false }
        do {
            let response = try await supervisor.transferSessionBlocks(
                session,
                target: target,
                blockIds: ids,
                mode: mode
            )
            organizeFailed = response.sourceCleanupPending
            organizeStatus = response.sourceCleanupPending
                ? "已复制到目标，但源 Session 清理尚未完成；请不要重复操作。"
                : mode == "move" ? "所选内容段已移动。" : "所选内容段已复制。"
            if mode == "move" && !response.sourceCleanupPending {
                batchSelection.removeAll()
            }
            await onSessionChanged()
        } catch {
            organizeFailed = true
            organizeStatus = error.localizedDescription
        }
    }
}

private enum WorkbenchDisplayMode: String {
    case split
    case reading
}

private struct SessionSourceBlockView: View {
    let session: SessionCatalogItem
    let sessionRevision: String
    let manifest: SessionBlockManifest
    let displayOrdinal: Int
    let isActive: Bool
    let isBatchSelected: Bool
    let isSelectionMode: Bool
    @ObservedObject var workspace: SessionSourceWorkspace
    @ObservedObject var supervisor: SidecarSupervisor
    let onActivate: () -> Void
    let onToggleBatchSelection: () -> Void
    let onBeginBatchSelection: () -> Void
    let onManifestChanged: (ReadonlySessionManifest) -> Void
    let onSessionChanged: () async -> Void
    @State private var errorMessage: String?
    @State private var conflictID: String?
    @State private var conflict: SessionMarkdownConflict?
    @State private var isLoadingConflict = false
    @State private var recognitionTask: SessionRecognitionTask?
    @State private var recognitionError: String?
    @State private var assetPreview: SessionAssetPreview?
    @State private var blockActionError: String?
    @State private var isConfirmingDelete = false
    @State private var isHovering = false
    @State private var editorMeasuredHeight: CGFloat = 96
    @AppStorage(MacPreferenceKeys.sourceFont) private var sourceFontRawValue = MacSourceFontPreset.systemMono.rawValue
    @AppStorage(MacPreferenceKeys.sourceFontSize) private var sourceFontSize = MacTypographyPreferences.defaultSourceSize

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                if isSelectionMode {
                    Button(action: onToggleBatchSelection) {
                        Image(systemName: isBatchSelected ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(isBatchSelected ? MathNotesTheme.accent : .secondary)
                    }
                    .buttonStyle(.plain)
                    .help(isBatchSelected ? "取消选择这个内容段" : "选择这个内容段以便整理")
                    .accessibilityLabel(isBatchSelected ? "取消选择内容段 \(displayOrdinal)" : "选择内容段 \(displayOrdinal)")
                }

                Button(action: activateHeader) {
                    HStack(spacing: MathNotesTheme.Spacing.compact) {
                        Image(systemName: blockIcon)
                            .foregroundStyle(MathNotesTheme.accent)
                        Text(sourceLabel)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                        Spacer(minLength: MathNotesTheme.Spacing.compact)
                        Text(String(format: "%04d", displayOrdinal))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .draggable("mathnotes-block:\(manifest.id)")
                .contextMenu {
                    Button(action: onBeginBatchSelection) {
                        Label("多选内容段", systemImage: "checklist")
                    }
                    if assetPreviewValue != nil {
                        Button {
                            assetPreview = assetPreviewValue
                        } label: {
                            Label("预览原始素材", systemImage: "eye")
                        }
                    }
                    if manifest.source == "ai_transcription" {
                        Button {
                            Task { await startRecognition() }
                        } label: {
                            Label("重新识别这个块", systemImage: "arrow.clockwise")
                        }
                        .disabled(markdownLockState == true)
                    }
                    if let isLocked = markdownLockState {
                        Divider()
                        Button {
                            Task { await setBlockLock(!isLocked) }
                        } label: {
                            Label(isLocked ? "解除固定" : "固定这个块", systemImage: isLocked ? "lock.open" : "lock")
                        }
                        .disabled(workspace.isDirty(blockID: manifest.id))
                    }
                    Divider()
                    Button(role: .destructive) {
                        isConfirmingDelete = true
                    } label: {
                        Label("删除这个块", systemImage: "trash")
                    }
                    .disabled(workspace.isDirty(blockID: manifest.id) || markdownLockState == true)
                }
            }
            .padding(.horizontal, MathNotesTheme.Spacing.standard)
            .frame(height: 32)

            Divider()
            sourceBody
        }
        .background(isActive ? MathNotesTheme.accentSoft.opacity(0.28) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))
        .overlay {
            RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control)
                .strokeBorder(
                    isActive ? MathNotesTheme.accent.opacity(0.72) : Color.primary.opacity(isHovering ? 0.08 : 0),
                    lineWidth: 1
                )
        }
        .contentShape(Rectangle())
        .onHover { isHovering = $0 }
        .task(id: "\(session.id):\(manifest.id):\(manifest.updatedAt)") {
            await workspace.load(
                session: session,
                block: manifest,
                supervisor: supervisor,
                force: false
            )
        }
        .sheet(item: $recognitionTask) { task in
            RecognitionTaskSheet(
                initialTask: task,
                session: session,
                supervisor: supervisor,
                onSessionChanged: onSessionChanged
            )
        }
        .sheet(item: $conflict) { conflict in
            MarkdownConflictResolutionSheet(
                conflict: conflict,
                onResolve: { resolution, merged in
                    let response = try await supervisor.resolveMarkdownConflict(
                        session,
                        conflictId: conflict.id,
                        resolution: resolution,
                        baseRevision: conflict.currentRevision,
                        markdown: merged
                    )
                    workspace.applySaved(response.block)
                    await onSessionChanged()
                    return response
                }
            )
        }
        .sheet(item: $assetPreview) { preview in
            SessionAssetPreviewSheet(
                preview: preview,
                session: session,
                supervisor: supervisor
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("源码内容段 \(displayOrdinal)，\(manifest.sourceName)")
        .alert("无法识别", isPresented: Binding(
            get: { recognitionError != nil },
            set: { if !$0 { recognitionError = nil } }
        )) {
            Button("好", role: .cancel) { recognitionError = nil }
        } message: {
            Text(recognitionError ?? "未知错误")
        }
        .alert("无法更改固定状态", isPresented: Binding(
            get: { blockActionError != nil },
            set: { if !$0 { blockActionError = nil } }
        )) {
            Button("好", role: .cancel) { blockActionError = nil }
        } message: {
            Text(blockActionError ?? "未知错误")
        }
        .alert("删除这个内容段？", isPresented: $isConfirmingDelete) {
            Button("删除内容段", role: .destructive) {
                Task { await deleteBlock() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这个内容段将从当前笔记移除。")
        }
    }

    @ViewBuilder
    private var sourceBody: some View {
        if let payload = workspace.payloads[manifest.id] {
            payloadBody(payload)
        } else if workspace.loadingIDs.contains(manifest.id) {
            HStack(spacing: MathNotesTheme.Spacing.standard) {
                ProgressView().controlSize(.small)
                Text("正在读取源码").foregroundStyle(.secondary)
            }
            .padding(MathNotesTheme.Spacing.standard)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        } else if let message = workspace.errors[manifest.id] {
            HStack {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(MathNotesTheme.failure)
                Spacer()
                Button("重试") {
                    Task { await workspace.load(session: session, block: manifest, supervisor: supervisor, force: true) }
                }
            }
            .padding(MathNotesTheme.Spacing.standard)
        } else {
            Color.clear.frame(height: 72)
        }
    }

    @ViewBuilder
    private func payloadBody(_ payload: ReadonlySessionBlock) -> some View {
        switch payload.content {
        case let .markdown(markdown):
            if let live = workspace.recognitionDrafts[manifest.id] {
                Text(live.isEmpty ? "等待识别内容……" : live)
                    .font(activeSourceFont)
                    .foregroundStyle(live.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(MathNotesTheme.Spacing.standard)
            } else if manifest.editable, !markdown.blockLocked {
                markdownEditor(markdown)
            } else {
                VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
                    if markdown.blockLocked {
                        Label("这个内容段已固定", systemImage: "lock.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(markdown.markdown.isEmpty ? "（空白 Markdown 块）" : markdown.markdown)
                        .font(activeSourceFont)
                        .foregroundStyle(markdown.markdown.isEmpty ? .tertiary : .primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .padding(MathNotesTheme.Spacing.standard)
            }
        case let .image(assetPath, _):
            sourceReference(kind: "图片素材", path: assetPath)
        case let .pdf(assetPath, _):
            sourceReference(kind: "PDF 素材", path: assetPath)
        }
    }

    private func markdownEditor(_ markdown: MarkdownBlockContent) -> some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
            SelectionAwareTextEditor(
                text: draftBinding(fallback: markdown.markdown),
                selectedText: selectionBinding,
                contentHeight: $editorMeasuredHeight,
                fontPreset: sourceFontRawValue,
                fontSize: sourceFontSize,
                onActivate: onActivate
            )
                .frame(
                    height: max(
                        editorMeasuredHeight,
                        estimatedEditorHeight(
                            markdown: workspace.drafts[manifest.id] ?? markdown.markdown
                        )
                    )
                )
                .padding(MathNotesTheme.Spacing.compact)
                .background(MathNotesTheme.canvas)
                .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))

            if let errorMessage {
                HStack(alignment: .firstTextBaseline) {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(MathNotesTheme.failure)
                        .textSelection(.enabled)
                    Spacer()
                    if conflictID != nil {
                        Button(isLoadingConflict ? "正在读取…" : "比较版本") {
                            Task { await loadConflict() }
                        }
                        .disabled(isLoadingConflict)
                    }
                }
            }

            HStack {
                if markdown.protectedSpanCount > 0 {
                    Label("\(markdown.protectedSpanCount) 处固定内容", systemImage: "lock.shield")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("还原") { workspace.resetDraft(blockID: manifest.id) }
                    .disabled(!workspace.isDirty(blockID: manifest.id) || isSaving)
                Button("保存当前块") { Task { await save(markdown) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!workspace.isDirty(blockID: manifest.id) || isSaving)
            }
        }
        .padding(MathNotesTheme.Spacing.compact)
    }

    private func sourceReference(kind: String, path: String) -> some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            Image(systemName: blockIcon)
                .foregroundStyle(MathNotesTheme.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(kind).font(.callout.weight(.medium))
                Text(path)
                    .font(activeSourceFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
        }
        .padding(MathNotesTheme.Spacing.standard)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func draftBinding(fallback: String) -> Binding<String> {
        Binding(
            get: { workspace.drafts[manifest.id] ?? fallback },
            set: {
                onActivate()
                workspace.setDraft($0, blockID: manifest.id)
            }
        )
    }

    private var selectionBinding: Binding<String> {
        Binding(
            get: {
                workspace.selectedExcerptBlockID == manifest.id
                    ? workspace.selectedExcerpt
                    : ""
            },
            set: { workspace.setSelection($0, blockID: manifest.id) }
        )
    }

    private var isSaving: Bool { workspace.savingIDs.contains(manifest.id) }

    private func estimatedEditorHeight(markdown: String) -> CGFloat {
        let lineCount = markdown.reduce(into: 1) { count, character in
            if character == "\n" { count += 1 }
        }
        let lineHeight = CGFloat(min(24, max(10, sourceFontSize)) * 1.48)
        return max(96, CGFloat(lineCount) * lineHeight + 22)
    }

    private var activeSourceFont: Font {
        let preset = MacSourceFontPreset(rawValue: sourceFontRawValue) ?? .systemMono
        return preset.font(size: min(24, max(10, sourceFontSize)))
    }

    private func save(_ markdown: MarkdownBlockContent) async {
        guard let draft = workspace.drafts[manifest.id] else { return }
        workspace.beginSaving(blockID: manifest.id)
        errorMessage = nil
        conflictID = nil
        defer { workspace.endSaving(blockID: manifest.id) }
        do {
            let saved = try await supervisor.saveMarkdownBlock(
                session,
                blockId: manifest.id,
                markdown: draft,
                baseRevision: markdown.baseRevision
            )
            workspace.applySaved(saved)
            await onSessionChanged()
        } catch {
            errorMessage = error.localizedDescription
            if let protocolError = error as? SidecarProtocolError,
               case let .saveRejected(_, "revision_conflict", storedConflictID) = protocolError {
                conflictID = storedConflictID
            }
        }
    }

    private func loadConflict() async {
        guard let conflictID else { return }
        isLoadingConflict = true
        defer { isLoadingConflict = false }
        do {
            conflict = try await supervisor.fetchMarkdownConflict(session, conflictId: conflictID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private var sourceLabel: String {
        switch manifest.source {
        case "ai_transcription": "识别草稿 · \(manifest.sourceName)"
        case "user", "user_revision": "用户笔记"
        case "pdf_import": "PDF · \(manifest.sourceName)"
        default: manifest.sourceName
        }
    }

    private var blockIcon: String {
        switch manifest.type {
        case "pdf": "doc.richtext"
        case "image": "photo"
        default: "text.alignleft"
        }
    }

    private func activateHeader() {
        onActivate()
        if let preview = assetPreviewValue {
            assetPreview = preview
        }
    }

    private var assetPreviewValue: SessionAssetPreview? {
        if let assetPath = manifest.sourceAssetPaths?.first {
            return SessionAssetPreview(id: manifest.id, kind: .image, assetPath: assetPath)
        }
        if let pageImagePath = manifest.sourcePageImagePath {
            return SessionAssetPreview(id: manifest.id, kind: .image, assetPath: pageImagePath)
        }
        guard let payload = workspace.payloads[manifest.id] else { return nil }
        switch payload.content {
        case let .image(assetPath, _):
            return SessionAssetPreview(id: manifest.id, kind: .image, assetPath: assetPath)
        case let .pdf(assetPath, _):
            return SessionAssetPreview(id: manifest.id, kind: .pdf, assetPath: assetPath)
        case .markdown:
            return nil
        }
    }

    private var markdownLockState: Bool? {
        guard let payload = workspace.payloads[manifest.id],
              case let .markdown(markdown) = payload.content else { return nil }
        return markdown.blockLocked
    }

    private func setBlockLock(_ locked: Bool) async {
        guard !workspace.isDirty(blockID: manifest.id) else {
            blockActionError = "请先保存或还原当前草稿，再更改固定状态。"
            return
        }
        do {
            let payload = try await supervisor.setMarkdownBlockLock(
                session,
                blockId: manifest.id,
                locked: locked
            )
            workspace.applySaved(payload)
            await onSessionChanged()
        } catch {
            blockActionError = error.localizedDescription
        }
    }

    private func deleteBlock() async {
        guard !workspace.isDirty(blockID: manifest.id) else {
            blockActionError = "请先保存或还原当前草稿，再删除内容段。"
            return
        }
        do {
            let updated = try await supervisor.deleteSessionBlocks(
                session,
                blockIds: [manifest.id]
            )
            onManifestChanged(updated)
        } catch {
            blockActionError = error.localizedDescription
        }
    }

    private func startRecognition() async {
        recognitionError = nil
        do {
            recognitionTask = try await supervisor.rerunRecognition(
                session,
                transcriptBlockId: manifest.id
            )
        } catch {
            recognitionError = error.localizedDescription
        }
    }
}

private struct SessionTransferTarget: Identifiable {
    let session: SessionCatalogItem
    let label: String

    var id: String { session.id }
}

private struct SessionAssetPreview: Identifiable {
    enum Kind {
        case image
        case pdf
    }

    let id: String
    let kind: Kind
    let assetPath: String

    var title: String {
        switch kind {
        case .image: "原始图片"
        case .pdf: "原始 PDF"
        }
    }
}

private struct SessionAssetPreviewSheet: View {
    let preview: SessionAssetPreview
    let session: SessionCatalogItem
    @ObservedObject var supervisor: SidecarSupervisor
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(preview.title)
                    .font(.headline)
                Spacer()
                Button("关闭") { dismiss() }
            }
            .padding(MathNotesTheme.Spacing.section)
            Divider()
            Group {
                switch preview.kind {
                case .image:
                    RemoteImageBlock(session: session, assetPath: preview.assetPath, supervisor: supervisor)
                case .pdf:
                    RemotePDFBlock(session: session, assetPath: preview.assetPath, supervisor: supervisor)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 760, minHeight: 620)
        .background(MathNotesTheme.canvas)
    }
}

private struct SessionContinuousPreview: View {
    let session: SessionCatalogItem
    let sessionRevision: String
    let blocks: [SessionBlockManifest]
    @Binding var activeBlockID: String?
    @ObservedObject var workspace: SessionSourceWorkspace
    @ObservedObject var supervisor: SidecarSupervisor
    @State private var liveRenders: [String: LivePreviewRender] = [:]

    var body: some View {
        Group {
            if blocks.isEmpty {
                ContentUnavailableView(
                    "这个 Session 还没有可阅读正文",
                    systemImage: "text.page",
                    description: Text("图片和 PDF 请从左侧内容段标题打开；识别文字会显示在这里。")
                )
            } else if loadedSnapshots.count == blocks.count {
                StableSessionMarkdownWebView(
                    blocks: loadedSnapshots,
                    activeBlockID: $activeBlockID
                )
            } else if let failed = firstFailedBlock {
                ContentUnavailableView {
                    Label("有内容段无法读取", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(workspace.errors[failed.id] ?? "请重新读取这个内容段。")
                } actions: {
                    Button("重新读取") {
                        Task {
                            await workspace.load(
                                session: session,
                                block: failed,
                                supervisor: supervisor,
                                force: true
                            )
                        }
                    }
                }
            } else {
                VStack(spacing: MathNotesTheme.Spacing.standard) {
                    ProgressView()
                    Text("正在准备连续预览")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(MathNotesTheme.canvas)
        .task(id: preloadIdentity) {
            for block in blocks {
                guard !Task.isCancelled else { return }
                await workspace.load(
                    session: session,
                    block: block,
                    supervisor: supervisor,
                    force: false
                )
            }
        }
        .task(id: livePreviewIdentity) {
            await refreshLiveRenders()
        }
        .onChange(of: blocks.map(\.id)) { _, validIDs in
            let valid = Set(validIDs)
            liveRenders = liveRenders.filter { valid.contains($0.key) }
        }
        .accessibilityIdentifier("session-continuous-preview")
    }

    private var preloadIdentity: String {
        "\(session.id):\(sessionRevision):\(blocks.map(\.previewIdentity).joined(separator: "|"))"
    }

    private var livePreviewIdentity: String {
        blocks.map { block in
            let live = liveMarkdown(for: block.id) ?? ""
            return "\(block.id):\(live.utf8.count):\(live.hashValue)"
        }.joined(separator: "|")
    }

    private var loadedSnapshots: [ContinuousMarkdownBlock] {
        blocks.compactMap { block in
            guard let payload = workspace.payloads[block.id],
                  case let .markdown(markdown) = payload.content else { return nil }
            let live = liveMarkdown(for: block.id)
            let document: String
            if let live {
                if let rendered = liveRenders[block.id], rendered.markdown == live {
                    document = rendered.document
                } else if let previous = liveRenders[block.id] {
                    // Keep the last valid live projection mounted while the next delta renders.
                    document = previous.document
                } else {
                    document = markdown.html
                }
            } else {
                document = markdown.html
            }
            return ContinuousMarkdownBlock(
                id: block.id,
                order: block.order,
                html: markdownBodyFragment(document),
                version: "\(block.updatedAt):\(document.utf8.count):\(document.hashValue)"
            )
        }
    }

    private var firstFailedBlock: SessionBlockManifest? {
        blocks.first { workspace.errors[$0.id] != nil }
    }

    private func liveMarkdown(for blockID: String) -> String? {
        if let recognition = workspace.recognitionDrafts[blockID] {
            return recognition
        }
        guard workspace.isDirty(blockID: blockID) else { return nil }
        return workspace.drafts[blockID]
    }

    @MainActor
    private func refreshLiveRenders() async {
        let inputs = blocks.compactMap { block -> (SessionBlockManifest, String)? in
            guard let markdown = liveMarkdown(for: block.id) else { return nil }
            guard liveRenders[block.id]?.markdown != markdown else { return nil }
            return (block, markdown)
        }
        let liveIDs = Set(inputs.map { $0.0.id })
            .union(blocks.compactMap { liveMarkdown(for: $0.id) == nil ? nil : $0.id })
        liveRenders = liveRenders.filter { liveIDs.contains($0.key) }
        for (block, markdown) in inputs {
            guard !Task.isCancelled else { return }
            do {
                let document = try await supervisor.previewMarkdown(
                    session,
                    blockId: block.id,
                    markdown: markdown
                )
                guard !Task.isCancelled, liveMarkdown(for: block.id) == markdown else { continue }
                liveRenders[block.id] = LivePreviewRender(markdown: markdown, document: document)
            } catch is CancellationError {
                return
            } catch {
                // Keep the last valid persisted rendering while the next edit retries.
            }
        }
    }
}

private struct LivePreviewRender: Equatable {
    let markdown: String
    let document: String
}

private struct ContinuousMarkdownBlock: Equatable {
    let id: String
    let order: Int
    let html: String
    let version: String
}

private func markdownBodyFragment(_ document: String) -> String {
    guard let bodyStart = document.range(of: "<body>", options: .caseInsensitive),
          let bodyEnd = document.range(of: "</body>", options: [.caseInsensitive, .backwards]),
          bodyStart.upperBound <= bodyEnd.lowerBound else {
        return document
    }
    var fragment = String(document[bodyStart.upperBound..<bodyEnd.lowerBound])
    if let heightScript = fragment.range(
        of: "<script>const send=",
        options: [.caseInsensitive, .backwards]
    ) {
        fragment.removeSubrange(heightScript.lowerBound..<fragment.endIndex)
    }
    return fragment
}

private struct StableSessionMarkdownWebView: NSViewRepresentable {
    let blocks: [ContinuousMarkdownBlock]
    @Binding var activeBlockID: String?
    @AppStorage(MacPreferenceKeys.previewFont) private var previewFontRawValue = MacPreviewFontPreset.system.rawValue
    @AppStorage(MacPreferenceKeys.previewFontSize) private var previewFontSize = MacTypographyPreferences.defaultPreviewSize
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator {
        Coordinator(activeBlockID: $activeBlockID)
    }

    func makeNSView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "blockActivated")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        context.coordinator.webView = view
        context.coordinator.setDesiredState(
            blocks: blocks,
            activeBlockID: activeBlockID,
            fontFamily: previewFont.cssFamily,
            fontSize: previewFontSize,
            isDark: colorScheme == .dark
        )
        view.loadHTMLString(Self.shellDocument, baseURL: Self.katexBaseURL)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.setDesiredState(
            blocks: blocks,
            activeBlockID: activeBlockID,
            fontFamily: previewFont.cssFamily,
            fontSize: previewFontSize,
            isDark: colorScheme == .dark
        )
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "blockActivated")
        view.navigationDelegate = nil
        coordinator.webView = nil
    }

    private var previewFont: MacPreviewFontPreset {
        MacPreviewFontPreset(rawValue: previewFontRawValue) ?? .system
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        private var activeBlockID: Binding<String?>
        weak var webView: WKWebView?
        private var isReady = false
        private var desiredBlocks: [ContinuousMarkdownBlock] = []
        private var desiredActiveBlockID: String?
        private var desiredFontFamily = MacPreviewFontPreset.system.cssFamily
        private var desiredFontSize = MacTypographyPreferences.defaultPreviewSize
        private var desiredIsDark = false
        private var appliedBlocks: [ContinuousMarkdownBlock] = []
        private var appliedActiveBlockID: String?
        private var appliedFontFamily = ""
        private var appliedFontSize = 0.0
        private var appliedIsDark: Bool?

        init(activeBlockID: Binding<String?>) {
            self.activeBlockID = activeBlockID
        }

        func setDesiredState(
            blocks: [ContinuousMarkdownBlock],
            activeBlockID: String?,
            fontFamily: String,
            fontSize: Double,
            isDark: Bool
        ) {
            desiredBlocks = blocks
            desiredActiveBlockID = activeBlockID
            desiredFontFamily = fontFamily
            desiredFontSize = min(28, max(12, fontSize))
            desiredIsDark = isDark
            applyIfReady()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isReady = true
            appliedBlocks = []
            appliedActiveBlockID = nil
            appliedFontFamily = ""
            appliedFontSize = 0
            appliedIsDark = nil
            applyIfReady()
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "blockActivated",
                  let blockID = message.body as? String,
                  desiredBlocks.contains(where: { $0.id == blockID }) else { return }
            if activeBlockID.wrappedValue != blockID {
                activeBlockID.wrappedValue = blockID
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            navigationAction.navigationType == .linkActivated ? .cancel : .allow
        }

        private func applyIfReady() {
            guard isReady, let webView else { return }
            if desiredBlocks != appliedBlocks {
                let payload = desiredBlocks.map {
                    ["id": $0.id, "html": $0.html, "version": $0.version]
                }
                guard let json = Self.jsonString(payload) else { return }
                webView.evaluateJavaScript("window.MathNotes.updateBlocks(\(json));")
                appliedBlocks = desiredBlocks
            }
            if desiredActiveBlockID != appliedActiveBlockID {
                let activeJSON = Self.jsonString(desiredActiveBlockID) ?? "null"
                webView.evaluateJavaScript("window.MathNotes.setActive(\(activeJSON));")
                appliedActiveBlockID = desiredActiveBlockID
            }
            if desiredFontFamily != appliedFontFamily || desiredFontSize != appliedFontSize {
                let familyJSON = Self.jsonString(desiredFontFamily) ?? "\"-apple-system\""
                webView.evaluateJavaScript(
                    "window.MathNotes.setTypography(\(familyJSON), \(desiredFontSize));"
                )
                appliedFontFamily = desiredFontFamily
                appliedFontSize = desiredFontSize
            }
            if desiredIsDark != appliedIsDark {
                let themeJSON = desiredIsDark ? "\"dark\"" : "\"light\""
                webView.evaluateJavaScript("window.MathNotes.setTheme(\(themeJSON));")
                appliedIsDark = desiredIsDark
            }
        }

        private static func jsonString(_ value: Any?) -> String? {
            let object: Any = value ?? NSNull()
            guard JSONSerialization.isValidJSONObject(["value": object]),
                  let data = try? JSONSerialization.data(
                    withJSONObject: object,
                    options: [.fragmentsAllowed]
                  ),
                  let value = String(data: data, encoding: .utf8) else { return nil }
            return value.replacingOccurrences(of: "</", with: "<\\/")
        }
    }

    private static var katexStylesheetURL: URL? {
        if let packaged = Bundle.main.resourceURL?
            .appendingPathComponent("MathNotesKaTeX", isDirectory: true)
            .appendingPathComponent("katex.min.css"),
           FileManager.default.fileExists(atPath: packaged.path) {
            return packaged
        }
        return Bundle.module.url(
            forResource: "katex.min",
            withExtension: "css",
            subdirectory: "Resources/katex"
        )
    }

    private static var katexBaseURL: URL? {
        katexStylesheetURL?.deletingLastPathComponent()
    }

    private static var katexStylesheet: String {
        guard let url = katexStylesheetURL,
              let stylesheet = try? String(contentsOf: url, encoding: .utf8),
              !stylesheet.isEmpty else {
            // Never let KaTeX's visual HTML and accessibility MathML paint on top
            // of each other if a damaged package is missing the full stylesheet.
            return """
            .katex > .katex-html { display: none !important; }
            .katex > .katex-mathml { display: inline !important; position: static !important; width: auto !important; height: auto !important; overflow: visible !important; clip-path: none !important; }
            .katex-display { display: block; margin: 1em 0; text-align: center; }
            """
        }
        return stylesheet
    }

    private static var shellDocument: String { """
    <!doctype html>
    <html lang="zh-CN">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta name="color-scheme" content="light dark">
      <style id="mathnotes-katex-styles">
        \(katexStylesheet)
      </style>
      <style>
        :root {
          color-scheme: light dark;
          --ink: #242520;
          --muted: #66675f;
          --line: #d9ddd7;
          --code: #f1f2ee;
          --quote: #6f9c87;
          --error: #ad5147;
          --accent: #1a7857;
          --reader-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
          --reader-size: 16px;
        }
        * { box-sizing: border-box; }
        html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
        body { color: var(--ink); font-family: var(--reader-font); font-size: var(--reader-size); line-height: 1.68; }
        #scroll-root { width: 100%; height: 100%; overflow: auto; overscroll-behavior: contain; }
        #article { width: min(100%, 980px); margin: 0 auto; padding: 20px 28px 104px; }
        .mn-block {
          min-width: 0;
          padding: 10px 12px;
          border: 1px solid transparent;
          border-radius: 10px;
          transition: border-color 100ms ease, background-color 100ms ease;
        }
        .mn-block + .mn-block { margin-top: 2px; }
        .mn-block:hover { border-color: rgba(26, 120, 87, .36); }
        .mn-block.is-active { border-color: rgba(26, 120, 87, .68); }
        h1, h2, h3, h4, p, li, blockquote { min-width: 0; max-width: 100%; overflow-wrap: anywhere; white-space: normal; }
        h1, h2, h3, h4 { line-height: 1.32; margin: 8px 0 12px; }
        p { margin: 8px 0; }
        ul, ol { padding-left: 1.45em; }
        blockquote { margin: 12px 0; padding-left: 12px; border-left: 3px solid var(--quote); color: var(--muted); }
        pre { max-width: 100%; overflow-x: auto; padding: 12px; background: var(--code); border-radius: 8px; white-space: pre-wrap; }
        code { font-family: "SFMono-Regular", Menlo, monospace; }
        .math-inline { display: inline-block; max-width: 100%; vertical-align: -.12em; }
        .math-display { width: 100%; max-width: 100%; margin: 14px 0; overflow-x: auto; overflow-y: hidden; text-align: center; }
        .katex { font-size: 1.08em; }
        .math-display > .katex { display: inline-block; min-width: max-content; }
        table { display: block; width: 100%; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
        img, svg { display: block; max-width: 100%; height: auto; margin: 12px auto; border-radius: 8px; }
        .math-error { color: var(--error); white-space: pre-wrap; }
        :root.dark { --ink: #eeeeea; --muted: #aaa99f; --line: #3d403a; --code: #282b27; --quote: #75b99a; --error: #e49a91; --accent: #5ab992; }
      </style>
    </head>
    <body>
      <div id="scroll-root"><article id="article"></article></div>
      <script>
        (() => {
          const root = document.getElementById("scroll-root");
          const article = document.getElementById("article");
          const firstVisibleAnchor = () => {
            const rootTop = root.getBoundingClientRect().top;
            for (const block of article.children) {
              const rect = block.getBoundingClientRect();
              if (rect.bottom > rootTop + 1) return { id: block.dataset.blockId, top: rect.top - rootTop };
            }
            return null;
          };
          const restoreAnchor = (anchor) => {
            if (!anchor) return;
            const block = article.querySelector(`[data-block-id="${CSS.escape(anchor.id)}"]`);
            if (!block) return;
            const rootTop = root.getBoundingClientRect().top;
            root.scrollTop += block.getBoundingClientRect().top - rootTop - anchor.top;
          };
          const activateFromEvent = (event) => {
            const block = event.target.closest(".mn-block");
            if (!block) return;
            window.webkit?.messageHandlers?.blockActivated?.postMessage(block.dataset.blockId);
          };
          article.addEventListener("mousedown", activateFromEvent);
          article.addEventListener("focusin", activateFromEvent);
          window.MathNotes = {
            updateBlocks(blocks) {
              const anchor = firstVisibleAnchor();
              const existing = new Map(Array.from(article.children).map((node) => [node.dataset.blockId, node]));
              const valid = new Set(blocks.map((block) => block.id));
              for (const [id, node] of existing) if (!valid.has(id)) node.remove();
              for (const block of blocks) {
                let node = existing.get(block.id);
                if (!node) {
                  node = document.createElement("section");
                  node.className = "mn-block";
                  node.dataset.blockId = block.id;
                  node.tabIndex = 0;
                }
                if (node.dataset.version !== block.version) {
                  node.innerHTML = block.html;
                  node.dataset.version = block.version;
                }
                article.appendChild(node);
              }
              restoreAnchor(anchor);
            },
            setActive(id) {
              for (const block of article.children) {
                block.classList.toggle("is-active", block.dataset.blockId === id);
              }
            },
            setTypography(family, size) {
              document.documentElement.style.setProperty("--reader-font", family);
              document.documentElement.style.setProperty("--reader-size", `${size}px`);
            },
            setTheme(theme) {
              document.documentElement.classList.toggle("dark", theme === "dark");
              document.documentElement.style.colorScheme = theme;
            }
          };
        })();
      </script>
    </body>
    </html>
    """ }
}

private enum ManifestLoadState {
    case loading
    case loaded(ReadonlySessionManifest)
    case failed(String)
}

private struct LazySessionBlockView: View {
    let session: SessionCatalogItem
    let sessionRevision: String
    let manifest: SessionBlockManifest
    let isSelected: Bool
    @ObservedObject var workspace: SessionSourceWorkspace
    @ObservedObject var supervisor: SidecarSupervisor
    let onActivate: () -> Void
    let onSessionChanged: () async -> Void
    @State private var state: BlockLoadState = .idle
    @State private var recognitionTask: SessionRecognitionTask?
    @State private var recognitionError: String?
    @State private var assetPreview: SessionAssetPreview?
    @State private var isHovering = false

    var body: some View {
        blockBody
        .padding(.vertical, MathNotesTheme.Spacing.compact)
        .background(Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))
        .overlay {
            RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control)
                .strokeBorder(
                    isHovering ? MathNotesTheme.accent.opacity(0.58) : Color.clear,
                    lineWidth: 1
                )
        }
        .overlay(alignment: .topTrailing) {
            if isHovering {
                blockHeader
                    .padding(6)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onActivate)
        .onHover { isHovering = $0 }
        .task(id: "\(manifest.previewIdentity):\(sessionRevision)") { await load(force: true) }
        .sheet(item: $recognitionTask) { task in
            RecognitionTaskSheet(
                initialTask: task,
                session: session,
                supervisor: supervisor,
                onSessionChanged: refreshAfterRecognition
            )
        }
        .sheet(item: $assetPreview) { preview in
            SessionAssetPreviewSheet(
                preview: preview,
                session: session,
                supervisor: supervisor
            )
        }
        .alert("无法识别", isPresented: Binding(
            get: { recognitionError != nil },
            set: { if !$0 { recognitionError = nil } }
        )) {
            Button("好", role: .cancel) { recognitionError = nil }
        } message: {
            Text(recognitionError ?? "未知错误")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("内容段 \(manifest.order + 1)，\(manifest.sourceName)")
    }

    private var blockHeader: some View {
        Button(action: activateHeader) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                Image(systemName: blockIcon)
                    .foregroundStyle(MathNotesTheme.accent)
                Text(sourceLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Text(String(format: "%04d", manifest.order + 1))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .draggable("mathnotes-block:\(manifest.id)")
        .padding(.horizontal, MathNotesTheme.Spacing.compact)
        .frame(height: 30)
        .background(.ultraThinMaterial, in: Capsule())
        .contextMenu {
            blockHeaderContextMenu
        }
    }

    @ViewBuilder
    private var blockHeaderContextMenu: some View {
        if let preview = assetPreviewValue {
            Button {
                assetPreview = preview
            } label: {
                Label("预览原始素材", systemImage: "photo")
            }
        }
        if manifest.source == "ai_transcription" {
            Button {
                Task { await startRecognition() }
            } label: {
                Label("重新识别这个块", systemImage: "arrow.clockwise")
            }
        }
    }

    @ViewBuilder
    private var blockBody: some View {
        switch state {
        case .idle, .loading:
            HStack(spacing: MathNotesTheme.Spacing.standard) {
                ProgressView().controlSize(.small)
                Text("正在载入")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(MathNotesTheme.Spacing.section)
            .frame(maxWidth: .infinity, minHeight: 84, alignment: .leading)
        case let .failed(message):
            HStack {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(MathNotesTheme.failure)
                Spacer()
                Button("重试") { Task { await load(force: true) } }
            }
            .padding(MathNotesTheme.Spacing.section)
        case let .loaded(payload):
            payloadView(payload)
        }
    }

    @ViewBuilder
    private func payloadView(_ payload: ReadonlySessionBlock) -> some View {
        switch payload.content {
        case let .markdown(markdown):
            if let live = workspace.recognitionDrafts[manifest.id] {
                SessionLiveMarkdownPreview(
                    session: session,
                    blockID: manifest.id,
                    markdown: live,
                    fallbackHTML: markdown.html,
                    supervisor: supervisor
                )
            } else if let draft = workspace.drafts[manifest.id],
               workspace.isDirty(blockID: manifest.id) {
                SessionLiveMarkdownPreview(
                    session: session,
                    blockID: manifest.id,
                    markdown: draft,
                    fallbackHTML: markdown.html,
                    supervisor: supervisor
                )
            } else {
                MarkdownBlockWebView(html: markdown.html)
            }
        case let .image(assetPath, _):
            RemoteImageBlock(session: session, assetPath: assetPath, supervisor: supervisor)
        case let .pdf(assetPath, _):
            RemotePDFBlock(session: session, assetPath: assetPath, supervisor: supervisor)
        }
    }

    private func load(force: Bool) async {
        if !force, case .loaded = state { return }
        state = .loading
        do {
            state = .loaded(try await supervisor.fetchSessionBlock(session, blockId: manifest.id))
        } catch is CancellationError {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private var sourceLabel: String {
        switch manifest.source {
        case "ai_transcription": "识别草稿 · \(manifest.sourceName)"
        case "user", "user_revision": "用户笔记"
        case "pdf_import": "PDF · \(manifest.sourceName)"
        default: manifest.sourceName
        }
    }

    private var blockIcon: String {
        switch manifest.type {
        case "pdf": "doc.richtext"
        case "image": "photo"
        default: "text.alignleft"
        }
    }

    private func startRecognition() async {
        recognitionError = nil
        do {
            recognitionTask = manifest.source == "ai_transcription"
                ? try await supervisor.rerunRecognition(session, transcriptBlockId: manifest.id)
                : try await supervisor.startRecognition(session, imageBlockId: manifest.id)
        } catch {
            recognitionError = error.localizedDescription
        }
    }

    private func activateHeader() {
        onActivate()
        if let preview = assetPreviewValue {
            assetPreview = preview
        }
    }

    private var assetPreviewValue: SessionAssetPreview? {
        if let assetPath = manifest.sourceAssetPaths?.first {
            return SessionAssetPreview(id: manifest.id, kind: .image, assetPath: assetPath)
        }
        if let pageImagePath = manifest.sourcePageImagePath {
            return SessionAssetPreview(id: manifest.id, kind: .image, assetPath: pageImagePath)
        }
        return nil
    }

    private func refreshAfterRecognition() async {
        await onSessionChanged()
        await load(force: true)
    }
}

private extension SessionBlockManifest {
    var previewIdentity: String {
        "\(id):\(updatedAt)"
    }
}

private struct SessionLiveMarkdownPreview: View {
    let session: SessionCatalogItem
    let blockID: String
    let markdown: String
    let fallbackHTML: String
    @ObservedObject var supervisor: SidecarSupervisor
    @State private var renderedHTML: String?

    var body: some View {
        MarkdownBlockWebView(html: renderedHTML ?? fallbackHTML)
            .overlay(alignment: .topTrailing) {
                if renderedHTML == nil {
                    ProgressView()
                        .controlSize(.mini)
                        .padding(8)
                        .accessibilityLabel("正在更新实时预览")
                }
            }
            .task(id: markdown) {
                do {
                    try await Task.sleep(for: .milliseconds(180))
                    let html = try await supervisor.previewMarkdown(
                        session,
                        blockId: blockID,
                        markdown: markdown
                    )
                    guard !Task.isCancelled else { return }
                    renderedHTML = html
                } catch is CancellationError {
                    return
                } catch {
                    // Keep the last valid rendering while the next keystroke retries.
                }
            }
    }
}

private struct MarkdownConflictResolutionSheet: View {
    let conflict: SessionMarkdownConflict
    let onResolve: (String, String?) async throws -> ResolveMarkdownConflictResponse
    @Environment(\.dismiss) private var dismiss
    @State private var mergedMarkdown: String
    @State private var isResolving = false
    @State private var errorMessage: String?

    init(
        conflict: SessionMarkdownConflict,
        onResolve: @escaping (String, String?) async throws -> ResolveMarkdownConflictResponse
    ) {
        self.conflict = conflict
        self.onResolve = onResolve
        _mergedMarkdown = State(initialValue: conflict.incomingMarkdown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("比较冲突版本")
                        .font(.title3.weight(.semibold))
                    Text("原笔记没有被覆盖。请选择明确结果，冲突证据会继续保留。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("稍后处理") { dismiss() }
                    .disabled(isResolving)
            }

            HStack(alignment: .top, spacing: MathNotesTheme.Spacing.standard) {
                versionPanel(title: "当前版本", markdown: conflict.currentMarkdown)
                versionPanel(title: "离线来稿", markdown: conflict.incomingMarkdown)
            }
            .frame(maxHeight: 220)

            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
                Text("合并结果")
                    .font(.headline)
                TextEditor(text: $mergedMarkdown)
                    .font(.system(.body, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(MathNotesTheme.Spacing.compact)
                    .background(MathNotesTheme.canvas)
                    .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel))
                    .overlay {
                        RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel)
                            .strokeBorder(Color.primary.opacity(0.1))
                    }
            }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(MathNotesTheme.failure)
            }

            HStack {
                Button("保留当前") { Task { await resolve("current", markdown: nil) } }
                    .disabled(isResolving)
                Button("采用来稿") { Task { await resolve("incoming", markdown: nil) } }
                    .disabled(isResolving)
                Spacer()
                Button("保存合并") { Task { await resolve("merged", markdown: mergedMarkdown) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isResolving)
            }
        }
        .padding(MathNotesTheme.Spacing.page)
        .frame(minWidth: 900, minHeight: 650)
        .interactiveDismissDisabled(isResolving)
    }

    private func versionPanel(title: String, markdown: String) -> some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
            Text(title).font(.headline)
            ScrollView {
                Text(markdown)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .padding(MathNotesTheme.Spacing.standard)
            .background(MathNotesTheme.canvas)
            .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel))
        }
        .frame(maxWidth: .infinity)
    }

    private func resolve(_ resolution: String, markdown: String?) async {
        isResolving = true
        errorMessage = nil
        defer { isResolving = false }
        do {
            _ = try await onResolve(resolution, markdown)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct RecognitionTaskSheet: View {
    let initialTask: SessionRecognitionTask
    let session: SessionCatalogItem
    @ObservedObject var supervisor: SidecarSupervisor
    let onSessionChanged: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var currentTask: SessionRecognitionTask
    @State private var draft = ""
    @State private var messages: [String] = []
    @State private var lastSequence = 0
    @State private var pollGeneration = 0
    @State private var commandError: String?
    @State private var didRefreshSession = false

    init(
        initialTask: SessionRecognitionTask,
        session: SessionCatalogItem,
        supervisor: SidecarSupervisor,
        onSessionChanged: @escaping () async -> Void
    ) {
        self.initialTask = initialTask
        self.session = session
        self.supervisor = supervisor
        self.onSessionChanged = onSessionChanged
        _currentTask = State(initialValue: initialTask)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("图片识别")
                        .font(.title3.weight(.semibold))
                    Text(statusLabel)
                        .font(.caption)
                        .foregroundStyle(statusColor)
                }
                Spacer()
                if let provider = currentTask.providerName {
                    Text(provider)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Button("关闭") { dismiss() }
            }

            ScrollView {
                Text(draft.isEmpty ? "等待识别内容……" : draft)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(draft.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(MathNotesTheme.Spacing.standard)
            }
            .frame(minHeight: 260)
            .background(MathNotesTheme.canvas)
            .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel))
            .overlay {
                RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel)
                    .strokeBorder(Color.primary.opacity(0.1))
            }

            if let error = currentTask.error ?? commandError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(MathNotesTheme.failure)
                    .textSelection(.enabled)
            } else if let message = messages.last {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text("第 \(currentTask.attempts) 次执行")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                if let firstOutputMs = currentTask.timing?.firstOutputMs {
                    Text("首字 \(formatDuration(firstOutputMs))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .help("从识别服务请求开始到收到第一段输出的时间")
                }
                if let providerMs = currentTask.timing?.providerMs {
                    Text("总耗时 \(formatDuration(providerMs))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if currentTask.canCancel {
                    Button("中断") { Task { await cancel() } }
                }
                if currentTask.canRetry {
                    Button("重试") { Task { await retry() } }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(MathNotesTheme.Spacing.page)
        .frame(minWidth: 680, minHeight: 480)
        .task(id: "\(initialTask.id)-\(pollGeneration)") { await poll() }
    }

    private func formatDuration(_ milliseconds: Int) -> String {
        if milliseconds < 1_000 { return "\(milliseconds) ms" }
        return String(format: "%.1f s", Double(milliseconds) / 1_000)
    }

    private var statusLabel: String {
        switch currentTask.status {
        case "pending": "等待识别服务"
        case "running": "正在忠实转写"
        case "succeeded": "识别完成，草稿已写入笔记"
        case "cancelled": "识别已中断"
        default: "识别失败，可以重试"
        }
    }

    private var statusColor: Color {
        switch currentTask.status {
        case "succeeded": MathNotesTheme.accent
        case "failed": MathNotesTheme.failure
        case "cancelled": .secondary
        default: MathNotesTheme.warning
        }
    }

    private func poll() async {
        while !Task.isCancelled {
            do {
                let events = try await supervisor.recognitionEvents(
                    session, taskId: currentTask.id, afterSequence: lastSequence
                )
                for event in events {
                    lastSequence = max(lastSequence, event.sequence)
                    currentTask = event.task
                    if event.type == "stdout", let delta = event.delta { draft += delta }
                    if event.type != "stdout" && messages.last != event.message { messages.append(event.message) }
                }
                currentTask = try await supervisor.recognitionTask(session, taskId: currentTask.id)
                if currentTask.isTerminal {
                    if currentTask.status == "succeeded", !didRefreshSession {
                        didRefreshSession = true
                        await onSessionChanged()
                    }
                    return
                }
                try await Task.sleep(for: .milliseconds(250))
            } catch is CancellationError {
                return
            } catch {
                commandError = error.localizedDescription
                return
            }
        }
    }

    private func cancel() async {
        do {
            currentTask = try await supervisor.cancelRecognition(session, taskId: currentTask.id)
        } catch { commandError = error.localizedDescription }
    }

    private func retry() async {
        commandError = nil
        draft = ""
        didRefreshSession = false
        do {
            currentTask = try await supervisor.retryRecognition(session, taskId: currentTask.id)
            pollGeneration += 1
        } catch { commandError = error.localizedDescription }
    }
}

private enum BlockLoadState {
    case idle
    case loading
    case loaded(ReadonlySessionBlock)
    case failed(String)
}

private struct MarkdownBlockWebView: View {
    let html: String
    let stableHeight: Binding<CGFloat>?
    @State private var height: CGFloat = 96
    @AppStorage(MacPreferenceKeys.previewFont) private var previewFontRawValue = MacPreviewFontPreset.system.rawValue
    @AppStorage(MacPreferenceKeys.previewFontSize) private var previewFontSize = MacTypographyPreferences.defaultPreviewSize

    init(html: String, stableHeight: Binding<CGFloat>? = nil) {
        self.html = html
        self.stableHeight = stableHeight
    }

    var body: some View {
        let preset = MacPreviewFontPreset(rawValue: previewFontRawValue) ?? .system
        let styledHTML = MacTypographyPreferences.styledPreviewHTML(html, preset: preset, size: previewFontSize)
        let resolvedHeight = stableHeight ?? $height
        MarkdownWebRepresentable(html: styledHTML, height: resolvedHeight)
            .frame(height: max(72, resolvedHeight.wrappedValue))
            .accessibilityLabel("Markdown 正文")
    }
}

private struct MarkdownWebRepresentable: NSViewRepresentable {
    let html: String
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    func makeNSView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "height")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let view = SessionMarkdownWebView(frame: .zero, configuration: configuration)
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
        view.configuration.userContentController.removeScriptMessageHandler(forName: "height")
        view.navigationDelegate = nil
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        @Binding var height: CGFloat
        var html = ""
        private var pendingHeightUpdate: DispatchWorkItem?

        init(height: Binding<CGFloat>) { _height = height }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let value = message.body as? NSNumber else { return }
            let measured = CGFloat(truncating: value)
            guard measured.isFinite, measured > 0, abs(height - measured) > 2 else { return }
            pendingHeightUpdate?.cancel()
            let update = DispatchWorkItem { [weak self] in
                guard let self, abs(self.height - measured) > 2 else { return }
                var transaction = Transaction()
                transaction.animation = nil
                withTransaction(transaction) {
                    self.height = measured
                }
            }
            pendingHeightUpdate = update
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.09, execute: update)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.navigationType == .linkActivated ? .cancel : .allow
        }
    }
}

private final class SessionMarkdownWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        let isHorizontalGesture = abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY)
        if isHorizontalGesture {
            super.scrollWheel(with: event)
        } else if let nextResponder {
            nextResponder.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }
}

private struct RemoteImageBlock: View {
    let session: SessionCatalogItem
    let assetPath: String
    @ObservedObject var supervisor: SidecarSupervisor
    @State private var image: NSImage?
    @State private var error: String?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
            } else if let error {
                Label(error, systemImage: "photo.badge.exclamationmark")
                    .foregroundStyle(MathNotesTheme.failure)
                    .padding(MathNotesTheme.Spacing.section)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 160)
            }
        }
        .padding(MathNotesTheme.Spacing.compact)
        .task(id: assetPath) {
            do {
                let data = try await supervisor.fetchSessionAsset(session, path: assetPath)
                image = NSImage(data: data)
                if image == nil { error = "图片格式无法读取" }
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct RemotePDFBlock: View {
    let session: SessionCatalogItem
    let assetPath: String
    @ObservedObject var supervisor: SidecarSupervisor
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var data: Data?
    @State private var error: String?
    @State private var isFocused = false

    var body: some View {
        Group {
            if let data {
                PDFRepresentable(data: data, isFocused: $isFocused)
                    .frame(minHeight: 620)
                    .overlay(alignment: .topTrailing) {
                        if isFocused {
                            Label("PDF 浏览中 · Esc 退出", systemImage: "cursorarrow.click.2")
                                .font(.caption.weight(.medium))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .mathNotesControlSurface()
                                .padding(10)
                                .transition(.opacity)
                        }
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control)
                            .stroke(isFocused ? MathNotesTheme.accent : .clear, lineWidth: 1)
                    }
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: isFocused)
            } else if let error {
                Label(error, systemImage: "doc.badge.exclamationmark")
                    .foregroundStyle(MathNotesTheme.failure)
                    .padding(MathNotesTheme.Spacing.section)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 220)
            }
        }
        .task(id: assetPath) {
            do { data = try await supervisor.fetchSessionAsset(session, path: assetPath) }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct PDFRepresentable: NSViewRepresentable {
    let data: Data
    @Binding var isFocused: Bool

    func makeNSView(context: Context) -> PDFView {
        let view = FocusablePDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = .clear
        view.document = PDFDocument(data: data)
        view.isInternalScrollEnabled = isFocused
        view.onFocusChanged = { focused in
            DispatchQueue.main.async { isFocused = focused }
        }
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if view.document?.dataRepresentation() != data { view.document = PDFDocument(data: data) }
        guard let view = view as? FocusablePDFView else { return }
        view.isInternalScrollEnabled = isFocused
        view.onFocusChanged = { focused in
            DispatchQueue.main.async { isFocused = focused }
        }
    }
}

private final class FocusablePDFView: PDFView {
    var isInternalScrollEnabled = false
    var onFocusChanged: ((Bool) -> Void)?

    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        isInternalScrollEnabled = true
        onFocusChanged?(true)
        window?.makeFirstResponder(self)
        super.mouseDown(with: event)
    }

    override func scrollWheel(with event: NSEvent) {
        if isInternalScrollEnabled {
            super.scrollWheel(with: event)
        } else if let nextResponder {
            nextResponder.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            isInternalScrollEnabled = false
            onFocusChanged?(false)
            window?.makeFirstResponder(nil)
        } else {
            super.keyDown(with: event)
        }
    }

    override func resignFirstResponder() -> Bool {
        let didResign = super.resignFirstResponder()
        if didResign {
            isInternalScrollEnabled = false
            onFocusChanged?(false)
        }
        return didResign
    }
}

private enum SessionAssistantScope: String, CaseIterable, Identifiable {
    case session
    case block
    case selection

    var id: String { rawValue }
    var label: String {
        switch self {
        case .session: "整个 Session"
        case .block: "当前块"
        case .selection: "选中文字"
        }
    }
}

private enum SessionAssistantMode: String, CaseIterable, Identifiable {
    case explain
    case teach
    case summarize

    var id: String { rawValue }
    var label: String {
        switch self {
        case .explain: "解释"
        case .teach: "带我学习"
        case .summarize: "总结"
        }
    }
}

struct SessionAssistantPanel: View {
    let session: SessionCatalogItem
    let manifest: ReadonlySessionManifest
    let activeBlockID: String?
    let selectedText: String
    let selectedTextBlockID: String?
    @ObservedObject var supervisor: SidecarSupervisor
    let onSessionChanged: () async -> Void
    let onClose: () -> Void

    @State private var scope: SessionAssistantScope
    @State private var mode = SessionAssistantMode.explain
    @State private var question = ""
    @State private var preview: SessionAssistantPreview?
    @State private var remarks: [SessionAssistantRemark] = []
    @State private var selectedRemarkID: String?
    @State private var errorMessage: String?
    @State private var isLoadingRemarks = false
    @State private var isRunning = false
    @State private var submittedQuestion: String?
    @State private var assistantRequestTask: Task<Void, Never>?
    @State private var assistantTaskID: String?
    @State private var liveAssistantDraft = ""
    @State private var assistantStageMessage = "正在连接学习助手…"
    @State private var isMutatingRemark = false
    @State private var pendingPromotion: SessionAssistantRemark?
    @State private var droppedBlockID: String?
    @State private var droppedText = ""
    @State private var droppedTextBlockID: String?
    @AppStorage(MacPreferenceKeys.assistantFont) private var assistantFontRaw = MacPreviewFontPreset.system.rawValue
    @AppStorage(MacPreferenceKeys.assistantFontSize) private var assistantFontSize = MacTypographyPreferences.defaultAssistantSize

    init(
        session: SessionCatalogItem,
        manifest: ReadonlySessionManifest,
        activeBlockID: String?,
        selectedText: String,
        selectedTextBlockID: String?,
        supervisor: SidecarSupervisor,
        onSessionChanged: @escaping () async -> Void,
        onClose: @escaping () -> Void
    ) {
        self.session = session
        self.manifest = manifest
        self.activeBlockID = activeBlockID
        self.selectedText = selectedText
        self.selectedTextBlockID = selectedTextBlockID
        self.supervisor = supervisor
        self.onSessionChanged = onSessionChanged
        self.onClose = onClose
        _scope = State(initialValue: selectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .block : .selection)
    }

    var body: some View {
        VStack(spacing: 0) {
            assistantHeader
            Divider()
            conversationPane
            Divider()
            composer
        }
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel))
        .overlay {
            RoundedRectangle(cornerRadius: MathNotesTheme.Radius.panel)
                .strokeBorder(MathNotesTheme.separator.opacity(0.72), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.12), radius: 22, y: 8)
        .task {
            await loadRemarks()
        }
        .task(id: previewKey) {
            do {
                try await Task.sleep(for: .milliseconds(220))
                try Task.checkCancellation()
                await loadPreview()
            } catch {
                return
            }
        }
        .confirmationDialog(
            "把这条 AI 批注加入笔记正文？",
            isPresented: Binding(
                get: { pendingPromotion != nil },
                set: { if !$0 { pendingPromotion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("明确加入笔记正文") {
                guard let remark = pendingPromotion else { return }
                Task { await promote(remark) }
            }
            Button("取消", role: .cancel) { pendingPromotion = nil }
        } message: {
            Text("默认批注与原始笔记相互独立；只有这一步会新增 AI 解释块。")
        }
        .dropDestination(for: String.self) { items, _ in
            acceptDrop(items)
        }
        .accessibilityIdentifier("session-assistant-panel")
    }

    private var assistantHeader: some View {
        HStack(spacing: MathNotesTheme.Spacing.standard) {
            Image(systemName: "sparkles")
                .foregroundStyle(MathNotesTheme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("学习助手")
                    .font(.headline)
                Text("拖入内容段或选中文字，主界面仍可继续编辑")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                onClose()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .help("关闭学习助手")
            .accessibilityLabel("关闭学习助手")
        }
        .padding(.horizontal, MathNotesTheme.Spacing.section)
        .padding(.vertical, MathNotesTheme.Spacing.standard)
        .background(AssistantWindowDragSurface())
    }

    private var conversationPane: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: MathNotesTheme.Spacing.section) {
                if remarks.isEmpty && !isLoadingRemarks {
                    VStack(spacing: MathNotesTheme.Spacing.standard) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text("在下方输入问题，回答会显示在这里。")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 56)
                }
                ForEach(remarks) { remark in
                    assistantMessage(remark)
                }
                if isRunning, let submittedQuestion {
                    Text(submittedQuestion)
                        .font(.callout)
                        .padding(MathNotesTheme.Spacing.standard)
                        .background(MathNotesTheme.accentSoft, in: RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if isRunning, !liveAssistantDraft.isEmpty {
                    Text(liveAssistantDraft)
                        .font(assistantFontPreset.font(size: assistantFontSize))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(MathNotesTheme.Spacing.standard)
                        .background(MathNotesTheme.canvas.opacity(0.9), in: RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))
                }
                if isRunning {
                    HStack(spacing: MathNotesTheme.Spacing.compact) {
                        ProgressView().controlSize(.small)
                        Text(assistantStageMessage).foregroundStyle(.secondary)
                    }
                    .padding(MathNotesTheme.Spacing.standard)
                }
            }
            .padding(MathNotesTheme.Spacing.section)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func assistantMessage(_ remark: SessionAssistantRemark) -> some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.standard) {
            if let question = remark.question, !question.isEmpty {
                Text(question)
                    .font(.callout)
                    .padding(MathNotesTheme.Spacing.standard)
                    .background(MathNotesTheme.accentSoft, in: RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
                MarkdownBlockWebView(html: MacTypographyPreferences.styledAssistantHTML(
                    remark.html,
                    preset: assistantFontPreset,
                    size: assistantFontSize
                ))
                HStack {
                    Text("\(remark.providerName) · \(remark.usage.textCharacters) 字 · \(remark.imageCount) 图")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("加入正文") { pendingPromotion = remark }
                        .buttonStyle(.borderless)
                        .disabled(isMutatingRemark)
                    Button("删除", role: .destructive) {
                        Task { await remove(remark) }
                    }
                    .buttonStyle(.borderless)
                    .disabled(isMutatingRemark)
                }
            }
            .padding(MathNotesTheme.Spacing.standard)
            .background(MathNotesTheme.canvas.opacity(0.9), in: RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: MathNotesTheme.Spacing.compact) {
            HStack(spacing: MathNotesTheme.Spacing.compact) {
                Menu {
                    ForEach(SessionAssistantScope.allCases) { candidate in
                        Button {
                            scope = candidate
                        } label: {
                            if scope == candidate {
                                Label(candidate.label, systemImage: "checkmark")
                            } else {
                                Text(candidate.label)
                            }
                        }
                        .disabled(candidate == .selection && !hasSelection)
                    }
                } label: {
                    Label(scope.label, systemImage: "scope")
                }
                .menuStyle(.borderlessButton)

                Menu {
                    ForEach(SessionAssistantMode.allCases) { candidate in
                        Button {
                            mode = candidate
                        } label: {
                            if mode == candidate {
                                Label(candidate.label, systemImage: "checkmark")
                            } else {
                                Text(candidate.label)
                            }
                        }
                    }
                } label: {
                    Text(mode.label)
                }
                .menuStyle(.borderlessButton)

                Spacer()
                compactContextBudget
            }

            if scope == .block {
                contextChip(activeBlockLabel, systemImage: "square.text.square") {
                    droppedBlockID = nil
                }
            } else if scope == .selection, hasSelection {
                contextChip(selectionContextLabel, systemImage: "text.quote") {
                    droppedText = ""
                    droppedTextBlockID = nil
                    if selectedText.isEmpty { scope = .block }
                }
            }

            HStack(alignment: .bottom, spacing: MathNotesTheme.Spacing.compact) {
                TextField("输入问题", text: $question, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.body)
                    .lineLimit(2...4)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .frame(minHeight: 58, maxHeight: 104, alignment: .topLeading)
                    .background(MathNotesTheme.canvas.opacity(0.92))
                    .clipShape(RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control))
                    .overlay {
                        RoundedRectangle(cornerRadius: MathNotesTheme.Radius.control)
                            .strokeBorder(MathNotesTheme.separator.opacity(0.72), lineWidth: 1)
                    }
                    .accessibilityLabel("向学习助手提问")

                Button {
                    if isRunning {
                        Task { await cancelAssistant() }
                    } else {
                        assistantRequestTask = Task {
                            await runAssistant()
                            assistantRequestTask = nil
                        }
                    }
                } label: {
                    Group {
                        if isRunning {
                            Image(systemName: "stop.fill")
                                .font(.body.weight(.bold))
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.body.weight(.bold))
                        }
                    }
                    .frame(width: 36, height: 36)
                }
                .buttonStyle(.borderedProminent)
                .clipShape(Circle())
                .disabled(!isRunning && requestInput == nil)
                .help(isRunning ? "停止" : "发送")
                .accessibilityLabel(isRunning ? "停止学习助手回答" : "发送给学习助手")
            }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(MathNotesTheme.failure)
                    .textSelection(.enabled)
            } else {
                Text("也可以问“第 42 块是什么”；编号按当前顺序解释。")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(MathNotesTheme.Spacing.standard)
        .background(MathNotesTheme.sidebar.opacity(0.55))
    }

    private var assistantFontPreset: MacPreviewFontPreset {
        MacPreviewFontPreset(rawValue: assistantFontRaw) ?? .system
    }

    private var compactContextBudget: some View {
        Group {
            if let preview {
                let summary = "\(preview.usage.textCharacters) 字 · \(preview.imageCount) 图 · \(preview.usage.includedBlockIds.count)/\(preview.usage.sessionBlockCount) 块"
                Label(summary, systemImage: preview.usage.truncated || preview.usage.focusTruncated ? "exclamationmark.triangle" : "info.circle")
                    .help("本轮实际喂给 AI：\(summary)")
            } else {
                ProgressView().controlSize(.mini)
                    .help("正在计算本轮实际喂给 AI 的内容")
            }
        }
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("assistant-context-budget")
    }

    private func contextChip(_ label: String, systemImage: String, onClear: @escaping () -> Void) -> some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
            Text(label).lineLimit(1)
            Button(action: onClear) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("移除上下文")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(MathNotesTheme.canvas.opacity(0.82), in: Capsule())
    }

    private var hasSelection: Bool {
        !effectiveSelectedText.isEmpty && effectiveSelectedTextBlockID != nil
    }

    private var readableBlocks: [SessionBlockManifest] {
        manifest.blocks.filter { $0.type == "markdown" && $0.source != "ai_explanation" }
    }

    private var resolvedBlockID: String? {
        if let droppedBlockID, readableBlocks.contains(where: { $0.id == droppedBlockID }) {
            return droppedBlockID
        }
        if let activeBlockID, readableBlocks.contains(where: { $0.id == activeBlockID }) {
            return activeBlockID
        }
        return readableBlocks.first?.id
    }

    private var activeBlockLabel: String {
        guard let resolvedBlockID,
              let block = readableBlocks.first(where: { $0.id == resolvedBlockID }),
              let index = readableBlocks.firstIndex(where: { $0.id == resolvedBlockID }) else {
            return "当前没有可提问的 Markdown 块"
        }
        return "第 \(index + 1) 块 · \(block.sourceName)"
    }

    private var effectiveSelectedText: String {
        let candidate = droppedText.isEmpty ? selectedText : droppedText
        return candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var effectiveSelectedTextBlockID: String? {
        droppedText.isEmpty ? selectedTextBlockID : droppedTextBlockID
    }

    private var selectionContextLabel: String {
        let oneLine = effectiveSelectedText.replacingOccurrences(of: "\n", with: " ")
        return oneLine.count > 54 ? "\(oneLine.prefix(54))…" : oneLine
    }

    private var requestInput: SessionAssistantRequest? {
        let blockID: String?
        switch scope {
        case .session:
            blockID = nil
        case .block:
            blockID = resolvedBlockID
        case .selection:
            guard hasSelection else { return nil }
            blockID = effectiveSelectedTextBlockID
        }
        if scope != .session, blockID == nil { return nil }
        return SessionAssistantRequest(
            scope: scope.rawValue,
            activeBlockId: blockID,
            selectedText: scope == .selection ? effectiveSelectedText : nil,
            focusLabel: scope == .block ? activeBlockLabel : nil,
            question: question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : question,
            mode: mode.rawValue
        )
    }

    private var previewKey: String {
        "\(scope.rawValue)|\(resolvedBlockID ?? "")|\(effectiveSelectedTextBlockID ?? "")|\(effectiveSelectedText)|\(question)"
    }

    private func acceptDrop(_ items: [String]) -> Bool {
        for item in items.reversed() {
            if item.hasPrefix("mathnotes-block:") {
                let blockID = String(item.dropFirst("mathnotes-block:".count))
                guard readableBlocks.contains(where: { $0.id == blockID }) else { continue }
                droppedBlockID = blockID
                droppedText = ""
                droppedTextBlockID = nil
                scope = .block
                return true
            }
            let text = item.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, let blockID = selectedTextBlockID ?? resolvedBlockID else { continue }
            droppedText = text
            droppedTextBlockID = blockID
            droppedBlockID = nil
            scope = .selection
            return true
        }
        return false
    }

    private func loadPreview() async {
        guard var input = requestInput else {
            preview = nil
            return
        }
        input = SessionAssistantRequest(
            scope: input.scope,
            activeBlockId: input.activeBlockId,
            selectedText: input.selectedText,
            focusLabel: input.focusLabel,
            question: input.question,
            mode: nil
        )
        do {
            preview = try await supervisor.previewSessionAssistant(session, input: input)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            preview = nil
            errorMessage = error.localizedDescription
        }
    }

    private func loadRemarks() async {
        isLoadingRemarks = true
        defer { isLoadingRemarks = false }
        do {
            remarks = try await supervisor.listSessionAssistant(session)
            selectedRemarkID = remarks.last?.id
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func runAssistant() async {
        guard let input = requestInput else { return }
        let submitted = question.trimmingCharacters(in: .whitespacesAndNewlines)
        submittedQuestion = submitted.isEmpty ? "\(mode.label)当前上下文" : submitted
        question = ""
        isRunning = true
        liveAssistantDraft = ""
        assistantStageMessage = "正在连接学习助手…"
        errorMessage = nil
        defer {
            isRunning = false
            submittedQuestion = nil
            assistantTaskID = nil
        }
        do {
            var task = try await supervisor.startSessionAssistant(session, input: input)
            assistantTaskID = task.id
            var sequence = 0
            while !task.isTerminal {
                try Task.checkCancellation()
                let events = try await supervisor.sessionAssistantEvents(
                    session,
                    taskId: task.id,
                    afterSequence: sequence
                )
                var appended = ""
                for event in events {
                    sequence = max(sequence, event.sequence)
                    task = event.task
                    assistantStageMessage = event.message
                    if event.type == "stdout", let delta = event.delta {
                        appended += delta
                    }
                }
                if !appended.isEmpty { liveAssistantDraft += appended }
                if !task.isTerminal {
                    try await Task.sleep(for: .milliseconds(120))
                }
            }
            guard task.status == "succeeded" else {
                errorMessage = task.error ?? (task.status == "cancelled" ? "已停止本次回答。" : "学习助手回答失败。")
                return
            }
            let updated = try await supervisor.listSessionAssistant(session)
            if let remark = updated.last, !remarks.contains(where: { $0.id == remark.id }) {
                remarks.append(remark)
                selectedRemarkID = remark.id
            }
            liveAssistantDraft = ""
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cancelAssistant() async {
        guard let assistantTaskID else {
            assistantRequestTask?.cancel()
            return
        }
        do {
            _ = try await supervisor.cancelSessionAssistant(session, taskId: assistantTaskID)
            errorMessage = "已停止本次回答。"
        } catch {
            errorMessage = error.localizedDescription
        }
        assistantRequestTask?.cancel()
    }

    private func remove(_ remark: SessionAssistantRemark) async {
        isMutatingRemark = true
        errorMessage = nil
        defer { isMutatingRemark = false }
        do {
            _ = try await supervisor.deleteSessionAssistant(session, remarkId: remark.id)
            remarks.removeAll { $0.id == remark.id }
            selectedRemarkID = remarks.last?.id
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func promote(_ remark: SessionAssistantRemark) async {
        pendingPromotion = nil
        isMutatingRemark = true
        errorMessage = nil
        defer { isMutatingRemark = false }
        do {
            _ = try await supervisor.promoteSessionAssistant(session, remarkId: remark.id)
            await onSessionChanged()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func remarkTitle(_ remark: SessionAssistantRemark) -> String {
        if let question = remark.question, !question.isEmpty { return question }
        return "\(modeLabel(remark.mode)) · \(remark.focus.label)"
    }

    private func modeLabel(_ value: String) -> String {
        SessionAssistantMode(rawValue: value)?.label ?? value
    }
}

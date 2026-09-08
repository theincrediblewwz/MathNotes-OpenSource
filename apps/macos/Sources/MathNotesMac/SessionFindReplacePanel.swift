import SwiftUI

private struct SessionFindActionKey: FocusedValueKey { typealias Value = () -> Void }
extension FocusedValues {
    var findInSession: (() -> Void)? {
        get { self[SessionFindActionKey.self] }
        set { self[SessionFindActionKey.self] = newValue }
    }
}
struct SessionFindCommands: Commands {
    @FocusedValue(\.findInSession) private var findInSession
    var body: some Commands {
        CommandGroup(after: .textEditing) {
            Button("在笔记中查找与替换") { findInSession?() }
                .keyboardShortcut("f", modifiers: .command).disabled(findInSession == nil)
        }
    }
}

struct SessionFindReplacePanel: View {
    let session: SessionCatalogItem
    let blocks: [SessionBlockManifest]
    @ObservedObject var workspace: SessionSourceWorkspace
    @ObservedObject var supervisor: SidecarSupervisor
    let onNavigate: (SessionFindMatch) -> Void
    let onSaved: () async -> Void
    let onClose: () -> Void
    @State private var query = ""
    @State private var replacement = ""
    @State private var matchCase = false
    @State private var index = -1
    @State private var message = ""
    @State private var affectedIDs: Set<String> = []
    @State private var undoBefore: [String: String] = [:]
    @State private var undoAfter: [String: String] = [:]
    @State private var isSaving = false
    @FocusState private var searchFocused: Bool

    private var searchable: [SessionBlockManifest] { blocks.filter { $0.type == "markdown" && $0.renderInNote } }
    private var values: [SessionFindBlock] {
        searchable.compactMap { block in
            guard let payload = workspace.payloads[block.id], case let .markdown(content) = payload.content else { return nil }
            return SessionFindBlock(id: block.id, text: workspace.drafts[block.id] ?? content.markdown,
                canReplace: block.editable && !content.blockLocked && content.protectedSpanCount == 0 &&
                    workspace.recognitionDrafts[block.id] == nil && !workspace.savingIDs.contains(block.id))
        }
    }
    private var matches: [SessionFindMatch] { SessionFindEngine.matches(in: values, query: query, matchCase: matchCase) }
    private var current: SessionFindMatch? { matches.indices.contains(index) ? matches[index] : nil }
    private var pending: [String] { searchable.map(\.id).filter { affectedIDs.contains($0) && workspace.isDirty(blockID: $0) } }
    private var ready: Bool { values.count == searchable.count && workspace.loadingIDs.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("查找与替换").font(.headline)
                Spacer()
                Button(action: onClose) { Image(systemName: "xmark") }.accessibilityLabel("关闭查找替换")
                    .disabled(isSaving)
            }
            HStack {
                TextField("查找文字", text: $query).focused($searchFocused).onSubmit { navigate(1) }
                Button { navigate(-1) } label: { Image(systemName: "chevron.up") }.accessibilityLabel("上一个匹配")
                Button { navigate(1) } label: { Image(systemName: "chevron.down") }.accessibilityLabel("下一个匹配")
            }
            HStack {
                Toggle("区分大小写", isOn: $matchCase).toggleStyle(.checkbox)
                Spacer()
                Text(query.isEmpty ? "输入查找文字" : matches.isEmpty ? "未找到" : index < 0 ? "\(matches.count) 处" : "\(index + 1) / \(matches.count) 处")
                    .foregroundStyle(.secondary)
            }.font(.caption)
            TextField("替换为（留空则删除匹配文字）", text: $replacement)
            HStack {
                Button("替换当前") { replace(all: false) }.disabled(current?.canReplace != true || !ready || isSaving)
                Button("全部替换") { replace(all: true) }.disabled(!matches.contains(where: \.canReplace) || !ready || isSaving)
                Spacer()
                Button("撤销替换") { undo() }.disabled(undoBefore.isEmpty || isSaving)
            }
            if !ready { Text("正在读取正文；未读完时暂停替换。").font(.caption).foregroundStyle(.secondary) }
            if current?.canReplace == false { Text("当前匹配位于固定或暂不可编辑的块，只能查找。").font(.caption) }
            if !message.isEmpty { Text(message).font(.caption).textSelection(.enabled) }
            HStack {
                Text("替换先进入草稿，保存后生效。").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(isSaving ? "正在保存…" : "保存 \(pending.count) 个块") { Task { await save() } }
                    .buttonStyle(.borderedProminent).disabled(pending.isEmpty || isSaving)
            }
        }
        .padding(12).frame(maxWidth: 380)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(MathNotesTheme.accent.opacity(0.25)) }
        .disabled(isSaving)
        .onAppear { searchFocused = true }
        .onChange(of: query) { _, _ in index = -1; message = "" }
        .onChange(of: matchCase) { _, _ in index = -1 }
        .onChange(of: matches.count) { _, count in index = min(index, max(0, count - 1)) }
        .task(id: session.id) {
            for block in searchable { await workspace.load(session: session, block: block, supervisor: supervisor) }
        }
    }

    private func navigate(_ delta: Int) {
        guard !matches.isEmpty else { return }
        index = index < 0 ? (delta > 0 ? 0 : matches.count - 1) : (index + delta + matches.count) % matches.count
        if let current { onNavigate(current) }
    }

    private func replace(all: Bool) {
        let found = all ? matches : current.map { [$0] } ?? []
        let allowed = found.filter(\.canReplace)
        var before: [String: String] = [:]
        var after: [String: String] = [:]
        for (blockID, group) in Dictionary(grouping: allowed, by: \.blockID) {
            guard let value = values.first(where: { $0.id == blockID }) else { continue }
            before[blockID] = value.text
            after[blockID] = SessionFindEngine.replacing(value.text, ranges: group.map(\.range), with: replacement)
        }
        for (id, text) in after { workspace.applyExternalDraft(text, blockID: id); affectedIDs.insert(id) }
        undoBefore = before; undoAfter = after
        let skipped = Set(found.filter { !$0.canReplace }.map(\.blockID)).count
        message = "已替换 \(allowed.count) 处，涉及 \(after.count) 个块。" + (skipped > 0 ? "跳过 \(skipped) 个固定或暂不可编辑的块。" : "")
        index = min(index, max(0, matches.count - 1))
    }

    private func undo() {
        guard undoAfter.allSatisfy({ workspace.drafts[$0.key] == $0.value }) else {
            message = "替换后已有其他编辑，未覆盖新内容；可在对应块中逐步撤销。"; return
        }
        for (id, text) in undoBefore { workspace.applyExternalDraft(text, blockID: id) }
        undoBefore = [:]; undoAfter = [:]; message = "已撤销上次替换。"
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        var savedCount = 0
        for blockID in pending {
            guard let payload = workspace.payloads[blockID], case let .markdown(content) = payload.content,
                  let draft = workspace.drafts[blockID], values.first(where: { $0.id == blockID })?.canReplace == true else { continue }
            workspace.beginSaving(blockID: blockID)
            do {
                let saved = try await supervisor.saveMarkdownBlock(session, blockId: blockID, markdown: draft, baseRevision: content.baseRevision)
                workspace.applySaved(saved, submittedDraft: draft)
                savedCount += 1
                workspace.endSaving(blockID: blockID)
            } catch {
                workspace.endSaving(blockID: blockID)
                message = "已保存 \(savedCount) 个块，其余草稿保留：\(error.localizedDescription) 可在块内保存时比较版本。"
                return
            }
        }
        await onSaved()
        message = "已保存 \(savedCount) 个块。" + (pending.isEmpty ? "" : "后续编辑仍保留在草稿中。")
    }
}

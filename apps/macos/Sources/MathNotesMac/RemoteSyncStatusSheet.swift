import AppKit
import SwiftUI

struct RemoteSyncStatusSheet: View {
    @ObservedObject var store: CompanionReaderStore
    @ObservedObject var editingState: AppEditingState
    @Environment(\.dismiss) private var dismiss
    @State private var conflicts: [ReplicaConflictEntry] = []
    @State private var selectedConflict: ReplicaConflictEntry?
    @State private var selectedCatalogConflict: ReplicaCatalogConflict?
    @State private var backupURL: URL?
    @State private var message: String?
    @State private var isResolving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(store.activeHost?.name ?? "远程主机").font(.title2.bold())
                    Text(store.isSynchronizing ? "正在同步本地副本…" : store.syncMessage ?? "连接主机后准备副本")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if store.hostUpgradeRequired {
                Text("当前主机缺少笔记写入接口。更新 Windows 主机后，这里会启用独立本地副本、编辑与双向同步。")
                    .font(.callout)
            }
            if store.replicaSupervisor != nil, store.syncResult?.catalogManagementAvailable == false {
                Text("此主机支持正文同步，但尚未支持远程创建、改名和废纸篓。更新主机后会启用这些按钮。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let host = store.activeHost {
                Text(host.origin).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                HStack {
                    Button("立即同步") { store.synchronizeNow() }.disabled(store.isSynchronizing)
                    Button("在 Finder 中显示副本") { NSWorkspace.shared.open(host.directory) }
                }
            }
            if let result = store.syncResult, !result.sessions.isEmpty || !(result.catalogOperations ?? []).isEmpty {
                List {
                    if let operations = result.catalogOperations, !operations.isEmpty {
                        Section("目录操作") {
                            ForEach(operations) { operation in catalogRow(operation) }
                        }
                    }
                    ForEach(result.sessions) { session in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.title)
                            Text(statusLabel(session.status)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if session.status == "conflict" {
                            Button("比较并处理") {
                                Task {
                                    do {
                                        conflicts = try await store.replicaSupervisor?.replicaConflicts() ?? []
                                        selectedConflict = conflicts.first { $0.id == session.id }
                                    } catch { message = error.localizedDescription }
                                }
                            }
                            .disabled(editingState.hasUnsavedSourceDrafts)
                        }
                    }
                    }
                }
            } else {
                Spacer()
                Text(store.isSynchronizing ? "正在准备主机的笔记和素材" : "同步状态将在连接后显示")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity)
                Spacer()
            }
            if editingState.hasUnsavedSourceDrafts { Text("保存编辑器中的草稿后，即可处理同步冲突。").font(.caption) }
            if let message { Text(message).foregroundStyle(.red).font(.callout) }
            if let backupURL {
                Button("在 Finder 中查看保留的本地备份") { NSWorkspace.shared.open(backupURL) }
            }
        }
        .padding(24)
        .frame(width: 580, height: 440)
        .sheet(item: $selectedConflict) { conflict in
            VStack(alignment: .leading, spacing: 14) {
                Text("比较冲突：\(conflict.title)").font(.title2.bold())
                Text("选择要继续使用的版本。两份原内容都会保留在副本的恢复记录中；若主机又有更新，将重新提示冲突。")
                    .font(.callout).foregroundStyle(.secondary)
                HSplitView {
                    versionPane("这台 Mac 的副本", text: conflict.conflict.local.text)
                    versionPane("主机上的版本", text: conflict.conflict.remote.text)
                }
                if let message { Text(message).foregroundStyle(.red).font(.callout) }
                HStack {
                    Button("暂不处理") { selectedConflict = nil }
                    Spacer()
                    Button("保留主机版本") { resolve(conflict, choice: "remote") }
                    Button("保留本地并同步") { resolve(conflict, choice: "local") }.buttonStyle(.borderedProminent)
                }
                .disabled(isResolving || editingState.hasUnsavedSourceDrafts)
            }
            .padding(24)
            .frame(width: 880, height: 620)
        }
        .sheet(item: $selectedCatalogConflict) { conflict in catalogConflictSheet(conflict) }
    }

    private func catalogRow(_ operation: ReplicaCatalogStatus) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("\(operation.actionLabel)：\(operation.title)")
                Text(operation.status == "conflict" ? "目录有变化，本地操作已暂停" : "本地已保存，等待同步")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if operation.status == "conflict" {
                Button("查看并处理") {
                    Task {
                        do {
                            let entries = try await store.replicaSupervisor?.replicaCatalogConflicts() ?? []
                            selectedCatalogConflict = entries.first { $0.id == operation.id }
                        } catch { message = error.localizedDescription }
                    }
                }
                .disabled(editingState.hasUnsavedSourceDrafts || store.isSynchronizing || isResolving)
            }
        }
    }

    private func catalogConflictSheet(_ conflict: ReplicaCatalogConflict) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("目录冲突：\(conflict.title)").font(.title2.bold())
            Text("Notebook：\(conflict.notebookTitle)").font(.headline)
            Text(conflict.remoteTitle.map { "发生冲突时主机名称：\($0)" } ?? "主机中没有这个目标，或暂时无法读取它的状态。")
                .font(.callout).foregroundStyle(.secondary)
            Text("采用主机版本会取消这个 Notebook 的全部 \(conflict.pendingCount) 项本地目录待办，已同步到主机的操作不会撤回。当前的本地内容、废纸篓素材及操作记录会先完整备份，再重新下载主机版本。之后可再次执行需要的改名或删除。")
                .font(.callout)
            if !conflict.localText.isEmpty {
                versionPane("本地操作前保存的正文", text: conflict.localText)
            } else { Spacer() }
            if let message { Text(message).font(.callout).foregroundStyle(.red) }
            HStack {
                Button("暂不处理") { selectedCatalogConflict = nil }
                Spacer()
                Button("备份本地并采用主机版本") {
                    isResolving = true; message = nil
                    Task {
                        defer { isResolving = false }
                        do {
                            backupURL = try await store.resolveCatalogConflict(conflict)
                            selectedCatalogConflict = nil
                        } catch { message = error.localizedDescription }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
            .disabled(isResolving || editingState.hasUnsavedSourceDrafts || store.isSynchronizing)
        }
        .padding(24)
        .frame(width: 700, height: 540)
    }

    private func versionPane(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            ScrollView {
                Text(text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }
            .background(MathNotesTheme.canvas, in: RoundedRectangle(cornerRadius: 10))
        }
        .frame(minWidth: 300, maxWidth: .infinity)
    }

    private func resolve(_ conflict: ReplicaConflictEntry, choice: String) {
        guard let status = store.syncResult?.sessions.first(where: { $0.id == conflict.id }) else { return }
        isResolving = true
        message = nil
        Task {
            defer { isResolving = false }
            do {
                try await store.resolveConflict(status, choice: choice)
                selectedConflict = nil
            } catch { message = error.localizedDescription }
        }
    }

    private func statusLabel(_ value: String) -> String {
        switch value {
        case "synced": "已同步"
        case "pending": "本地修改已保存，等待同步"
        case "conflict": "两端都有修改，需要比较"
        case "host_deleted": "主机已删除，本地副本仍保留"
        default: "同步未完成，可重试"
        }
    }
}

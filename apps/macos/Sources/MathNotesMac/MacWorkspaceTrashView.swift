import SwiftUI

struct MacWorkspaceTrashView: View {
    let entries: [WorkspaceTrashEntry]
    let isLoading: Bool
    let isRestoring: Bool
    let hasUnsavedDrafts: Bool
    let error: String?
    let onRestore: (WorkspaceTrashEntry) -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "trash")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(MathNotesTheme.accent)
                    .frame(width: 38, height: 38)
                    .background(MathNotesTheme.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 3) {
                    Text("笔记废纸篓").font(.system(size: 17, weight: .semibold))
                    Text("删除的笔记和素材会保留在这里")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                Button("完成", action: onClose)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(20)
            Divider()

            Group {
                if isLoading {
                    ProgressView("正在载入…").controlSize(.small)
                } else if entries.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: error == nil ? "tray" : "exclamationmark.triangle")
                            .font(.system(size: 30, weight: .light))
                            .foregroundStyle(.secondary)
                        Text(error == nil ? "废纸篓为空" : "暂时无法载入")
                            .font(.system(size: 15, weight: .medium))
                        Text(error == nil ? "移入废纸篓的笔记可以在这里恢复。" : "关闭窗口后可重新打开重试。")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 8) {
                            ForEach(entries) { entry in
                                HStack(spacing: 12) {
                                    Image(systemName: entry.sessionId == nil ? "folder" : "doc.text")
                                        .foregroundStyle(MathNotesTheme.accent)
                                        .frame(width: 24)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(entry.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                        Text(entry.sessionId == nil ? "Notebook" : "Session")
                                            .font(.system(size: 11)).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 12)
                                    Button("恢复") { onRestore(entry) }
                                        .buttonStyle(.borderedProminent)
                                        .controlSize(.small)
                                        .disabled(isRestoring || hasUnsavedDrafts)
                                }
                                .padding(12)
                                .background(MathNotesTheme.sidebar, in: RoundedRectangle(cornerRadius: 10))
                            }
                        }
                        .padding(16)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(MathNotesTheme.failure)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20).padding(.bottom, 16)
            }
            if !entries.isEmpty {
                Divider()
                HStack(spacing: 8) {
                    if isRestoring { ProgressView().controlSize(.mini) }
                    Text(hasUnsavedDrafts ? "请先保存当前编辑，再恢复笔记。" : "如需恢复其中的 Session，请先恢复它所属的 Notebook。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20).padding(.vertical, 12)
            }
        }
        .frame(width: 540, height: min(480, max(280, 148 + CGFloat(entries.count) * 76)), alignment: .top)
        .background(MathNotesTheme.canvas)
        .tint(MathNotesTheme.accent)
    }
}

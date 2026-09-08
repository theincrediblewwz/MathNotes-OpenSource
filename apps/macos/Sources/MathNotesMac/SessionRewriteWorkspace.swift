import SwiftUI

struct SessionRewriteWorkspace: View {
    let session: SessionCatalogItem
    @ObservedObject var supervisor: SidecarSupervisor
    var blockId: String? = nil
    var initialInstruction = ""
    var initialProposal: SessionRewriteProposal? = nil
    let onPrepare: () async throws -> Void
    let onApplied: () async -> Void
    let onClose: () -> Void
    @State private var instruction = ""
    @State private var proposal: SessionRewriteProposal?
    @State private var requestTask: Task<Void, Never>?
    @State private var isBusy = false
    @State private var status = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(blockId == nil ? "AI 修改整个 Session" : "AI 修改这个块", systemImage: "wand.and.sparkles")
                    .font(.headline)
                Spacer()
                Button("关闭") { close() }.disabled(isBusy)
            }
            Text("先比较修改前后的内容，再应用。固定块保持原样，修改建议会单独列出。")
                .font(.callout).foregroundStyle(.secondary)
            if proposal == nil {
                TextField("说明希望如何修改", text: $instruction, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(3...6)
                HStack {
                    Spacer()
                    if isBusy { Button("停止生成") { requestTask?.cancel() } }
                    Button("生成修改提案") { requestTask = Task { await generate() } }
                        .buttonStyle(.borderedProminent).tint(MathNotesTheme.accent)
                        .disabled(isBusy || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if isBusy { ProgressView(status).controlSize(.small) }
            if let error { Text(error).font(.callout).foregroundStyle(MathNotesTheme.failure).textSelection(.enabled) }
            if let proposal {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(proposal.instruction).font(.callout.weight(.medium)).textSelection(.enabled)
                        SessionRewriteSummary(proposal: proposal)
                        ForEach(proposal.changes) { change in
                            DisclosureGroup {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("修改前").font(.caption.weight(.semibold))
                                    source(change.beforeMarkdown)
                                    Text("修改后").font(.caption.weight(.semibold)).foregroundStyle(MathNotesTheme.accent)
                                    source(change.markdown)
                                }.padding(.top, 8)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(change.title).font(.callout.weight(.semibold))
                                    Text(change.reason).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(12).background(MathNotesTheme.canvas, in: RoundedRectangle(cornerRadius: 10))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                }
                HStack {
                    Spacer()
                    if proposal.status == "proposed" {
                        Button("取消本次修改") { close() }.disabled(isBusy)
                        Button(proposal.changes.isEmpty ? "保存修改说明" : "应用 \(proposal.changes.count) 个块的修改") {
                            requestTask = Task { await apply(proposal) }
                        }
                        .buttonStyle(.borderedProminent).tint(MathNotesTheme.accent).disabled(isBusy)
                    } else { Button("完成", action: onClose).keyboardShortcut(.defaultAction) }
                }
            } else { Spacer(minLength: 20) }
        }
        .padding(20).frame(minWidth: 640, idealWidth: 760, minHeight: 480, idealHeight: 640)
        .background(MathNotesTheme.canvas)
        .onAppear { instruction = initialInstruction; proposal = initialProposal }
        .onDisappear { requestTask?.cancel() }
        .interactiveDismissDisabled(isBusy)
    }

    private func source(_ text: String) -> some View {
        Text(text.isEmpty ? "（空内容）" : text).font(.system(.callout, design: .monospaced))
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            .padding(10).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6))
    }
    private func generate() async {
        isBusy = true; error = nil; status = "正在生成修改提案…"
        defer { isBusy = false; requestTask = nil }
        do {
            try await onPrepare()
            proposal = try await supervisor.sessionRewrite(session, action: "propose",
                input: SessionRewriteRequest(instruction: instruction, blockId: blockId))
        } catch is CancellationError { status = "" }
        catch { self.error = rewriteMessage(error) }
    }
    private func apply(_ value: SessionRewriteProposal) async {
        isBusy = true; error = nil; status = "正在复核版本并应用…"
        defer { isBusy = false; requestTask = nil }
        do {
            try await onPrepare()
            proposal = try await supervisor.sessionRewrite(session, action: "apply", input: SessionRewriteRequest(proposalId: value.id))
            await onApplied()
        } catch { self.error = rewriteMessage(error) }
    }
    private func close() {
        guard !isBusy else { return }
        guard let proposal, proposal.status == "proposed" else { onClose(); return }
        isBusy = true
        requestTask = Task {
            defer { isBusy = false; requestTask = nil }
            do {
                _ = try await supervisor.sessionRewrite(session, action: "cancel", input: SessionRewriteRequest(proposalId: proposal.id))
                onClose()
            } catch { self.error = rewriteMessage(error) }
        }
    }
    private func rewriteMessage(_ error: Error) -> String {
        if case let SidecarProtocolError.saveRejected(_, code, _) = error {
            switch code {
            case "revision_conflict": return "笔记在生成提案后发生了变化，尚未应用任何修改。请保留当前草稿，重新生成提案。"
            case "invalid_rewrite_response": return "AI 返回的提案格式不完整，尚未修改笔记。可以重新生成。"
            case "rewrite_too_large": return "本次笔记超出完整处理范围，请从块标题选择要修改的内容。"
            case "assistant_unavailable": return "请先在设置中配置 AI 对话服务。"
            default: break
            }
        }
        return error.localizedDescription
    }
}

struct SessionRewriteSummary: View {
    let proposal: SessionRewriteProposal
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(proposal.status == "applied" ? "已修改 \(proposal.changes.count) 个块" : "建议修改 \(proposal.changes.count) 个块",
                systemImage: proposal.status == "applied" ? "checkmark.circle" : "doc.text.magnifyingglass")
                .font(.callout.weight(.semibold)).foregroundStyle(MathNotesTheme.accent)
            Text(proposal.summary).font(.callout).textSelection(.enabled)
            if proposal.status == "applied" {
                ForEach(proposal.changes) { change in
                    Text("• \(change.title)：\(change.reason)").font(.callout).textSelection(.enabled)
                }
            }
            if !proposal.lockedSuggestions.isEmpty {
                Text("因为以下块已被锁定，未能进行更改").font(.callout.weight(.semibold)).padding(.top, 4)
                ForEach(proposal.lockedSuggestions) { item in
                    Text("• \(item.title)：\(item.reason)").font(.callout).textSelection(.enabled)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

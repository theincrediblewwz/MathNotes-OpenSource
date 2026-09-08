import AppKit
import SwiftUI

@main struct RewriteSmoke {
    @MainActor static func main() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let root = env["MATHNOTES_TEST_REWRITE_ROOT"], let node = env["MATHNOTES_TEST_NODE"],
              let script = env["MATHNOTES_TEST_SIDECAR"] else { throw Failure.missingEnvironment }
        NSApplication.shared.setActivationPolicy(.accessory)
        let token = UUID().uuidString + UUID().uuidString
        let supervisor = SidecarSupervisor(configuration: SidecarConfiguration(executableURL: URL(fileURLWithPath: node),
            arguments: [script], environment: ["PATH": "/usr/bin:/bin", "MATHNOTES_LOCAL_TOKEN": token,
                "MATHNOTES_USER_DATA_DIR": root + "/data", "MATHNOTES_NOTES_ROOT_DIR": root + "/notes",
                "MATHNOTES_TEMP_DIR": root + "/temp", "MATHNOTES_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier)],
            token: token, companionHostToken: UUID().uuidString))
        supervisor.start(); defer { supervisor.stop() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while supervisor.instanceID == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
        guard supervisor.instanceID != nil else { throw Failure.assertion("fixture did not start") }
        let notebook = try await supervisor.createNotebook(title: "AI 独立验收库")
        let session = try await supervisor.createSession(notebookId: notebook.notebookId, title: "全文修改验收")
        let fixed = try await supervisor.appendMarkdown(session, markdown: "固定定理：$a^2+b^2=c^2$", sourceName: "固定定理")
        _ = try await supervisor.setMarkdownBlockLock(session, blockId: fixed.block.id, locked: true)
        let original = try await supervisor.fetchSessionBlock(session, blockId: "0001")
        let proposal = try await supervisor.sessionRewrite(session, action: "propose", input: SessionRewriteRequest(instruction: "为整篇补充说明"))
        try expect(proposal.changes.count == 1 && proposal.lockedSuggestions.count == 1, "candidate must separate editable and fixed blocks")
        try expect(try await supervisor.fetchSessionBlock(session, blockId: "0001") == original, "propose must not edit notes")
        let window = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 760, height: 640), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; defer { window.close() }
        window.contentView = NSHostingView(rootView: SessionRewriteWorkspace(session: session, supervisor: supervisor,
            initialProposal: proposal, onPrepare: {}, onApplied: {}, onClose: {}))
        window.orderFront(nil)
        try await Task.sleep(for: .milliseconds(150))
        let applied = try await supervisor.sessionRewrite(session, action: "apply", input: SessionRewriteRequest(proposalId: proposal.id))
        try expect(applied.status == "applied", "native apply response")
        let actual = try await supervisor.fetchSessionBlock(session, blockId: "0001")
        guard case let .markdown(content) = actual.content else { throw Failure.assertion("expected Markdown") }
        try expect(content.markdown.contains("AI 原生验收修改"), "native candidate must reach saved block")
        let unchanged = try await supervisor.fetchSessionBlock(session, blockId: fixed.block.id)
        guard case let .markdown(fixedContent) = unchanged.content else { throw Failure.assertion("expected fixed Markdown") }
        try expect(fixedContent.markdown == "固定定理：$a^2+b^2=c^2$", "fixed text must remain exact")
        try expect(try await supervisor.sessionRewrites(session).first?.status == "applied", "summary history must persist")
        let next = try await supervisor.sessionRewrite(session, action: "propose", input: SessionRewriteRequest(instruction: "修改当前块", blockId: "0001"))
        _ = try await supervisor.saveMarkdownBlock(session, blockId: "0001", markdown: content.markdown + "\n人工新编辑", baseRevision: content.baseRevision)
        do {
            _ = try await supervisor.sessionRewrite(session, action: "apply", input: SessionRewriteRequest(proposalId: next.id))
            throw Failure.assertion("stale proposal unexpectedly applied")
        } catch SidecarProtocolError.saveRejected(409, "revision_conflict", _) { }
        print("MACOS_NATIVE_AI_REWRITE_PROPOSE_REVIEW_APPLY_FIXED_SUMMARY_CONFLICT_OK")
    }
    private static func expect(_ value: Bool, _ message: String) throws { if !value { throw Failure.assertion(message) } }
    enum Failure: Error { case missingEnvironment; case assertion(String) }
}

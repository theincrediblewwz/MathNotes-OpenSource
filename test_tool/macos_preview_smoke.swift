import AppKit
import SwiftUI
@preconcurrency import WebKit

// Exercises the actual SwiftUI preview and WKWebView against a real isolated
// Core. Source-string contracts cannot catch a spinner with fully loaded data.
@main
struct PreviewSmoke {
    @MainActor static func main() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let root = environment["MATHNOTES_TEST_PREVIEW_ROOT"],
              let node = environment["MATHNOTES_TEST_NODE"],
              let script = environment["MATHNOTES_TEST_SIDECAR"] else { throw Failure.missingEnvironment }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        try await verifyInertSourceUpdates()
        let companionToken = UUID().uuidString + UUID().uuidString
        let supervisor = SidecarSupervisor(configuration: SidecarConfiguration(
            executableURL: URL(fileURLWithPath: node), arguments: [script], environment: [
                "PATH": "/usr/bin:/bin", "MATHNOTES_LOCAL_TOKEN": String(repeating: "t", count: 48),
                "MATHNOTES_COMPANION_ENABLED": "1", "MATHNOTES_COMPANION_PORT": "1051",
                "MATHNOTES_COMPANION_TOKEN": companionToken, "MATHNOTES_USER_DATA_DIR": root + "/data",
                "MATHNOTES_NOTES_ROOT_DIR": root + "/notes", "MATHNOTES_TEMP_DIR": root + "/temp",
                "MATHNOTES_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier)
            ], token: String(repeating: "t", count: 48), companionHostToken: companionToken
        ))
        supervisor.start()
        defer { supervisor.stop() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        var session: SessionCatalogItem?
        while ContinuousClock.now < deadline {
            if case let .loaded(notebooks) = supervisor.catalogState,
               let value = notebooks.first?.sessions.first { session = value; break }
            try await Task.sleep(for: .milliseconds(30))
        }
        guard let session else { throw Failure.coreNotReady }
        let manifest = try await supervisor.fetchSessionManifest(session)
        let plan = SessionPreviewPlan(blocks: manifest.blocks)
        try expect(plan.markdown.count == 10 && plan.attachments.count == 2, "mixed fixture")

        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 700, height: 650),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let workspace = SessionSourceWorkspace()
        workspace.prepare(sessionID: session.id, revision: manifest.revision, blocks: manifest.blocks)
        let host = NSHostingView(rootView: SessionContinuousPreview(
            session: session, sessionRevision: manifest.revision, blocks: manifest.blocks,
            activeBlockID: .constant(nil), workspace: workspace, supervisor: supervisor
        ))
        window.contentView = host
        window.orderFront(nil)
        let start = ContinuousClock.now
        let web = try await waitForText("推导片段 9", in: host)
        let elapsed = start.duration(to: .now)
        try expect(workspace.payloads.count == 10, "assets must not enter the Markdown loading barrier")
        let formulas = try await web.evaluateJavaScript("document.querySelectorAll('.katex').length") as? Int ?? 0
        try expect(formulas > 0, "real KaTeX output must be mounted")
        print("MACOS_PREVIEW_MIXED_MARKDOWN_IMAGE_PDF_READY \(elapsed)")
        fflush(stdout)

        // Refresh a dirty draft while keeping the same WebView mounted.
        workspace.setDraft("## Live preview fixture", blockID: "0001")
        let refreshed = try await waitForText("Live preview fixture", in: host)
        try expect(refreshed === web, "live edits must preserve the continuous WebView")
        print("MACOS_PREVIEW_LIVE_EDIT_STABLE_WEBVIEW_OK")
        fflush(stdout)

        let findText = "😀 Ab ab 中文"
        let findBlocks = [SessionFindBlock(id: "open", text: findText, canReplace: true),
            SessionFindBlock(id: "locked", text: "ab", canReplace: false)]
        let found = SessionFindEngine.matches(in: findBlocks, query: "ab", matchCase: false)
        try expect(found.count == 3 && found[0].range == NSRange(location: 3, length: 2) && found[1].range.location == 6,
            "literal find must report UTF16 ranges after emoji and preserve block order")
        try expect(!found[2].canReplace, "fixed blocks remain searchable but cannot be replaced")
        try expect(SessionFindEngine.matches(in: findBlocks, query: "Ab", matchCase: true).count == 1, "case-sensitive search")
        try expect(SessionFindEngine.matches(in: findBlocks, query: "", matchCase: false).isEmpty, "empty searches must not produce zero-width replacements")
        try expect(SessionFindEngine.replacing(findText, ranges: Array(found.prefix(2)).map(\.range), with: "β") == "😀 β β 中文",
            "reverse-order replacement preserves emoji and later offsets")
        let raceWorkspace = SessionSourceWorkspace()
        let initialPayload = workspace.payloads["0001"]!
        raceWorkspace.applySaved(initialPayload)
        let submitted = "## 替换提交"
        let later = submitted + "\n保存期间继续输入"
        raceWorkspace.setDraft(later, blockID: "0001")
        let responsePayload = ReadonlySessionBlock(version: initialPayload.version, notebookId: initialPayload.notebookId,
            sessionId: initialPayload.sessionId, block: initialPayload.block,
            content: .markdown(MarkdownBlockContent(html: "", markdown: submitted, baseRevision: "saved-revision", blockLocked: false, protectedSpanCount: 0)))
        raceWorkspace.applySaved(responsePayload, submittedDraft: submitted)
        try expect(raceWorkspace.drafts["0001"] == later && raceWorkspace.originals["0001"] == submitted && raceWorkspace.isDirty(blockID: "0001"),
            "save acknowledgements must retain newer typing with the saved text as the new base")
        raceWorkspace.applyExternalDraft(submitted, blockID: "0001")
        try expect(!raceWorkspace.hasDirtyDrafts && raceWorkspace.aiEditEpochs["0001"] == 1, "external replacement undo must update dirty state and native undo epoch")
        print("MACOS_FIND_UTF16_CASE_LOCKS_REPLACEMENT_AND_SAVE_TYPING_RACE_OK")
        fflush(stdout)

        // Position storage is isolated from actual user preferences and from other hosts.
        let positionSuite = "mathnotes-reading-test-" + UUID().uuidString
        let positions = UserDefaults(suiteName: positionSuite)!
        defer { positions.removePersistentDomain(forName: positionSuite) }
        let positionKey = MacReadingPositionStore.key(source: "remote", hostID: "host-a", notebookID: "same", sessionID: "same")
        let otherKey = MacReadingPositionStore.key(source: "remote", hostID: "host-b", notebookID: "same", sessionID: "same")
        MacReadingPositionStore.save(MacReadingPosition(blockID: "position-3", fraction: 0.4), key: positionKey, defaults: positions)
        try expect(MacReadingPositionStore.load(otherKey, defaults: positions) == nil, "reading positions must not cross hosts")
        let positionBlocks = (0..<6).map { index in ContinuousMarkdownBlock(id: "position-\(index)", order: index,
            html: "<div style='height:500px'>Reading location \(index)</div>", version: "1", memberIDs: ["member-\(index)"]) }
        let positionHost = NSHostingView(rootView: StableSessionMarkdownWebView(blocks: Array(positionBlocks.prefix(4)),
            activeBlockID: .constant(nil), readingLocationKey: positionKey, positionDefaults: positions, readingPositionReady: false))
        window.contentView = positionHost
        let positionWeb = try await waitForText("Reading location 3", in: positionHost)
        let prematureTop = try await positionWeb.evaluateJavaScript("document.getElementById('scroll-root').scrollTop") as? Double ?? -1
        try expect(prematureTop == 0, "partial loading must not clamp the restored position at its temporary bottom")
        positionHost.rootView = StableSessionMarkdownWebView(blocks: positionBlocks, activeBlockID: .constant(nil),
            readingLocationKey: positionKey, positionDefaults: positions)
        _ = try await waitForText("Reading location 5", in: positionHost)
        let restoredFraction = try await positionWeb.evaluateJavaScript("(() => {const r=document.getElementById('scroll-root').getBoundingClientRect();const b=document.querySelector('[data-block-id=position-3]').getBoundingClientRect();return (r.top-b.top)/b.height})()") as? Double ?? -1
        try expect(abs(restoredFraction - 0.4) < 0.02, "restore must wait for its block and preserve intra-block fraction")
        positionHost.rootView = StableSessionMarkdownWebView(blocks: positionBlocks, activeBlockID: .constant("member-4"),
            readingLocationKey: positionKey, revealRequest: BlockNavigationRequest(blockID: "member-4"), positionDefaults: positions)
        let positionDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < positionDeadline && MacReadingPositionStore.load(positionKey, defaults: positions)?.blockID != "position-4" {
            try await Task.sleep(for: .milliseconds(20))
        }
        try expect(MacReadingPositionStore.load(positionKey, defaults: positions)?.blockID == "position-4", "source navigation must reveal continuation members and persist the new anchor")
        let reopenedHost = NSHostingView(rootView: StableSessionMarkdownWebView(blocks: positionBlocks, activeBlockID: .constant(nil),
            readingLocationKey: positionKey, positionDefaults: positions))
        window.contentView = reopenedHost
        let reopenedWeb = try await waitForText("Reading location 5", in: reopenedHost)
        let reopenedTop = try await reopenedWeb.evaluateJavaScript("document.querySelector('[data-block-id=position-4]').getBoundingClientRect().top-document.getElementById('scroll-root').getBoundingClientRect().top") as? Double ?? -999
        try expect(abs(reopenedTop) < 3, "reopening the web view must restore the saved block")
        print("MACOS_READING_POSITION_REOPEN_PARTIAL_LOAD_HOST_ISOLATION_AND_SOURCE_REVEAL_OK")
        fflush(stdout)

        // The Notebook hover card must use the same rendered HTML and KaTeX
        // surface as reading, rather than displaying raw Markdown in Text.
        let snippet = try await MacSessionPreviewLoader.load(
            session, sourceMode: .local, supervisor: supervisor, companionReader: CompanionReaderStore()
        )
        try expect(snippet.count == 3, "hover preview must stay bounded to three visible Markdown blocks")
        let hoverHost = NSHostingView(rootView: StableSessionMarkdownWebView(blocks: snippet, activeBlockID: .constant(nil)))
        window.contentView = hoverHost
        let hoverWeb = try await waitForText("推导片段 2", in: hoverHost)
        let hoverFormulaCount = try await hoverWeb.evaluateJavaScript("document.querySelectorAll('.katex').length") as? Int ?? 0
        try expect(hoverFormulaCount > 0, "hover preview must render actual formulas")
        print("MACOS_HOVER_RENDERED_MARKDOWN_KATEX_OK")
        fflush(stdout)

        // Exercise the actual remote-reader protocol against an isolated Core
        // host. Keep synthetic credentials in memory, never in the real Keychain.
        guard let port = supervisor.companionHost?.port else { throw Failure.coreNotReady }
        let remote = CompanionReaderStore(credentialProvider: {
            (origin: "http://127.0.0.1:\(port)", token: companionToken)
        })
        remote.reloadCatalog()
        let remoteDeadline = ContinuousClock.now.advanced(by: .seconds(8))
        while remote.state == .loading, ContinuousClock.now < remoteDeadline {
            try await Task.sleep(for: .milliseconds(30))
        }
        guard case let .loaded(remoteNotebooks) = remote.catalogState,
              let remoteSession = remoteNotebooks.first?.sessions.first else {
            throw Failure.assertion("remote catalog must load")
        }
        let remoteDocument = try await remote.loadDocument(remoteSession)
        try expect(remoteDocument.markdown.contains("半群与生成元"), "remote document must load after catalog selection")
        let hydrated = await remote.loadAssets(for: remoteDocument)
        try expect(hydrated.missingAssetCount == 0, "remote original assets must synchronize")
        let remoteSnippet = try await MacSessionPreviewLoader.load(
            remoteSession, sourceMode: .companion, supervisor: supervisor, companionReader: remote
        )
        let remoteHost = NSHostingView(rootView: StableSessionMarkdownWebView(blocks: remoteSnippet, activeBlockID: .constant(nil)))
        window.contentView = remoteHost
        let remoteWeb = try await waitForText("推导片段 9", in: remoteHost)
        let remoteFormulas = try await remoteWeb.evaluateJavaScript("document.querySelectorAll('.katex').length") as? Int ?? 0
        try expect(remoteFormulas > 0, "remote hover preview must render formulas")
        print("MACOS_REMOTE_CATALOG_DOCUMENT_ASSETS_AND_HOVER_OK")
        fflush(stdout)

        // Actual native replica controller -> separate authenticated local sidecar ->
        // host v3 protocol. No real profile, notes directory or Keychain is touched.
        let suiteName = "MathNotes.ReplicaSmoke." + UUID().uuidString
        let isolatedDefaults = UserDefaults(suiteName: suiteName)!
        defer { isolatedDefaults.removePersistentDomain(forName: suiteName) }
        let replicaConfiguration: (String) throws -> SidecarConfiguration = { hostID in
            let replicaRoot = root + "/replicas/" + hostID
            let token = UUID().uuidString + UUID().uuidString
            return SidecarConfiguration(executableURL: URL(fileURLWithPath: node), arguments: [script], environment: [
                "PATH": "/usr/bin:/bin", "MATHNOTES_LOCAL_TOKEN": token,
                "MATHNOTES_COMPANION_ENABLED": "0", "MATHNOTES_REPLICA_HOST_ID": hostID,
                "MATHNOTES_USER_DATA_DIR": replicaRoot + "/data", "MATHNOTES_NOTES_ROOT_DIR": replicaRoot + "/notes",
                "MATHNOTES_TEMP_DIR": replicaRoot + "/temp", "MATHNOTES_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier)
            ], token: token, companionHostToken: UUID().uuidString)
        }
        let replicaReader = CompanionReaderStore(credentialProvider: {
            (origin: "http://127.0.0.1:\(port)", token: companionToken)
        }, profileDefaults: isolatedDefaults, replicaConfiguration: replicaConfiguration)
        defer { replicaReader.clear() }
        replicaReader.reloadCatalog()
        let replicaDeadline = ContinuousClock.now.advanced(by: .seconds(20))
        while replicaReader.syncResult == nil, ContinuousClock.now < replicaDeadline {
            try await Task.sleep(for: .milliseconds(40))
        }
        guard let replica = replicaReader.replicaSupervisor, let sync = replicaReader.syncResult,
              case let .loaded(replicaNotebooks) = replicaReader.catalogState,
              let replicaSession = replicaNotebooks.flatMap(\.sessions).first(where: { $0.id == session.id }) else {
            throw Failure.assertion("native editable replica must initialize: \(replicaReader.syncMessage ?? "no status")")
        }
        try expect(sync.pendingCount == 0 && sync.conflictCount == 0, "initial native replica download")
        let replicaManifest = try await replica.fetchSessionManifest(replicaSession)
        try expect(replicaManifest.blocks.count == manifest.blocks.count, "replica must preserve all Markdown/image/PDF blocks")
        let replicaSnippet = try await MacSessionPreviewLoader.load(replicaSession, sourceMode: .companion,
            supervisor: replica, companionReader: replicaReader)
        try expect(replicaSnippet.count == 3, "replica hover must read the local block catalog")
        let replicaBlock = try await replica.fetchSessionBlock(replicaSession, blockId: "0001")
        guard case let .markdown(replicaContent) = replicaBlock.content else { throw Failure.assertion("editable Markdown required") }
        _ = try await replica.saveMarkdownBlock(replicaSession, blockId: "0001",
            markdown: replicaContent.markdown + "\n\nNative replica edit", baseRevision: replicaContent.baseRevision)
        // The successful edit notification triggers synchronization without a UI refresh.
        let pushDeadline = ContinuousClock.now.advanced(by: .seconds(12))
        var pushed = false
        while ContinuousClock.now < pushDeadline {
            let block = try await supervisor.fetchSessionBlock(session, blockId: "0001")
            if case let .markdown(content) = block.content, content.markdown.contains("Native replica edit") { pushed = true; break }
            try await Task.sleep(for: .milliseconds(80))
        }
        try expect(pushed, "native local save must automatically reach the isolated host")
        replicaReader.clear()
        try await Task.sleep(for: .milliseconds(150))
        replicaReader.reloadCatalog()
        let restartDeadline = ContinuousClock.now.advanced(by: .seconds(20))
        while replicaReader.syncResult == nil, ContinuousClock.now < restartDeadline {
            try await Task.sleep(for: .milliseconds(40))
        }
        guard let restartedReplica = replicaReader.replicaSupervisor else { throw Failure.coreNotReady }
        let restartedBlock = try await restartedReplica.fetchSessionBlock(replicaSession, blockId: "0001")
        guard case let .markdown(restartedContent) = restartedBlock.content else { throw Failure.coreNotReady }
        try expect(restartedContent.markdown.contains("Native replica edit"), "restarting must preserve the replica and its baseline")
        try expect(RemoteHostProfile.load(defaults: isolatedDefaults).count == 1, "restarting must retain one stable host profile")

        // Keep the full reader mounted across a remote pull. A separate dirty
        // workspace models an editor that has not saved its old version yet.
        let liveReplicaHost = NSHostingView(rootView: ReadonlySessionView(session: replicaSession,
            supervisor: restartedReplica, assistantWindow: SessionAssistantWindowCoordinator(),
            onOpenRelatedSource: { _ in }, onOpenSession: { _ in }, onDirtyStateChanged: { _ in }))
        window.contentView = liveReplicaHost
        _ = try await waitForText("Native replica edit", in: liveReplicaHost)
        let dirtyWorkspace = SessionSourceWorkspace()
        let beforePullManifest = try await restartedReplica.fetchSessionManifest(replicaSession)
        dirtyWorkspace.prepare(sessionID: replicaSession.id, revision: beforePullManifest.revision, blocks: beforePullManifest.blocks)
        dirtyWorkspace.applySaved(restartedBlock)
        dirtyWorkspace.setDraft(restartedContent.markdown + "\n\nUnsaved local draft", blockID: "0001")
        let hostBeforePull = try await supervisor.fetchSessionBlock(session, blockId: "0001")
        guard case let .markdown(hostBeforePullContent) = hostBeforePull.content else { throw Failure.coreNotReady }
        _ = try await supervisor.saveMarkdownBlock(session, blockId: "0001",
            markdown: hostBeforePullContent.markdown + "\n\nExternal host update now visible",
            baseRevision: hostBeforePullContent.baseRevision)
        _ = try await restartedReplica.synchronizeReplica(origin: "http://127.0.0.1:\(port)", hostToken: companionToken, hostId: sync.hostId)
        _ = try await waitForText("External host update now visible", in: liveReplicaHost)
        let afterPullManifest = try await restartedReplica.fetchSessionManifest(replicaSession)
        guard let afterPullBlock = afterPullManifest.blocks.first(where: { $0.id == "0001" }) else { throw Failure.coreNotReady }
        dirtyWorkspace.prepare(sessionID: replicaSession.id, revision: afterPullManifest.revision, blocks: afterPullManifest.blocks)
        await dirtyWorkspace.load(session: replicaSession, block: afterPullBlock, supervisor: restartedReplica, force: true)
        guard let preserved = dirtyWorkspace.payloads["0001"], case let .markdown(preservedContent) = preserved.content else { throw Failure.coreNotReady }
        try expect(preservedContent.baseRevision == restartedContent.baseRevision, "refresh must not rebase an unsaved draft onto a newer revision")
        try expect(dirtyWorkspace.drafts["0001"]?.contains("Unsaved local draft") == true, "refresh must retain the unsaved text")
        do {
            _ = try await restartedReplica.saveMarkdownBlock(replicaSession, blockId: "0001",
                markdown: dirtyWorkspace.drafts["0001"]!, baseRevision: preservedContent.baseRevision)
            throw Failure.assertion("stale draft save must be rejected")
        } catch let error as SidecarProtocolError {
            guard case .saveRejected(_, "revision_conflict", _) = error else { throw error }
        }
        let afterRejectedSave = try await restartedReplica.fetchSessionBlock(replicaSession, blockId: "0001")
        guard case let .markdown(afterRejectedContent) = afterRejectedSave.content else { throw Failure.coreNotReady }
        try expect(afterRejectedContent.markdown.contains("External host update now visible"), "rejected draft must not overwrite the pulled note")
        window.contentView = NSView()
        print("MACOS_REPLICA_LIVE_READER_REFRESH_AND_STALE_DRAFT_PROTECTION_OK")
        fflush(stdout)
        replicaReader.clear()
        print("MACOS_NATIVE_REPLICA_DOWNLOAD_EDIT_AUTO_SYNC_RESTART_OK")
        fflush(stdout)

        // Exercise native catalog calls with automatic syncing paused, so the
        // offline sequence and conflicting host write happen deterministically.
        do {
            let catalogReplica = SidecarSupervisor(configuration: try replicaConfiguration(sync.hostId))
            catalogReplica.start()
            defer { catalogReplica.stop() }
            let catalogDeadline = ContinuousClock.now.advanced(by: .seconds(12))
            while ContinuousClock.now < catalogDeadline {
                if case .loaded = catalogReplica.catalogState { break }
                try await Task.sleep(for: .milliseconds(40))
            }
            let catalogSync = try await catalogReplica.synchronizeReplica(origin: "http://127.0.0.1:\(port)", hostToken: companionToken, hostId: sync.hostId)
            try expect(catalogSync.catalogManagementAvailable == true, "native protocol must decode catalog capabilities")
            let remoteNotebook = try await catalogReplica.createNotebook(title: "远程目录原生验收")
            let remoteSession = try await catalogReplica.createSession(notebookId: remoteNotebook.notebookId, title: "离线创建")
            let newBlock = try await catalogReplica.fetchSessionBlock(remoteSession, blockId: "0001")
            guard case let .markdown(newMarkdown) = newBlock.content else { throw Failure.coreNotReady }
            _ = try await catalogReplica.saveMarkdownBlock(remoteSession, blockId: "0001", markdown: "离线创建后的正文", baseRevision: newMarkdown.baseRevision)
            let pendingCatalog = try await catalogReplica.replicaStatus()
            try expect(pendingCatalog.catalogOperations?.count == 2 && pendingCatalog.pendingCount == 2, "native protocol must count offline directory operations")
            _ = try await catalogReplica.synchronizeReplica(origin: "http://127.0.0.1:\(port)", hostToken: companionToken, hostId: sync.hostId)
            let createdAtHost = try await supervisor.fetchSessionBlock(remoteSession, blockId: "0001")
            guard case let .markdown(createdAtHostContent) = createdAtHost.content else { throw Failure.coreNotReady }
            try expect(createdAtHostContent.markdown == "离线创建后的正文", "native remote creation must upload later edits")
            try await catalogReplica.manageWorkspace(WorkspaceManageRequest(action: "rename", notebookId: remoteNotebook.notebookId,
                sessionId: remoteSession.sessionId, title: "已通过远程改名"))
            try await catalogReplica.manageWorkspace(WorkspaceManageRequest(action: "trash", notebookId: remoteNotebook.notebookId,
                sessionId: remoteSession.sessionId))
            let remoteTrash = try await catalogReplica.workspaceTrash()
            guard let remoteReceipt = remoteTrash.first(where: { $0.sessionId == remoteSession.sessionId }) else { throw Failure.coreNotReady }
            try await catalogReplica.manageWorkspace(WorkspaceManageRequest(action: "restore", notebookId: remoteNotebook.notebookId,
                sessionId: remoteSession.sessionId, deletionId: remoteReceipt.id))
            let appliedCatalog = try await catalogReplica.synchronizeReplica(origin: "http://127.0.0.1:\(port)", hostToken: companionToken, hostId: sync.hostId)
            try expect(appliedCatalog.catalogOperations?.isEmpty == true, "native rename/trash/restore must finish")
            let localBeforeConflict = try await catalogReplica.fetchSessionBlock(remoteSession, blockId: "0001")
            guard case let .markdown(localBeforeConflictContent) = localBeforeConflict.content else { throw Failure.coreNotReady }
            _ = try await catalogReplica.saveMarkdownBlock(remoteSession, blockId: "0001", markdown: "冲突中的本地内容必须备份", baseRevision: localBeforeConflictContent.baseRevision)
            try await catalogReplica.manageWorkspace(WorkspaceManageRequest(action: "rename", notebookId: remoteNotebook.notebookId, sessionId: nil, title: "冲突中的本地名称"))
            let hostBeforeConflict = try await supervisor.fetchSessionBlock(remoteSession, blockId: "0001")
            guard case let .markdown(hostBeforeConflictContent) = hostBeforeConflict.content else { throw Failure.coreNotReady }
            _ = try await supervisor.saveMarkdownBlock(remoteSession, blockId: "0001", markdown: "主机的新内容", baseRevision: hostBeforeConflictContent.baseRevision)
            let conflictedCatalog = try await catalogReplica.synchronizeReplica(origin: "http://127.0.0.1:\(port)", hostToken: companionToken, hostId: sync.hostId)
            try expect(conflictedCatalog.conflictCount == 1, "directory conflicts must reach the native status page")
            guard let catalogConflict = try await catalogReplica.replicaCatalogConflicts().first else { throw Failure.coreNotReady }
            try expect(catalogConflict.localText.contains("冲突中的本地内容必须备份"), "native conflict details must preserve local text")
            let catalogResolution = try await catalogReplica.resolveReplicaCatalog(operationId: catalogConflict.id)
            let recoveryRoot = root + "/replicas/" + sync.hostId + "/notes/" + catalogResolution.backupRelativePath
            try expect(FileManager.default.fileExists(atPath: recoveryRoot + "/notebook/sessions/" + remoteSession.sessionId + "/session.json"), "conflict resolution must retain a real notebook backup")
            _ = try await catalogReplica.synchronizeReplica(origin: "http://127.0.0.1:\(port)", hostToken: companionToken, hostId: sync.hostId)
            let afterCatalogResolution = try await catalogReplica.fetchSessionBlock(remoteSession, blockId: "0001")
            guard case let .markdown(resolvedContent) = afterCatalogResolution.content else { throw Failure.coreNotReady }
            try expect(resolvedContent.markdown == "主机的新内容", "native conflict resolution must pull the host version")
            catalogReplica.stop()
            print("MACOS_NATIVE_REPLICA_CATALOG_CREATE_EDIT_TRASH_RESTORE_AND_CONFLICT_BACKUP_OK")
            fflush(stdout)
        }

        // Restart without credentials: cached capabilities keep offline catalog edits available.
        do {
            let offlineReader = CompanionReaderStore(credentialProvider: { throw CompanionConnectionError.missingToken },
                profileDefaults: isolatedDefaults, replicaConfiguration: replicaConfiguration)
            defer { offlineReader.clear() }
            offlineReader.reloadCatalog()
            let offlineDeadline = ContinuousClock.now.advanced(by: .seconds(16))
            while offlineReader.state != .ready, ContinuousClock.now < offlineDeadline {
                try await Task.sleep(for: .milliseconds(40))
            }
            guard let offlineReplica = offlineReader.replicaSupervisor else { throw Failure.coreNotReady }
            try expect(offlineReader.syncResult?.catalogManagementAvailable == true, "missing credentials must not hide previously supported offline catalog operations")
            let offlineNotebook = try await offlineReplica.createNotebook(title: "凭据暂不可用时的新笔记本")
            try expect((try await offlineReplica.replicaStatus()).catalogOperations?.count == 1, "offline creation must be durable without credentials")
            offlineReader.clear()
            let reconnected = SidecarSupervisor(configuration: try replicaConfiguration(sync.hostId))
            reconnected.start()
            defer { reconnected.stop() }
            let reconnectDeadline = ContinuousClock.now.advanced(by: .seconds(12))
            while reconnected.instanceID == nil, ContinuousClock.now < reconnectDeadline {
                try await Task.sleep(for: .milliseconds(40))
            }
            let afterReconnect = try await reconnected.synchronizeReplica(origin: "http://127.0.0.1:\(port)", hostToken: companionToken, hostId: sync.hostId)
            try expect(afterReconnect.catalogOperations?.isEmpty == true, "offline operation must upload when credentials return")
            let uploadedNotebook = root + "/notes/notebooks/" + offlineNotebook.notebookId + "/notebook.json"
            try expect(FileManager.default.fileExists(atPath: uploadedNotebook), "offline notebook must reach the intended host")
            reconnected.stop()
            print("MACOS_OFFLINE_CATALOG_CAPABILITIES_AND_CREDENTIAL_RECOVERY_OK")
            fflush(stdout)
        }

        // Native client -> authenticated local HTTP -> real filesystem management.
        let managedNotebook = try await supervisor.createNotebook(title: "管理回归")
        let managedSession = try await supervisor.createSession(notebookId: managedNotebook.notebookId, title: "管理 Session")
        try await supervisor.manageWorkspace(WorkspaceManageRequest(action: "rename", notebookId: managedSession.notebookId,
            sessionId: managedSession.sessionId, title: "已重命名"))
        guard case let .loaded(afterRename) = supervisor.catalogState else { throw Failure.coreNotReady }
        try expect(afterRename.flatMap(\.sessions).contains { $0.id == managedSession.id && $0.title == "已重命名" }, "rename must refresh the native catalog")
        try await supervisor.manageWorkspace(WorkspaceManageRequest(action: "trash", notebookId: managedSession.notebookId, sessionId: managedSession.sessionId))
        let trash = try await supervisor.workspaceTrash()
        guard let receipt = trash.first(where: { $0.sessionId == managedSession.sessionId }) else { throw Failure.assertion("recoverable receipt must persist") }
        try await supervisor.manageWorkspace(WorkspaceManageRequest(action: "restore", notebookId: managedSession.notebookId,
            sessionId: managedSession.sessionId, deletionId: receipt.id))
        _ = try await supervisor.fetchSessionManifest(managedSession)
        print("MACOS_WORKSPACE_RENAME_TRASH_RESTORE_OK")
        fflush(stdout)

        // A selected substring inside a formula becomes its own fixed block,
        // while the existing WKWebView renders the exact joined source.
        let splitSession = try await supervisor.createSession(notebookId: managedNotebook.notebookId, title: "固定块渲染验收")
        let initialSplitBlock = try await supervisor.fetchSessionBlock(splitSession, blockId: "0001")
        guard case let .markdown(initialSplitContent) = initialSplitBlock.content else { throw Failure.coreNotReady }
        let splitMarkdown = "# 拆块验收 😀\n\n$$\\frac{a+b}{c}=d$$\n\n| 项目 | 值 |\n| --- | --- |\n| 结果 | $x^2$ |\n\n保持原文顺序"
        let savedSplitBlock = try await supervisor.saveMarkdownBlock(splitSession, blockId: "0001",
            markdown: splitMarkdown, baseRevision: initialSplitContent.baseRevision)
        guard case let .markdown(savedSplitContent) = savedSplitBlock.content else { throw Failure.coreNotReady }
        let formulaRange = (splitMarkdown as NSString).range(of: "a+b")
        let split = try await supervisor.splitLockedSelection(splitSession, blockId: "0001",
            baseRevision: savedSplitContent.baseRevision,
            selection: SelectionEditTextRange(from: formulaRange.location, to: formulaRange.location + formulaRange.length, selectedText: "a+b"))
        try expect(split.blocks.count == 3, "selection must become three stored blocks")
        try expect(split.blocks.filter { $0.block.status == "locked" }.count == 1, "only selected block is locked")
        let reconstructed = split.blocks.compactMap { block -> String? in
            if case let .markdown(content) = block.content { return content.markdown }; return nil
        }.joined()
        try expect(reconstructed == splitMarkdown, "split must preserve exact UTF-16 text including emoji")
        let splitManifest = try await supervisor.fetchSessionManifest(splitSession)
        let splitWorkspace = SessionSourceWorkspace()
        splitWorkspace.prepare(sessionID: splitSession.id, revision: splitManifest.revision, blocks: splitManifest.blocks)
        let splitHost = NSHostingView(rootView: SessionContinuousPreview(session: splitSession,
            sessionRevision: splitManifest.revision, blocks: splitManifest.blocks, activeBlockID: .constant(split.lockedBlockId),
            workspace: splitWorkspace, supervisor: supervisor))
        window.contentView = splitHost
        let splitWeb = try await waitForText("保持原文顺序", in: splitHost)
        let splitFormulaCount = try await splitWeb.evaluateJavaScript("document.querySelectorAll('.katex').length") as? Int ?? 0
        let splitTableCount = try await splitWeb.evaluateJavaScript("document.querySelectorAll('#article table').length") as? Int ?? 0
        try expect(splitFormulaCount == 2 && splitTableCount == 1, "split formula and table must both remain rendered")
        let splitPreview = try await MacSessionPreviewLoader.load(splitSession, sourceMode: .local,
            supervisor: supervisor, companionReader: remote)
        try expect(splitPreview.count == 1, "hover must render the split group as one continuous source")
        guard let tail = split.blocks.last, case let .markdown(tailContent) = tail.content else { throw Failure.coreNotReady }
        splitWorkspace.setDraft(tailContent.markdown + "\n\n拆块后继续编辑", blockID: tail.block.id)
        let editedSplitWeb = try await waitForText("拆块后继续编辑", in: splitHost)
        try expect(editedSplitWeb === splitWeb, "editing an unlocked piece must preserve the WebView")
        print("MACOS_EXACT_SPLIT_LOCK_FORMULA_TABLE_AND_LIVE_EDIT_OK")
        fflush(stdout)

        // Old OCR placeholders render their real processed source image without
        // rewriting the user's Markdown. All files below belong to this fixture.
        let imageSession = try await supervisor.createSession(notebookId: managedNotebook.notebookId, title: "识别原图")
        let imageRoot = root + "/notes/notebooks/" + imageSession.notebookId + "/sessions/" + imageSession.sessionId
        let imagePath = "assets/原图 (1).png"
        try FileManager.default.createDirectory(atPath: imageRoot + "/assets", withIntermediateDirectories: true)
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
        try png.write(to: URL(fileURLWithPath: imageRoot + "/" + imagePath))
        let imageManifestURL = URL(fileURLWithPath: imageRoot + "/session.json")
        var imageStored = try JSONSerialization.jsonObject(with: Data(contentsOf: imageManifestURL)) as! [String: Any]
        var imageBlocks = imageStored["blocks"] as! [[String: Any]]
        imageBlocks[0]["fromAssets"] = [imagePath]
        imageStored["blocks"] = imageBlocks
        try JSONSerialization.data(withJSONObject: imageStored).write(to: imageManifestURL, options: .atomic)
        let imageMarkdown = "[图片：单位圆与坐标轴]\n\n[[mathnotes:source-image]]\n\n图形后的公式 $x^2+y^2=1$。"
        let imageMarkdownURL = URL(fileURLWithPath: imageRoot + "/" + (imageBlocks[0]["path"] as! String))
        try imageMarkdown.write(to: imageMarkdownURL, atomically: true, encoding: .utf8)
        let imageManifest = try await supervisor.fetchSessionManifest(imageSession)
        let imageWorkspace = SessionSourceWorkspace()
        imageWorkspace.prepare(sessionID: imageSession.id, revision: imageManifest.revision, blocks: imageManifest.blocks)
        let imageHost = NSHostingView(rootView: SessionContinuousPreview(session: imageSession,
            sessionRevision: imageManifest.revision, blocks: imageManifest.blocks, activeBlockID: .constant(nil),
            workspace: imageWorkspace, supervisor: supervisor))
        window.contentView = imageHost
        let imageWeb = try await waitForText("图形后的公式", in: imageHost)
        let imageDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        var imageLoaded = false
        while ContinuousClock.now < imageDeadline {
            imageLoaded = try await imageWeb.evaluateJavaScript("document.querySelectorAll('#article img').length === 1 && document.querySelector('#article img').naturalWidth > 0") as? Bool ?? false
            if imageLoaded { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        try expect(imageLoaded, "processed original image must actually decode in WKWebView")
        let imagePosition = try await imageWeb.evaluateJavaScript("(() => { const p = document.querySelector('#article img').closest('p'); return p.previousElementSibling.textContent.includes('单位圆') && p.nextElementSibling.textContent.includes('图形后的公式'); })()") as? Bool ?? false
        try expect(imagePosition, "image must appear between its explanation and following text")
        try expect(try String(contentsOf: imageMarkdownURL, encoding: .utf8) == imageMarkdown, "reading original images must not rewrite stored notes")
        print("MACOS_ORIGINAL_IMAGE_DECODE_POSITION_AND_NONMUTATING_READ_OK")
        fflush(stdout)

        // A missing paragraph should report a recoverable error without hiding
        // all the healthy paragraphs behind an endless spinner.
        let sessionRoot = root + "/notes/notebooks/" + session.notebookId + "/sessions/" + session.sessionId
        let stored = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sessionRoot + "/session.json"))) as! [String: Any]
        let storedBlocks = stored["blocks"] as! [[String: Any]]
        let missingPath = storedBlocks.first { $0["id"] as? String == "0002" }!["path"] as! String
        try FileManager.default.removeItem(atPath: sessionRoot + "/" + missingPath)
        let brokenWorkspace = SessionSourceWorkspace()
        brokenWorkspace.prepare(sessionID: session.id, revision: manifest.revision, blocks: manifest.blocks)
        let brokenHost = NSHostingView(rootView: SessionContinuousPreview(
            session: session, sessionRevision: manifest.revision, blocks: manifest.blocks,
            activeBlockID: .constant(nil), workspace: brokenWorkspace, supervisor: supervisor
        ))
        window.contentView = brokenHost
        _ = try await waitForText("推导片段 9", in: brokenHost)
        try expect(brokenWorkspace.errors["0002"] != nil, "missing paragraph must reach an error state")
        print("MACOS_PREVIEW_PARTIAL_FAILURE_REMAINS_READABLE_OK")
        let shareFolder = URL(fileURLWithPath: root + "/share-fixture")
        try FileManager.default.createDirectory(at: shareFolder.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let shareMarkdown = "<!-- block:id=0012 source=ai_transcription -->\n\n# Share import\n\nFormula $x^2$\n\n![image](assets/photo.png)\n\n<!-- block:id=0018 source=user_revision -->\n\nSecond restored block"
        let sharePhoto = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3sAAAAASUVORK5CYII=")!
        try shareMarkdown.write(to: shareFolder.appendingPathComponent("Windows.md"), atomically: true, encoding: .utf8)
        try sharePhoto.write(to: shareFolder.appendingPathComponent("assets/photo.png"))
        let shared = try await supervisor.importSharePackage(packagePath: shareFolder.path, notebookId: nil)
        try expect(shared.assetCount == 1, "native import decodes resource count")
        let sharedManifest = try await supervisor.fetchSessionManifest(shared.session)
        try expect(sharedManifest.blocks.map(\.id) == ["0012", "0018"], "native import restores Windows block boundaries")
        let shareBytes = try await supervisor.exportSharePackage(shared.session, baseRevision: sharedManifest.revision)
        try expect(shareBytes.prefix(2) == Data([0x50, 0x4b]), "native export returns a ZIP")
        let shareZip = URL(fileURLWithPath: root + "/round-trip.zip")
        try shareBytes.write(to: shareZip)
        let sharedAgain = try await supervisor.importSharePackage(packagePath: shareZip.path, notebookId: shared.session.notebookId)
        try expect(sharedAgain.assetCount == 1 && sharedAgain.session.sessionId != shared.session.sessionId, "native round trip creates independent Session")
        let againManifest = try await supervisor.fetchSessionManifest(sharedAgain.session)
        try expect(againManifest.blocks.map(\.id) == ["0012", "0018"], "ZIP reexport retains imported block boundaries")
        let pickerHost = SharePackagePanelHost()
        let pickerWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        let pickerAnchor = SharePackagePanelAnchor.AnchorView()
        pickerAnchor.host = pickerHost
        pickerWindow.contentView = pickerAnchor
        try expect(pickerHost.window === pickerWindow, "picker retains its initiating window without querying application focus")
        try expect(pickerAnchor.hitTest(.zero) == nil, "picker window anchor never intercepts content clicks")
        pickerWindow.contentView = nil
        try expect(pickerHost.window == nil, "picker clears detached workspace window")
        try expect(SharePackagePicker.supports(shareZip) && SharePackagePicker.supports(shareFolder), "picker enables ZIP and folders without UTI metadata")
        try expect(!SharePackagePicker.supports(shareFolder.appendingPathComponent("unsupported.exe")), "picker filters unrelated files")
        print("MACOS_SHARE_PACKAGE_NATIVE_CLIENT_ROUND_TRIP_OK")
        let importedWorkspace = SessionSourceWorkspace()
        importedWorkspace.prepare(sessionID: shared.session.id, revision: sharedManifest.revision, blocks: sharedManifest.blocks)
        let importedHost = NSHostingView(rootView: SessionContinuousPreview(session: shared.session,
            sessionRevision: sharedManifest.revision, blocks: sharedManifest.blocks, activeBlockID: .constant(nil),
            workspace: importedWorkspace, supervisor: supervisor))
        window.contentView = importedHost
        let importedWeb = try await waitForText("Share import", in: importedHost)
        let shareImageDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        var shareImageLoaded = false
        while ContinuousClock.now < shareImageDeadline {
            shareImageLoaded = try await importedWeb.evaluateJavaScript("Array.from(document.querySelectorAll('img')).some(i => i.complete && i.naturalWidth > 0)") as? Bool ?? false
            if shareImageLoaded { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        try expect(shareImageLoaded, "imported share resources must render through the real Core asset route")
        print("MACOS_IMPORTED_SHARE_IMAGE_RENDERED_OK")
    }

    @MainActor private static func waitForText(_ text: String, in host: NSView) async throws -> WKWebView {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while ContinuousClock.now < deadline {
            if let web = findWebView(host),
               let body = try? await web.evaluateJavaScript("document.getElementById('article')?.innerText ?? ''") as? String,
               body.contains(text) { return web }
            try await Task.sleep(for: .milliseconds(30))
        }
        throw Failure.previewTimedOut(text)
    }

    @MainActor private static func findWebView(_ view: NSView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        return view.subviews.lazy.compactMap(findWebView).first
    }
    private static func expect(_ condition: Bool, _ label: String) throws {
        if !condition { throw Failure.assertion(label) }
    }
    enum Failure: Error { case missingEnvironment, coreNotReady, previewTimedOut(String), assertion(String) }
}

// Re-rendering the SwiftUI wrapper must not edit NSTextStorage, move the caret,
// or activate the source pane while the user reads the other pane.
@MainActor
private func verifyInertSourceUpdates() async throws {
    var text = "# Source\n\nFormula $x^2$ and text."
    var selected = "", range: UTF16TextSelection?, height: CGFloat = 100
    var activations = 0
    func editor(_ epoch: Int, size: Double = 14) -> SelectionAwareTextEditor {
        SelectionAwareTextEditor(text: Binding(get: { text }, set: { text = $0 }),
            selectedText: Binding(get: { selected }, set: { selected = $0 }),
            selectedRange: Binding(get: { range }, set: { range = $0 }),
            contentHeight: Binding(get: { height }, set: { height = $0 }),
            externalEditEpoch: epoch, fontPreset: "system", fontSize: size, onActivate: { activations += 1 })
    }
    let host = NSHostingView(rootView: editor(0))
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    defer { window.close() }
    window.orderFront(nil)
    try await Task.sleep(for: .milliseconds(120))
    func findText(_ view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        return view.subviews.compactMap(findText).first
    }
    guard let textView = findText(host), let storage = textView.textStorage else { fatalError("source editor not mounted") }
    textView.setSelectedRange(NSRange(location: 2, length: 6))
    try await Task.sleep(for: .milliseconds(40))
    activations = 0
    final class Counter: @unchecked Sendable { var edits = 0 }
    let counter = Counter()
    let observer = NotificationCenter.default.addObserver(forName: NSTextStorage.didProcessEditingNotification, object: storage, queue: .main) { _ in counter.edits += 1 }
    defer { NotificationCenter.default.removeObserver(observer) }
    for epoch in 1...30 {
        host.rootView = editor(epoch)
        try await Task.sleep(for: .milliseconds(16))
    }
    guard counter.edits == 0, activations == 0, textView.selectedRange() == NSRange(location: 2, length: 6), findText(host) === textView else {
        fatalError("unchanged source updates caused edits=\(counter.edits), activations=\(activations)")
    }
    host.rootView = editor(31, size: 18)
    try await Task.sleep(for: .milliseconds(80))
    guard textView.font?.pointSize == 18, counter.edits > 0 else { fatalError("real typography changes must still apply") }
    print("MACOS_SOURCE_NOOP_UPDATES_PRESERVE_LAYOUT_SELECTION_AND_FOCUS_OK")
}

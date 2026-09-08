import Foundation

struct LocalShellHealth: Decodable, Equatable {
    let ok: Bool
    let apiVersion: Int
}

struct LocalShellClient {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func health(ready: SidecarReadyMessage, token: String) async throws -> LocalShellHealth {
        let (data, response) = try await request(path: "local/v1/health", ready: ready, token: token)
        guard response.statusCode == 200 else { throw SidecarProtocolError.healthRejected(response.statusCode) }
        let health = try JSONDecoder().decode(LocalShellHealth.self, from: data)
        guard health.ok, health.apiVersion == ready.apiVersion else {
            throw SidecarProtocolError.unhealthyResponse
        }
        return health
    }

    func createCompanionPairingChallenge(
        ready: SidecarReadyMessage,
        token: String
    ) async throws -> CompanionPairingChallenge {
        let (data, response) = try await request(
            path: "local/v1/companion/pairing-challenge",
            ready: ready,
            token: token,
            timeout: 5,
            method: "POST"
        )
        guard response.statusCode == 201 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            let message = payload?.error == "device_pairing_unavailable"
                ? "设备连接服务尚未准备好，请稍后重试。"
                : "一次性配对码生成失败，请稍后重试。"
            throw NSError(
                domain: "MathNotes.CompanionPairing",
                code: response.statusCode,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        }
        return try JSONDecoder().decode(CompanionPairingChallengeResponse.self, from: data).challenge
    }

    func catalog(ready: SidecarReadyMessage, token: String) async throws -> NotesCatalog {
        let (data, response) = try await request(path: "local/v1/catalog", ready: ready, token: token)
        guard response.statusCode == 200 else { throw SidecarProtocolError.catalogRejected(response.statusCode) }
        return try JSONDecoder().decode(NotesCatalog.self, from: data)
    }

    func synchronizeReplica(ready: SidecarReadyMessage, token: String, input: ReplicaSyncRequest) async throws -> ReplicaSyncResult {
        let (data, response) = try await request(path: "local/v1/replica/sync", ready: ready, token: token,
            timeout: 300, method: "POST", body: try JSONEncoder().encode(input))
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(ReplicaSyncResult.self, from: data)
    }

    func replicaStatus(ready: SidecarReadyMessage, token: String) async throws -> ReplicaSyncResult {
        let (data, response) = try await request(path: "local/v1/replica/status", ready: ready, token: token)
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(ReplicaSyncResult.self, from: data)
    }

    func replicaConflicts(ready: SidecarReadyMessage, token: String) async throws -> [ReplicaConflictEntry] {
        let (data, response) = try await request(path: "local/v1/replica/conflicts", ready: ready, token: token)
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(ReplicaConflictResponse.self, from: data).conflicts
    }

    func resolveReplica(ready: SidecarReadyMessage, token: String, input: ReplicaResolveRequest) async throws {
        let (data, response) = try await request(path: "local/v1/replica/resolve", ready: ready, token: token,
            method: "POST", body: try JSONEncoder().encode(input))
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
    }

    func replicaCatalogConflicts(ready: SidecarReadyMessage, token: String) async throws -> [ReplicaCatalogConflict] {
        let (data, response) = try await request(path: "local/v1/replica/conflicts", ready: ready, token: token)
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(ReplicaConflictResponse.self, from: data).catalogConflicts ?? []
    }

    func resolveReplicaCatalog(ready: SidecarReadyMessage, token: String, operationId: String) async throws -> ReplicaCatalogResolutionResult {
        let (data, response) = try await request(path: "local/v1/replica/resolve", ready: ready, token: token,
            timeout: 300, method: "POST", body: try JSONEncoder().encode(ReplicaCatalogResolveRequest(catalogOperationId: operationId)))
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(ReplicaCatalogResolutionResult.self, from: data)
    }

    func manageWorkspace(ready: SidecarReadyMessage, token: String, input: WorkspaceManageRequest) async throws {
        let (data, response) = try await request(
            path: "local/v1/workspace/manage", ready: ready, token: token,
            timeout: 300, method: "POST", body: try JSONEncoder().encode(input)
        )
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
    }

    func workspaceTrash(ready: SidecarReadyMessage, token: String) async throws -> [WorkspaceTrashEntry] {
        let (data, response) = try await request(path: "local/v1/workspace/trash", ready: ready, token: token)
        guard response.statusCode == 200 else { throw workspaceError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(WorkspaceTrashResponse.self, from: data).entries
    }

    func createNotebook(
        ready: SidecarReadyMessage,
        token: String,
        title: String
    ) async throws -> CreatedNotebook {
        let body = try JSONEncoder().encode(CreateNotebookRequest(title: title))
        let (data, response) = try await request(
            path: "local/v1/notebooks",
            ready: ready,
            token: token,
            timeout: 300,
            method: "POST",
            body: body
        )
        guard response.statusCode == 201 else {
            throw workspaceError(data: data, status: response.statusCode)
        }
        return try JSONDecoder().decode(CreateNotebookResponse.self, from: data).notebook
    }

    func createSession(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        title: String
    ) async throws -> SessionCatalogItem {
        let body = try JSONEncoder().encode(CreateSessionRequest(notebookId: notebookId, title: title))
        let (data, response) = try await request(
            path: "local/v1/sessions",
            ready: ready,
            token: token,
            timeout: 300,
            method: "POST",
            body: body
        )
        guard response.statusCode == 201 else {
            throw workspaceError(data: data, status: response.statusCode)
        }
        return try JSONDecoder().decode(CreateSessionResponse.self, from: data).session
    }

    func createNotesBackup(
        ready: SidecarReadyMessage,
        token: String,
        destinationParentDir: String
    ) async throws -> NotesBackupResult {
        let body = try JSONEncoder().encode(NotesBackupRequest(destinationParentDir: destinationParentDir))
        let (data, response) = try await request(
            path: "local/v1/notes/backup",
            ready: ready,
            token: token,
            timeout: 120,
            method: "POST",
            body: body
        )
        guard response.statusCode == 201 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            let message: String
            switch payload?.error {
            case "backup_unavailable": message = "笔记备份服务尚未准备好，请稍后重试。"
            case "invalid_backup_body": message = "请选择一个有效的备份文件夹。"
            case let error? where error.contains("不能位于当前笔记目录内部"):
                message = "备份位置不能放在当前笔记目录里面，请选择其他文件夹。"
            case let error? where error.contains("符号链接"):
                message = "笔记中包含不安全的文件链接，备份已停止。"
            default: message = "备份没有完成，请检查所选文件夹后重试。"
            }
            throw NSError(
                domain: "MathNotes.NotesBackup",
                code: response.statusCode,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        }
        return try JSONDecoder().decode(NotesBackupResponse.self, from: data).backup
    }

    func providerStatus(ready: SidecarReadyMessage, token: String, purpose: ProviderPurpose = .recognition) async throws -> RuntimeProviderStatus {
        let (data, response) = try await request(
            path: "local/v1/provider",
            queryItems: [URLQueryItem(name: "purpose", value: purpose.rawValue)],
            ready: ready,
            token: token
        )
        guard response.statusCode == 200 else { throw providerError(data: data, status: response.statusCode, purpose: purpose) }
        return try JSONDecoder().decode(RuntimeProviderStatus.self, from: data)
    }

    func configureProvider(
        ready: SidecarReadyMessage,
        token: String,
        providerId: String,
        model: String,
        endpoint: String,
        apiKey: String,
        purpose: ProviderPurpose = .recognition
    ) async throws -> RuntimeProviderStatus {
        let body = try JSONEncoder().encode(ConfigureProviderRequest(
            providerId: providerId, model: model, baseUrl: endpoint, apiKey: apiKey
        ))
        let (data, response) = try await request(
            path: "local/v1/provider",
            queryItems: [URLQueryItem(name: "purpose", value: purpose.rawValue)],
            ready: ready, token: token,
            method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw providerError(data: data, status: response.statusCode, purpose: purpose) }
        return try JSONDecoder().decode(RuntimeProviderStatus.self, from: data)
    }

    func clearProvider(ready: SidecarReadyMessage, token: String, purpose: ProviderPurpose = .recognition) async throws -> RuntimeProviderStatus {
        let (data, response) = try await request(
            path: "local/v1/provider/clear",
            queryItems: [URLQueryItem(name: "purpose", value: purpose.rawValue)],
            ready: ready, token: token, method: "POST"
        )
        guard response.statusCode == 200 else { throw providerError(data: data, status: response.statusCode, purpose: purpose) }
        return try JSONDecoder().decode(RuntimeProviderStatus.self, from: data)
    }

    func testProvider(
        ready: SidecarReadyMessage,
        token: String,
        purpose: ProviderPurpose = .recognition
    ) async throws -> ProviderConnectionTestResult {
        let (data, response) = try await request(
            path: "local/v1/provider/test",
            queryItems: [URLQueryItem(name: "purpose", value: purpose.rawValue)],
            ready: ready,
            token: token,
            timeout: 15,
            method: "POST"
        )
        guard response.statusCode == 200 else { throw providerError(data: data, status: response.statusCode, purpose: purpose) }
        return try JSONDecoder().decode(ProviderConnectionTestResult.self, from: data)
    }

    func promptTemplates(ready: SidecarReadyMessage, token: String) async throws -> MacPromptTemplateConfig {
        let (data, response) = try await request(path: "local/v1/ai/prompt-templates", ready: ready, token: token)
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(MacPromptTemplateConfig.self, from: data)
    }

    func savePromptTemplates(
        ready: SidecarReadyMessage,
        token: String,
        config: MacPromptTemplateConfig
    ) async throws -> MacPromptTemplateConfig {
        let (data, response) = try await request(
            path: "local/v1/ai/prompt-templates",
            ready: ready,
            token: token,
            method: "POST",
            body: try JSONEncoder().encode(config)
        )
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(MacPromptTemplateConfig.self, from: data)
    }

    func notationProfiles(ready: SidecarReadyMessage, token: String) async throws -> MacNotationProfileConfig {
        let (data, response) = try await request(path: "local/v1/ai/notation-profiles", ready: ready, token: token)
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(MacNotationProfileConfig.self, from: data)
    }

    func saveNotationProfiles(
        ready: SidecarReadyMessage,
        token: String,
        config: MacNotationProfileConfig
    ) async throws -> MacNotationProfileConfig {
        let (data, response) = try await request(
            path: "local/v1/ai/notation-profiles",
            ready: ready,
            token: token,
            method: "POST",
            body: try JSONEncoder().encode(config)
        )
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(MacNotationProfileConfig.self, from: data)
    }

    func previewNotation(
        ready: SidecarReadyMessage,
        token: String,
        request input: MacNotationPreviewRequest
    ) async throws -> MacNotationPromptPreview {
        let (data, response) = try await request(
            path: "local/v1/ai/notation-preview",
            ready: ready,
            token: token,
            method: "POST",
            body: try JSONEncoder().encode(input)
        )
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(MacNotationPromptPreview.self, from: data)
    }

    func sessionManifest(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String
    ) async throws -> ReadonlySessionManifest {
        let (data, response) = try await request(
            path: "local/v1/session/manifest",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token
        )
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(ReadonlySessionManifest.self, from: data)
    }

    func sessionBlock(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String
    ) async throws -> ReadonlySessionBlock {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "blockId", value: blockId))
        let (data, response) = try await request(
            path: "local/v1/session/block",
            queryItems: query,
            ready: ready,
            token: token
        )
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(ReadonlySessionBlock.self, from: data)
    }

    func previewMarkdown(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String,
        markdown: String
    ) async throws -> MarkdownPreviewResponse {
        let body = try JSONEncoder().encode(MarkdownPreviewRequest(blockId: blockId, markdown: markdown))
        let (data, response) = try await request(
            path: "local/v1/session/markdown/preview",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 10,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            throw SidecarProtocolError.sessionRejected(response.statusCode)
        }
        return try JSONDecoder().decode(MarkdownPreviewResponse.self, from: data)
    }

    func previewStandaloneMarkdown(
        ready: SidecarReadyMessage,
        token: String,
        markdown: String
    ) async throws -> MarkdownPreviewResponse {
        let body = try JSONEncoder().encode(StandaloneMarkdownRequest(markdown: markdown))
        let (data, response) = try await request(
            path: "local/v1/markdown/preview", ready: ready, token: token,
            timeout: 10, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(MarkdownPreviewResponse.self, from: data)
    }

    func appendMarkdown(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        markdown: String,
        sourceName: String,
        insertAfterBlockId: String? = nil
    ) async throws -> ReadonlySessionBlock {
        let body = try JSONEncoder().encode(AppendMarkdownRequest(
            markdown: markdown,
            sourceName: sourceName,
            insertAfterBlockId: insertAfterBlockId
        ))
        let (data, response) = try await request(
            path: "local/v1/session/markdown",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 10, method: "POST", body: body
        )
        guard response.statusCode == 201 else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return try JSONDecoder().decode(ReadonlySessionBlock.self, from: data)
    }

    func proposeSelectionEdit(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String,
        selection: SelectionEditTextRange,
        selectedText: String,
        instruction: String
    ) async throws -> SelectionEditProposal {
        let body = try JSONEncoder().encode(ProposeSelectionEditRequest(
            blockId: blockId,
            from: selection.from,
            to: selection.to,
            selectedText: selectedText,
            instruction: instruction
        ))
        let (data, response) = try await request(
            path: "local/v1/session/selection-edit",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 120, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw selectionEditError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SelectionEditProposal.self, from: data)
    }

    func applySelectionEdit(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        proposalId: String,
        replacementMarkdown: String? = nil,
        retryAfterUnlock: Bool = false
    ) async throws -> ApplySelectionEditResponse {
        let body = try JSONEncoder().encode(SelectionEditCommandRequest(
            proposalId: proposalId,
            replacementMarkdown: replacementMarkdown,
            retryAfterUnlock: retryAfterUnlock ? true : nil
        ))
        let (data, response) = try await request(
            path: "local/v1/session/selection-edit/apply",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 15, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw selectionEditError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(ApplySelectionEditResponse.self, from: data)
    }

    func cancelSelectionEdit(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        proposalId: String
    ) async throws -> SelectionEditProposal {
        let body = try JSONEncoder().encode(SelectionEditCommandRequest(
            proposalId: proposalId,
            replacementMarkdown: nil,
            retryAfterUnlock: nil
        ))
        let (data, response) = try await request(
            path: "local/v1/session/selection-edit/cancel",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 10, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw selectionEditError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SelectionEditProposal.self, from: data)
    }

    func sessionAsset(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        path: String
    ) async throws -> Data {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "path", value: path))
        let (data, response) = try await request(
            path: "local/v1/session/asset",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 20
        )
        guard response.statusCode == 200 else { throw SidecarProtocolError.assetRejected(response.statusCode) }
        return data
    }

    func saveMarkdownBlock(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String,
        markdown: String,
        baseRevision: String
    ) async throws -> ReadonlySessionBlock {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "blockId", value: blockId))
        let body = try JSONEncoder().encode(SaveMarkdownBlockRequest(markdown: markdown, baseRevision: baseRevision))
        let (data, response) = try await request(
            path: "local/v1/session/block",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 10,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            throw SidecarProtocolError.saveRejected(response.statusCode, payload?.error ?? "unknown", payload?.conflictId)
        }
        let result = try JSONDecoder().decode(SaveMarkdownBlockResponse.self, from: data)
        guard result.saved else { throw SidecarProtocolError.saveRejected(response.statusCode, "not_saved", nil) }
        return result.block
    }

    func setMarkdownBlockLock(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String,
        locked: Bool
    ) async throws -> ReadonlySessionBlock {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "blockId", value: blockId))
        let body = try JSONEncoder().encode(SetMarkdownBlockLockRequest(locked: locked))
        let (data, response) = try await request(
            path: "local/v1/session/block/lock",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 10,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            throw SidecarProtocolError.saveRejected(response.statusCode, payload?.error ?? "unknown", nil)
        }
        return try JSONDecoder().decode(SetMarkdownBlockLockResponse.self, from: data).block
    }

    func sessionRewrites(ready: SidecarReadyMessage, token: String, notebookId: String, sessionId: String) async throws -> [SessionRewriteProposal] {
        let (data, response) = try await request(path: "local/v1/session/rewrite",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId), ready: ready, token: token)
        guard response.statusCode == 200 else { throw SidecarProtocolError.unhealthyResponse }
        return try JSONDecoder().decode(SessionRewriteList.self, from: data).proposals
    }

    func sessionRewrite(ready: SidecarReadyMessage, token: String, notebookId: String, sessionId: String,
                        action: String, input: SessionRewriteRequest) async throws -> SessionRewriteProposal {
        let (data, response) = try await request(path: "local/v1/session/rewrite/\(action)",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId), ready: ready, token: token,
            timeout: action == "propose" ? 300 : 15, method: "POST", body: try JSONEncoder().encode(input))
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            throw SidecarProtocolError.saveRejected(response.statusCode, payload?.error ?? "unknown", nil)
        }
        return try JSONDecoder().decode(SessionRewriteProposal.self, from: data)
    }

    func splitLockedSelection(
        ready: SidecarReadyMessage, token: String, notebookId: String, sessionId: String,
        blockId: String, baseRevision: String, selection: SelectionEditTextRange
    ) async throws -> SplitLockedSelectionResponse {
        let body = try JSONEncoder().encode(UpdateMarkdownProtectedSpanRequest(
            baseRevision: baseRevision, from: selection.from, to: selection.to, selectedText: selection.selectedText))
        let (data, response) = try await request(path: "local/v1/session/block/split-lock",
            queryItems: [URLQueryItem(name: "notebookId", value: notebookId), URLQueryItem(name: "sessionId", value: sessionId),
                         URLQueryItem(name: "blockId", value: blockId)], ready: ready, token: token, timeout: 10,
            method: "POST", body: body)
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            throw SidecarProtocolError.saveRejected(response.statusCode, payload?.error ?? "unknown", nil)
        }
        return try JSONDecoder().decode(SplitLockedSelectionResponse.self, from: data)
    }

    func protectMarkdownSelection(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String,
        baseRevision: String,
        selection: SelectionEditTextRange
    ) async throws -> UpdateMarkdownProtectedSpanResponse {
        try await updateMarkdownProtectedSpan(
            action: "protect",
            ready: ready,
            token: token,
            notebookId: notebookId,
            sessionId: sessionId,
            blockId: blockId,
            baseRevision: baseRevision,
            selection: selection
        )
    }

    func unlockMarkdownProtectedSelection(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String,
        baseRevision: String,
        selection: SelectionEditTextRange
    ) async throws -> UpdateMarkdownProtectedSpanResponse {
        try await updateMarkdownProtectedSpan(
            action: "unlock",
            ready: ready,
            token: token,
            notebookId: notebookId,
            sessionId: sessionId,
            blockId: blockId,
            baseRevision: baseRevision,
            selection: selection
        )
    }

    private func updateMarkdownProtectedSpan(
        action: String,
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockId: String,
        baseRevision: String,
        selection: SelectionEditTextRange
    ) async throws -> UpdateMarkdownProtectedSpanResponse {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "blockId", value: blockId))
        let body = try JSONEncoder().encode(UpdateMarkdownProtectedSpanRequest(
            baseRevision: baseRevision,
            from: selection.from,
            to: selection.to,
            selectedText: selection.selectedText
        ))
        let (data, response) = try await request(
            path: "local/v1/session/block/span/\(action)",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 10,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            throw SidecarProtocolError.saveRejected(response.statusCode, payload?.error ?? "unknown", nil)
        }
        return try JSONDecoder().decode(UpdateMarkdownProtectedSpanResponse.self, from: data)
    }

    func reorderSessionBlocks(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockIds: [String],
        direction: String
    ) async throws -> ReadonlySessionManifest {
        let body = try JSONEncoder().encode(ReorderSessionBlocksRequest(
            blockIds: blockIds,
            direction: direction
        ))
        let (data, response) = try await request(
            path: "local/v1/session/blocks/reorder",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 10,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            throw organizeError(data: data, status: response.statusCode)
        }
        let result = try JSONDecoder().decode(ReorderSessionBlocksResponse.self, from: data)
        guard result.reordered else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return result.manifest
    }

    func transferSessionBlocks(
        ready: SidecarReadyMessage,
        token: String,
        sourceNotebookId: String,
        sourceSessionId: String,
        targetNotebookId: String,
        targetSessionId: String,
        blockIds: [String],
        mode: String
    ) async throws -> TransferSessionBlocksResponse {
        let body = try JSONEncoder().encode(TransferSessionBlocksRequest(
            targetNotebookId: targetNotebookId,
            targetSessionId: targetSessionId,
            blockIds: blockIds,
            mode: mode
        ))
        let (data, response) = try await request(
            path: "local/v1/session/blocks/transfer",
            queryItems: sessionQuery(notebookId: sourceNotebookId, sessionId: sourceSessionId),
            ready: ready,
            token: token,
            timeout: 30,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            throw organizeError(data: data, status: response.statusCode)
        }
        return try JSONDecoder().decode(TransferSessionBlocksResponse.self, from: data)
    }

    func deleteSessionBlocks(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        blockIds: [String],
        baseRevision: String
    ) async throws -> DeleteSessionBlocksResponse {
        let body = try JSONEncoder().encode(DeleteSessionBlocksRequest(
            blockIds: blockIds,
            baseRevision: baseRevision
        ))
        let (data, response) = try await request(
            path: "local/v1/session/blocks/delete",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 10,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            throw organizeError(data: data, status: response.statusCode)
        }
        let result = try JSONDecoder().decode(DeleteSessionBlocksResponse.self, from: data)
        guard result.deleted else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return result
    }

    func restoreSessionBlocks(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        deletionId: String,
        baseRevision: String
    ) async throws -> RestoreSessionBlocksResponse {
        let body = try JSONEncoder().encode(RestoreSessionBlocksRequest(
            deletionId: deletionId,
            baseRevision: baseRevision
        ))
        let (data, response) = try await request(
            path: "local/v1/session/blocks/restore",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 10,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200 else {
            throw organizeError(data: data, status: response.statusCode)
        }
        let result = try JSONDecoder().decode(RestoreSessionBlocksResponse.self, from: data)
        guard result.restored else { throw SidecarProtocolError.sessionRejected(response.statusCode) }
        return result
    }

    func sessionConflict(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        conflictId: String
    ) async throws -> SessionMarkdownConflict {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "conflictId", value: conflictId))
        let (data, response) = try await request(
            path: "local/v1/session/conflict", queryItems: query, ready: ready, token: token
        )
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            throw SidecarProtocolError.saveRejected(response.statusCode, payload?.error ?? "unknown", nil)
        }
        return try JSONDecoder().decode(SessionMarkdownConflict.self, from: data)
    }

    func resolveSessionConflict(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        conflictId: String,
        resolution: String,
        baseRevision: String,
        markdown: String?
    ) async throws -> ResolveMarkdownConflictResponse {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "conflictId", value: conflictId))
        let body = try JSONEncoder().encode(ResolveConflictRequest(
            resolution: resolution, baseRevision: baseRevision, markdown: markdown
        ))
        let (data, response) = try await request(
            path: "local/v1/session/conflict/resolve", queryItems: query,
            ready: ready, token: token, timeout: 10, method: "POST", body: body
        )
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data)
            throw SidecarProtocolError.saveRejected(response.statusCode, payload?.error ?? "unknown", payload?.conflictId)
        }
        return try JSONDecoder().decode(ResolveMarkdownConflictResponse.self, from: data)
    }

    func importSessionImage(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        fileName: String,
        bytes: Data,
        baseRevision: String
    ) async throws -> ImportSessionImageResponse {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "fileName", value: fileName))
        query.append(URLQueryItem(name: "baseRevision", value: baseRevision))
        let (data, response) = try await request(
            path: "local/v1/session/image",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 30,
            method: "POST",
            body: bytes,
            contentType: "application/octet-stream"
        )
        guard response.statusCode == 200 else {
            let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
            throw SidecarProtocolError.imageImportRejected(response.statusCode, code)
        }
        let result = try JSONDecoder().decode(ImportSessionImageResponse.self, from: data)
        guard result.imported else {
            throw SidecarProtocolError.imageImportRejected(response.statusCode, "not_imported")
        }
        return result
    }

    func importSessionEditedImage(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        fileName: String,
        sourceBytes: Data,
        outputPngBytes: Data,
        baseRevision: String,
        operations: [MacImageTransformOperation],
        annotations: [MacImageAnnotationObject]
    ) async throws -> ImportSessionEditedImageResponse {
        let maximumImageBytes = 25 * 1024 * 1024
        guard !sourceBytes.isEmpty, !outputPngBytes.isEmpty,
              sourceBytes.count <= maximumImageBytes, outputPngBytes.count <= maximumImageBytes else {
            throw SidecarProtocolError.imageEditRejected(413, "image_too_large")
        }
        let multipart = try imageEditMultipartBody(
            fileName: fileName,
            sourceBytes: sourceBytes,
            outputPngBytes: outputPngBytes,
            baseRevision: baseRevision,
            metadata: MacImageEditMetadata(operations: operations, annotations: annotations)
        )
        let (data, response) = try await request(
            path: "local/v1/session/image/edit",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 60,
            method: "POST",
            body: multipart.body,
            contentType: "multipart/form-data; boundary=\(multipart.boundary)"
        )
        guard response.statusCode == 200 else {
            let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
            throw SidecarProtocolError.imageEditRejected(response.statusCode, code)
        }
        let result = try JSONDecoder().decode(ImportSessionEditedImageResponse.self, from: data)
        guard result.imported, result.edited else {
            throw SidecarProtocolError.imageEditRejected(response.statusCode, "not_imported")
        }
        return result
    }

    func stagePdfRecognitionPage(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        pdfBlockId: String,
        pageNumber: Int,
        baseRevision: String,
        bytes: Data
    ) async throws -> StagedPdfRecognitionPage {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "pdfBlockId", value: pdfBlockId))
        query.append(URLQueryItem(name: "pageNumber", value: String(pageNumber)))
        query.append(URLQueryItem(name: "baseRevision", value: baseRevision))
        let (data, response) = try await request(
            path: "local/v1/session/pdf-recognition/page",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 60,
            method: "POST",
            body: bytes,
            contentType: "image/png"
        )
        guard response.statusCode == 201 else { throw pdfRecognitionError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(PdfRecognitionPageResponse.self, from: data).page
    }

    func startPdfRecognitionBatch(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        pdfBlockId: String,
        pdfAssetPath: String,
        pageCount: Int,
        concurrency: Int,
        baseRevision: String,
        pages: [StagedPdfRecognitionPage]
    ) async throws -> PdfRecognitionBatch {
        let body = try JSONEncoder().encode(StartPdfRecognitionBatchRequest(
            pdfBlockId: pdfBlockId,
            pdfAssetPath: pdfAssetPath,
            pageCount: pageCount,
            concurrency: concurrency,
            baseRevision: baseRevision,
            pages: pages.map {
                StartPdfRecognitionBatchRequest.Page(pageNumber: $0.pageNumber, assetPath: $0.assetPath)
            }
        ))
        let (data, response) = try await request(
            path: "local/v1/session/pdf-recognition/start",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 30,
            method: "POST",
            body: body
        )
        guard response.statusCode == 202 else { throw pdfRecognitionError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(PdfRecognitionBatchResponse.self, from: data).batch
    }

    func pdfRecognitionBatches(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String
    ) async throws -> [PdfRecognitionBatch] {
        let (data, response) = try await request(
            path: "local/v1/session/pdf-recognition",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 10
        )
        guard response.statusCode == 200 else { throw pdfRecognitionError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(PdfRecognitionBatchesResponse.self, from: data).batches
    }

    func controlPdfRecognitionBatch(
        _ action: String,
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        batchId: String
    ) async throws -> PdfRecognitionBatch {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "batchId", value: batchId))
        let (data, response) = try await request(
            path: "local/v1/session/pdf-recognition/\(action)",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 15,
            method: "POST"
        )
        guard response.statusCode == 200 else { throw pdfRecognitionError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(PdfRecognitionBatchResponse.self, from: data).batch
    }

    func importSessionPdf(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        fileName: String,
        bytes: Data,
        baseRevision: String,
        pageCount: Int
    ) async throws -> ImportSessionPdfResponse {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "fileName", value: fileName))
        query.append(URLQueryItem(name: "baseRevision", value: baseRevision))
        query.append(URLQueryItem(name: "pageCount", value: String(pageCount)))
        let (data, response) = try await request(
            path: "local/v1/session/pdf",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: 60,
            method: "POST",
            body: bytes,
            contentType: "application/pdf"
        )
        guard response.statusCode == 200 else {
            let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
            throw SidecarProtocolError.pdfImportRejected(response.statusCode, code)
        }
        let result = try JSONDecoder().decode(ImportSessionPdfResponse.self, from: data)
        guard result.imported else {
            throw SidecarProtocolError.pdfImportRejected(response.statusCode, "not_imported")
        }
        return result
    }

    func startRecognition(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        imageBlockId: String
    ) async throws -> SessionRecognitionTask {
        let body = try JSONEncoder().encode(StartRecognitionRequest(imageBlockId: imageBlockId))
        return try await recognitionTaskRequest(
            path: "local/v1/session/recognition",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            method: "POST",
            body: body,
            expectedStatus: 202
        )
    }

    func recognitionTask(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        taskId: String
    ) async throws -> SessionRecognitionTask {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "taskId", value: taskId))
        return try await recognitionTaskRequest(
            path: "local/v1/session/recognition", queryItems: query,
            ready: ready, token: token, method: "GET", expectedStatus: 200
        )
    }

    func recognitionTasks(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String
    ) async throws -> [SessionRecognitionTask] {
        (try await recognitionTaskSnapshot(
            ready: ready,
            token: token,
            notebookId: notebookId,
            sessionId: sessionId
        )).tasks
    }

    func recognitionTaskSnapshot(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        afterActivitySequence: Int? = nil,
        waitMilliseconds: Int = 0
    ) async throws -> SessionRecognitionTasksResponse {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        if let afterActivitySequence {
            query.append(URLQueryItem(name: "afterActivitySequence", value: String(afterActivitySequence)))
            query.append(URLQueryItem(name: "waitMs", value: String(max(0, waitMilliseconds))))
        }
        let (data, response) = try await request(
            path: "local/v1/session/recognition",
            queryItems: query,
            ready: ready,
            token: token,
            timeout: max(5, TimeInterval(waitMilliseconds) / 1_000 + 5)
        )
        guard response.statusCode == 200 else {
            throw recognitionError(data: data, status: response.statusCode)
        }
        return try JSONDecoder().decode(SessionRecognitionTasksResponse.self, from: data)
    }

    func companionUploadActivity(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String
    ) async throws -> SessionCompanionUploadActivity? {
        let (data, response) = try await request(
            path: "local/v1/session/companion-activity",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            timeout: 5
        )
        guard response.statusCode == 200 else {
            throw SidecarProtocolError.sessionRejected(response.statusCode)
        }
        return try JSONDecoder().decode(SessionCompanionUploadActivityResponse.self, from: data).activity
    }

    func recognitionEvents(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        taskId: String,
        afterSequence: Int
    ) async throws -> [SessionRecognitionEvent] {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "taskId", value: taskId))
        query.append(URLQueryItem(name: "afterSequence", value: String(afterSequence)))
        let (data, response) = try await request(
            path: "local/v1/session/recognition/events", queryItems: query,
            ready: ready, token: token, timeout: 5
        )
        guard response.statusCode == 200 else { throw recognitionError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionRecognitionEventsResponse.self, from: data).events
    }

    func cancelRecognition(
        ready: SidecarReadyMessage, token: String, notebookId: String, sessionId: String, taskId: String
    ) async throws -> SessionRecognitionTask {
        try await recognitionCommand(
            "cancel", ready: ready, token: token,
            notebookId: notebookId, sessionId: sessionId, taskId: taskId
        )
    }

    func retryRecognition(
        ready: SidecarReadyMessage, token: String, notebookId: String, sessionId: String, taskId: String
    ) async throws -> SessionRecognitionTask {
        try await recognitionCommand(
            "retry", ready: ready, token: token,
            notebookId: notebookId, sessionId: sessionId, taskId: taskId
        )
    }

    func rerunRecognition(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        transcriptBlockId: String
    ) async throws -> SessionRecognitionTask {
        let body = try JSONEncoder().encode(RerunRecognitionRequest(transcriptBlockId: transcriptBlockId))
        return try await recognitionTaskRequest(
            path: "local/v1/session/recognition/rerun",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready,
            token: token,
            method: "POST",
            body: body,
            expectedStatus: 202
        )
    }

    func previewSessionAssistant(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        input: SessionAssistantRequest
    ) async throws -> SessionAssistantPreview {
        let body = try JSONEncoder().encode(input)
        let (data, response) = try await request(
            path: "local/v1/session/assistant/preview",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 10, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantPreview.self, from: data)
    }

    func runSessionAssistant(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        input: SessionAssistantRequest
    ) async throws -> SessionAssistantRemark {
        let body = try JSONEncoder().encode(input)
        let (data, response) = try await request(
            path: "local/v1/session/assistant",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 180, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantRunResponse.self, from: data).remark
    }

    func startSessionAssistant(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        input: SessionAssistantRequest
    ) async throws -> SessionAssistantTask {
        let body = try JSONEncoder().encode(input)
        let (data, response) = try await request(
            path: "local/v1/session/assistant/start",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 15, method: "POST", body: body
        )
        guard response.statusCode == 202 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantTaskResponse.self, from: data).task
    }

    func sessionAssistantEvents(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        taskId: String,
        afterSequence: Int
    ) async throws -> [SessionAssistantTaskEvent] {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "taskId", value: taskId))
        query.append(URLQueryItem(name: "afterSequence", value: String(afterSequence)))
        let (data, response) = try await request(
            path: "local/v1/session/assistant/events", queryItems: query,
            ready: ready, token: token, timeout: 5
        )
        guard response.statusCode == 200 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantEventsResponse.self, from: data).events
    }

    func cancelSessionAssistant(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        taskId: String
    ) async throws -> SessionAssistantTask {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "taskId", value: taskId))
        let (data, response) = try await request(
            path: "local/v1/session/assistant/cancel", queryItems: query,
            ready: ready, token: token, timeout: 10, method: "POST"
        )
        guard response.statusCode == 200 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantTaskResponse.self, from: data).task
    }

    func listSessionAssistant(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String
    ) async throws -> [SessionAssistantRemark] {
        let (data, response) = try await request(
            path: "local/v1/session/assistant",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 10
        )
        guard response.statusCode == 200 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantRemarksResponse.self, from: data).remarks
    }

    func deleteSessionAssistant(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        remarkId: String
    ) async throws -> Bool {
        let body = try JSONEncoder().encode(SessionAssistantRemarkCommand(remarkId: remarkId))
        let (data, response) = try await request(
            path: "local/v1/session/assistant/delete",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 10, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantDeleteResponse.self, from: data).deleted
    }

    func promoteSessionAssistant(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        remarkId: String
    ) async throws -> SessionAssistantPromoteResponse {
        let body = try JSONEncoder().encode(SessionAssistantRemarkCommand(remarkId: remarkId))
        let (data, response) = try await request(
            path: "local/v1/session/assistant/promote",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 10, method: "POST", body: body
        )
        guard response.statusCode == 200 else { throw assistantError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionAssistantPromoteResponse.self, from: data)
    }

    func createSessionExport(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        baseRevision: String
    ) async throws -> SessionMarkdownExport {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "baseRevision", value: baseRevision))
        let (data, response) = try await request(
            path: "local/v1/session/export", queryItems: query,
            ready: ready, token: token, timeout: 30, method: "POST"
        )
        guard response.statusCode == 200 else { throw exportError(data: data, status: response.statusCode) }
        let result = try JSONDecoder().decode(SessionMarkdownExport.self, from: data)
        guard result.exported else { throw SidecarProtocolError.exportRejected(response.statusCode, "not_exported") }
        return result
    }

    func downloadSessionExport(
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String
    ) async throws -> Data {
        let (data, response) = try await request(
            path: "local/v1/session/export",
            queryItems: sessionQuery(notebookId: notebookId, sessionId: sessionId),
            ready: ready, token: token, timeout: 30
        )
        guard response.statusCode == 200 else { throw exportError(data: data, status: response.statusCode) }
        return data
    }

    private func recognitionCommand(
        _ command: String,
        ready: SidecarReadyMessage,
        token: String,
        notebookId: String,
        sessionId: String,
        taskId: String
    ) async throws -> SessionRecognitionTask {
        var query = sessionQuery(notebookId: notebookId, sessionId: sessionId)
        query.append(URLQueryItem(name: "taskId", value: taskId))
        return try await recognitionTaskRequest(
            path: "local/v1/session/recognition/\(command)", queryItems: query,
            ready: ready, token: token, method: "POST", expectedStatus: 200
        )
    }

    private func recognitionTaskRequest(
        path: String,
        queryItems: [URLQueryItem],
        ready: SidecarReadyMessage,
        token: String,
        method: String,
        body: Data? = nil,
        expectedStatus: Int
    ) async throws -> SessionRecognitionTask {
        let (data, response) = try await request(
            path: path, queryItems: queryItems, ready: ready, token: token,
            timeout: 10, method: method, body: body
        )
        guard response.statusCode == expectedStatus else { throw recognitionError(data: data, status: response.statusCode) }
        return try JSONDecoder().decode(SessionRecognitionTaskResponse.self, from: data).task
    }

    private func recognitionError(data: Data, status: Int) -> SidecarProtocolError {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return .recognitionRejected(status, code)
    }

    private func pdfRecognitionError(data: Data, status: Int) -> SidecarProtocolError {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return .pdfRecognitionRejected(status, code)
    }

    private func exportError(data: Data, status: Int) -> SidecarProtocolError {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return .exportRejected(status, code)
    }

    private func providerError(data: Data, status: Int, purpose: ProviderPurpose) -> SidecarProtocolError {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return .providerRejected(status, code, purpose)
    }

    private func workspaceError(data: Data, status: Int) -> Error {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return NSError(
            domain: "MathNotes.Workspace",
            code: status,
            userInfo: [NSLocalizedDescriptionKey: workspaceMessage(code: code)]
        )
    }

    private func assistantError(data: Data, status: Int) -> SidecarProtocolError {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return .assistantRejected(status, code)
    }

    private func selectionEditError(data: Data, status: Int) -> SidecarProtocolError {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return .selectionEditRejected(status, code)
    }

    private func organizeError(data: Data, status: Int) -> Error {
        let code = (try? JSONDecoder().decode(LocalShellErrorPayload.self, from: data).error) ?? "unknown"
        return SidecarProtocolError.organizeRejected(status, code)
    }

    private func workspaceMessage(code: String) -> String {
        switch code {
        case "invalid_title": return "请输入 1 到 120 个字符的名称。"
        case "notebook_not_found": return "目标 Notebook 已不存在，请刷新目录后重试。"
        case "host_upgrade_required", "not_found", "workspace_sync_unavailable": return "这台主机需要更新 MathNotes，才能同步可编辑的笔记副本。"
        case "host_catalog_upgrade_required", "workspace_catalog_unavailable": return "这台主机需要更新 MathNotes，才能同步新建、改名和废纸篓操作。"
        case "resolve_catalog_conflict_first", "resolve_content_conflict_first": return "这个 Notebook 还有同步冲突。请先在远程同步状态中处理，再继续操作。"
        case "backup_path_conflict", "backup_source_missing": return "恢复备份尚未完成，已停止后续操作并保留现有内容。请检查副本目录后重试。"
        case "catalog_content_changed", "replayed_push_changed_remotely": return "主机内容又发生了变化，两边版本均已保留，请重新处理同步冲突。"
        case "host_identity_changed", "replica_host_mismatch": return "连接地址对应的主机身份已改变，原来的本地副本已保留。请重新添加这台主机。"
        case "revision_conflict": return "两端都有修改，请处理同步冲突。"
        case "connection_unavailable": return "暂时连接不上主机；已保存的本地副本和修改会保留。"
        case "restore_conflict": return "原位置已有笔记，未覆盖任何内容。请先处理同名笔记后再恢复。"
        case "workspace_item_not_found", "item_not_found": return "笔记或所在 Notebook 已不存在。恢复 Session 前，请先恢复它的 Notebook。"
        case "unsafe_path", "invalid_id", "invalid_receipt": return "笔记路径或恢复记录无效，未修改数据。"
        case "workspace_conflict": return "无法分配新的笔记目录，请稍后重试。"
        default: return "新建没有完成，请检查笔记目录权限后重试。"
        }
    }

    private func request(
        path: String,
        queryItems: [URLQueryItem] = [],
        ready: SidecarReadyMessage,
        token: String,
        timeout: TimeInterval = 3,
        method: String = "GET",
        body: Data? = nil,
        contentType: String = "application/json"
    ) async throws -> (Data, HTTPURLResponse) {
        try ready.validate()
        guard let endpoint = ready.endpoint else { throw SidecarProtocolError.nonLoopbackEndpoint }
        let endpointURL = endpoint.appendingPathComponent(path)
        guard var components = URLComponents(url: endpointURL, resolvingAgainstBaseURL: false) else {
            throw SidecarProtocolError.unhealthyResponse
        }
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { throw SidecarProtocolError.unhealthyResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = timeout
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SidecarProtocolError.unhealthyResponse }
        if method == "POST", (200..<300).contains(http.statusCode),
           !path.contains("preview"), !path.contains("replica/"),
           (path.contains("session") || path.contains("workspace/manage") || path == "local/v1/notebooks") {
            NotificationCenter.default.post(name: .mathNotesWorkspaceChanged, object: nil,
                userInfo: ["instanceId": ready.instanceId])
        }
        return (data, http)
    }

    private func imageEditMultipartBody(
        fileName: String,
        sourceBytes: Data,
        outputPngBytes: Data,
        baseRevision: String,
        metadata: MacImageEditMetadata
    ) throws -> (body: Data, boundary: String) {
        let boundary = "MathNotes-ImageEdit-\(UUID().uuidString)"
        var body = Data()
        func append(_ string: String) { body.append(contentsOf: string.utf8) }
        func appendField(_ name: String, _ value: String) {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            append(value)
            append("\r\n")
        }
        func appendFile(_ field: String, _ name: String, _ mimeType: String, _ bytes: Data) {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(name)\"\r\n")
            append("Content-Type: \(mimeType)\r\n\r\n")
            body.append(bytes)
            append("\r\n")
        }

        let safeFileName = fileName
            .replacingOccurrences(of: "\u{0000}", with: "")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        appendField("fileName", String(safeFileName.prefix(240)))
        appendField("baseRevision", baseRevision)
        appendField("metadata", String(decoding: try JSONEncoder().encode(metadata), as: UTF8.self))
        appendFile("source", "source.bin", "application/octet-stream", sourceBytes)
        appendFile("output", "edited.png", "image/png", outputPngBytes)
        append("--\(boundary)--\r\n")
        return (body, boundary)
    }

    private func sessionQuery(notebookId: String, sessionId: String) -> [URLQueryItem] {
        [
            URLQueryItem(name: "notebookId", value: notebookId),
            URLQueryItem(name: "sessionId", value: sessionId)
        ]
    }
}

private struct CreateNotebookRequest: Encodable {
    let title: String
}

private struct CreateSessionRequest: Encodable {
    let notebookId: String
    let title: String
}

private struct SaveMarkdownBlockRequest: Encodable {
    let markdown: String
    let baseRevision: String
}

private struct MarkdownPreviewRequest: Encodable {
    let blockId: String
    let markdown: String
}

private struct StandaloneMarkdownRequest: Encodable { let markdown: String }
private struct AppendMarkdownRequest: Encodable {
    let markdown: String
    let sourceName: String
    let insertAfterBlockId: String?
}

private struct ProposeSelectionEditRequest: Encodable {
    let blockId: String
    let from: Int
    let to: Int
    let selectedText: String
    let instruction: String
}

private struct SelectionEditCommandRequest: Encodable {
    let proposalId: String
    let replacementMarkdown: String?
    let retryAfterUnlock: Bool?
}

private struct NotesBackupRequest: Encodable {
    let destinationParentDir: String
}

private struct NotesBackupResponse: Decodable {
    let version: Int
    let backup: NotesBackupResult
}

private struct ReorderSessionBlocksRequest: Encodable {
    let blockIds: [String]
    let direction: String
}

private struct DeleteSessionBlocksRequest: Encodable {
    let blockIds: [String]
    let baseRevision: String
}

private struct RestoreSessionBlocksRequest: Encodable {
    let deletionId: String
    let baseRevision: String
}

private struct TransferSessionBlocksRequest: Encodable {
    let targetNotebookId: String
    let targetSessionId: String
    let blockIds: [String]
    let mode: String
}

private struct ResolveConflictRequest: Encodable {
    let resolution: String
    let baseRevision: String
    let markdown: String?
}

private struct StartRecognitionRequest: Encodable {
    let imageBlockId: String
}

private struct StartPdfRecognitionBatchRequest: Encodable {
    struct Page: Encodable {
        let pageNumber: Int
        let assetPath: String
    }

    let pdfBlockId: String
    let pdfAssetPath: String
    let pageCount: Int
    let concurrency: Int
    let baseRevision: String
    let pages: [Page]
}

private struct PdfRecognitionPageResponse: Decodable {
    let version: Int
    let page: StagedPdfRecognitionPage
}

private struct PdfRecognitionBatchResponse: Decodable {
    let version: Int
    let batch: PdfRecognitionBatch
}

private struct PdfRecognitionBatchesResponse: Decodable {
    let version: Int
    let batches: [PdfRecognitionBatch]
}

private struct RerunRecognitionRequest: Encodable {
    let transcriptBlockId: String
}

struct SessionAssistantRequest: Encodable, Equatable, Sendable {
    let scope: String
    let activeBlockId: String?
    let selectedText: String?
    let focusLabel: String?
    let question: String?
    let mode: String?
}

private struct SessionAssistantRemarkCommand: Encodable {
    let remarkId: String
}

private struct ConfigureProviderRequest: Encodable {
    let providerId: String
    let model: String
    let baseUrl: String
    let apiKey: String
}

private struct CompanionPairingChallengeResponse: Decodable {
    let version: Int
    let challenge: CompanionPairingChallenge
}

private struct LocalShellErrorPayload: Decodable {
    let error: String
    let conflictId: String?
}

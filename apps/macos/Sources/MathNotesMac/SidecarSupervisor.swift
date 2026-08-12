import Combine
import Foundation

@MainActor
final class SidecarSupervisor: ObservableObject {
    @Published private(set) var state: SidecarState = .idle
    @Published private(set) var catalogState: CatalogState = .idle
    @Published private(set) var providerStatus: RuntimeProviderStatus = .unconfigured
    @Published private(set) var assistantProviderStatus: RuntimeProviderStatus = .unconfigured
    @Published private(set) var providerRestorationError: ProviderRestorationError?
    @Published private(set) var assistantProviderRestorationError: ProviderRestorationError?
    @Published private(set) var companionHost: SidecarCompanionHost?
    @Published private(set) var companionHostToken: String?
    @Published private(set) var companionPairingChallenge: CompanionPairingChallenge?
    @Published private(set) var companionPublicOrigin =
        CompanionHostAddressPreferences.load()?.origin
    @Published private(set) var tailscaleServeState: TailscaleServeState = .idle

    private var process: Process?
    private var launchTask: Task<Void, Never>?
    private var companionServeTask: Task<Void, Never>?
    private let client = LocalShellClient()
    private var activeReady: SidecarReadyMessage?
    private var activeToken: String?
    private var notesRootAccessURL: URL?

    func startIfNeeded() {
        guard state == .idle else { return }
        start()
    }

    func start() {
        stop()
        state = .starting
        let notesRootURL = DirectoryBookmarkStore.resolvedURL(for: .notesRoot)
        if let notesRootURL, notesRootURL.startAccessingSecurityScopedResource() {
            notesRootAccessURL = notesRootURL
        }
        launchTask = Task { [weak self] in
            guard let self else { return }
            do {
                let configuration = try SidecarConfiguration.development(notesRootURL: notesRootURL)
                let ready = try await self.launch(configuration)
                _ = try await self.client.health(ready: ready, token: configuration.token)
                self.activeReady = ready
                self.activeToken = configuration.token
                self.companionHost = ready.companionHost
                self.companionHostToken = configuration.companionHostToken
                self.state = .ready(
                    instanceId: ready.instanceId,
                    endpoint: ready.endpoint?.absoluteString ?? ""
                )
                self.reconcileCompanionServe()
                await self.restoreProviderConfiguration(ready: ready, token: configuration.token)
                await self.loadCatalog(ready: ready, token: configuration.token)
            } catch is CancellationError {
                self.state = .idle
            } catch {
                self.process?.terminate()
                self.process = nil
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    func retry() {
        guard case .failed = state else { return }
        start()
    }

    func updateCompanionHostToken(_ token: String, confirmation: String) async throws {
        let normalized = try CompanionHostTokenPolicy.validate(token, confirmation: confirmation)
        let store = KeychainCredentialStore(service: CompanionHostCredential.service)
        let previous = try await Task.detached {
            try store.read(account: CompanionHostCredential.account)
        }.value
        if previous == normalized { return }
        try await Task.detached {
            try store.write(normalized, account: CompanionHostCredential.account)
        }.value
        start()
        do {
            try await waitUntilReady()
        } catch {
            try? await Task.detached {
                if let previous {
                    try store.write(previous, account: CompanionHostCredential.account)
                } else {
                    try store.delete(account: CompanionHostCredential.account)
                }
            }.value
            start()
            _ = try? await waitUntilReady()
            throw error
        }
    }

    func applyNotesRoot(_ url: URL?) async throws {
        let previous = DirectoryBookmarkStore.snapshot(.notesRoot)
        do {
            if let url { try DirectoryBookmarkStore.save(url, for: .notesRoot) }
            else { DirectoryBookmarkStore.clear(.notesRoot) }
            start()
            try await waitUntilReady()
        } catch {
            DirectoryBookmarkStore.restore(previous, for: .notesRoot)
            start()
            _ = try? await waitUntilReady()
            throw error
        }
    }

    func reloadCatalog() {
        guard let ready = activeReady, let token = activeToken else { return }
        launchTask = Task { [weak self] in
            await self?.loadCatalog(ready: ready, token: token)
        }
    }

    func createNotebook(title: String) async throws -> CreatedNotebook {
        let connection = try activeConnection()
        let notebook = try await client.createNotebook(
            ready: connection.ready,
            token: connection.token,
            title: title
        )
        await loadCatalog(ready: connection.ready, token: connection.token)
        return notebook
    }

    func createSession(notebookId: String, title: String) async throws -> SessionCatalogItem {
        let connection = try activeConnection()
        let session = try await client.createSession(
            ready: connection.ready,
            token: connection.token,
            notebookId: notebookId,
            title: title
        )
        await loadCatalog(ready: connection.ready, token: connection.token)
        return session
    }

    func hasSavedProviderKey(_ preset: ProviderPreset, purpose: ProviderPurpose = .recognition) async -> Bool {
        let store = KeychainCredentialStore()
        return await Task.detached {
            let scoped = try? store.read(account: purpose.keychainAccount(for: preset))
            if scoped?.isEmpty == false { return true }
            return purpose == .recognition && (try? store.read(account: preset.rawValue))?.isEmpty == false
        }.value
    }

    func configureProvider(
        preset: ProviderPreset,
        model: String,
        endpoint: String,
        newAPIKey: String,
        purpose: ProviderPurpose = .recognition
    ) async throws {
        let connection = try activeConnection()
        let trimmedKey = newAPIKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let store = KeychainCredentialStore()
        let apiKey: String
        if trimmedKey.isEmpty {
            guard let saved = try await Task.detached(operation: {
                let scoped = try store.read(account: purpose.keychainAccount(for: preset))
                if scoped?.isEmpty == false { return scoped }
                return purpose == .recognition ? try store.read(account: preset.rawValue) : nil
            }).value, !saved.isEmpty else { throw ProviderSettingsError.missingAPIKey }
            apiKey = saved
        } else {
            apiKey = trimmedKey
        }

        let status = try await client.configureProvider(
            ready: connection.ready,
            token: connection.token,
            providerId: preset.rawValue,
            model: model,
            endpoint: endpoint,
            apiKey: apiKey,
            purpose: purpose
        )
        if !trimmedKey.isEmpty {
            try await Task.detached(operation: {
                try store.write(trimmedKey, account: purpose.keychainAccount(for: preset))
            }).value
        }
        try ProviderPreferences.save(ProviderPreferenceRecord(
            providerId: preset,
            model: model.trimmingCharacters(in: .whitespacesAndNewlines),
            endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        ), purpose: purpose)
        if purpose == .recognition {
            providerStatus = status
            providerRestorationError = nil
        } else {
            assistantProviderStatus = status
            assistantProviderRestorationError = nil
        }
    }

    func clearProviderConfiguration(_ purpose: ProviderPurpose = .recognition) async throws {
        let connection = try activeConnection()
        let status = try await client.clearProvider(ready: connection.ready, token: connection.token, purpose: purpose)
        if let record = ProviderPreferences.load(purpose) {
            let store = KeychainCredentialStore()
            try await Task.detached(operation: {
                try store.delete(account: purpose.keychainAccount(for: record.providerId))
                if purpose == .recognition { try store.delete(account: record.providerId.rawValue) }
            }).value
        }
        ProviderPreferences.clear(purpose)
        if purpose == .recognition {
            providerStatus = status
            providerRestorationError = nil
        } else {
            assistantProviderStatus = status
            assistantProviderRestorationError = nil
        }
    }

    func testProviderConnection(purpose: ProviderPurpose = .recognition) async throws -> ProviderConnectionTestResult {
        let connection = try activeConnection()
        return try await client.testProvider(
            ready: connection.ready,
            token: connection.token,
            purpose: purpose
        )
    }

    func loadPromptTemplates() async throws -> MacPromptTemplateConfig {
        let connection = try activeConnection()
        return try await client.promptTemplates(ready: connection.ready, token: connection.token)
    }

    func savePromptTemplates(_ config: MacPromptTemplateConfig) async throws -> MacPromptTemplateConfig {
        let connection = try activeConnection()
        return try await client.savePromptTemplates(ready: connection.ready, token: connection.token, config: config)
    }

    func loadNotationProfiles() async throws -> MacNotationProfileConfig {
        let connection = try activeConnection()
        return try await client.notationProfiles(ready: connection.ready, token: connection.token)
    }

    func saveNotationProfiles(_ config: MacNotationProfileConfig) async throws -> MacNotationProfileConfig {
        let connection = try activeConnection()
        return try await client.saveNotationProfiles(ready: connection.ready, token: connection.token, config: config)
    }

    func previewNotation(_ input: MacNotationPreviewRequest) async throws -> MacNotationPromptPreview {
        let connection = try activeConnection()
        return try await client.previewNotation(ready: connection.ready, token: connection.token, request: input)
    }

    func fetchSessionManifest(_ session: SessionCatalogItem) async throws -> ReadonlySessionManifest {
        let connection = try activeConnection()
        return try await client.sessionManifest(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId
        )
    }

    func fetchSessionBlock(_ session: SessionCatalogItem, blockId: String) async throws -> ReadonlySessionBlock {
        let connection = try activeConnection()
        return try await client.sessionBlock(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            blockId: blockId
        )
    }

    func fetchSessionAsset(_ session: SessionCatalogItem, path: String) async throws -> Data {
        let connection = try activeConnection()
        return try await client.sessionAsset(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            path: path
        )
    }

    func saveMarkdownBlock(
        _ session: SessionCatalogItem,
        blockId: String,
        markdown: String,
        baseRevision: String
    ) async throws -> ReadonlySessionBlock {
        let connection = try activeConnection()
        return try await client.saveMarkdownBlock(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            blockId: blockId,
            markdown: markdown,
            baseRevision: baseRevision
        )
    }

    func fetchMarkdownConflict(
        _ session: SessionCatalogItem,
        conflictId: String
    ) async throws -> SessionMarkdownConflict {
        let connection = try activeConnection()
        return try await client.sessionConflict(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, conflictId: conflictId
        )
    }

    func resolveMarkdownConflict(
        _ session: SessionCatalogItem,
        conflictId: String,
        resolution: String,
        baseRevision: String,
        markdown: String?
    ) async throws -> ResolveMarkdownConflictResponse {
        let connection = try activeConnection()
        return try await client.resolveSessionConflict(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId,
            conflictId: conflictId, resolution: resolution,
            baseRevision: baseRevision, markdown: markdown
        )
    }

    func importSessionImage(
        _ session: SessionCatalogItem,
        fileName: String,
        bytes: Data,
        baseRevision: String
    ) async throws -> ImportSessionImageResponse {
        let connection = try activeConnection()
        return try await client.importSessionImage(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            fileName: fileName,
            bytes: bytes,
            baseRevision: baseRevision
        )
    }

    func previewStandaloneMarkdown(_ markdown: String) async throws -> String {
        let connection = try activeConnection()
        let response = try await client.previewStandaloneMarkdown(
            ready: connection.ready, token: connection.token, markdown: markdown
        )
        return response.html
    }

    func appendMarkdown(
        _ session: SessionCatalogItem,
        markdown: String,
        sourceName: String
    ) async throws -> ReadonlySessionBlock {
        let connection = try activeConnection()
        let block = try await client.appendMarkdown(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId,
            markdown: markdown, sourceName: sourceName
        )
        await loadCatalog(ready: connection.ready, token: connection.token)
        return block
    }

    func setMarkdownBlockLock(
        _ session: SessionCatalogItem,
        blockId: String,
        locked: Bool
    ) async throws -> ReadonlySessionBlock {
        let connection = try activeConnection()
        return try await client.setMarkdownBlockLock(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            blockId: blockId,
            locked: locked
        )
    }

    func previewMarkdown(
        _ session: SessionCatalogItem,
        blockId: String,
        markdown: String
    ) async throws -> String {
        let connection = try activeConnection()
        let response = try await client.previewMarkdown(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            blockId: blockId,
            markdown: markdown
        )
        return response.html
    }

    func reorderSessionBlocks(
        _ session: SessionCatalogItem,
        blockIds: [String],
        direction: String
    ) async throws -> ReadonlySessionManifest {
        let connection = try activeConnection()
        let manifest = try await client.reorderSessionBlocks(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            blockIds: blockIds,
            direction: direction
        )
        await loadCatalog(ready: connection.ready, token: connection.token)
        return manifest
    }

    func transferSessionBlocks(
        _ session: SessionCatalogItem,
        target: SessionCatalogItem,
        blockIds: [String],
        mode: String
    ) async throws -> TransferSessionBlocksResponse {
        let connection = try activeConnection()
        let response = try await client.transferSessionBlocks(
            ready: connection.ready,
            token: connection.token,
            sourceNotebookId: session.notebookId,
            sourceSessionId: session.sessionId,
            targetNotebookId: target.notebookId,
            targetSessionId: target.sessionId,
            blockIds: blockIds,
            mode: mode
        )
        await loadCatalog(ready: connection.ready, token: connection.token)
        return response
    }

    func deleteSessionBlocks(
        _ session: SessionCatalogItem,
        blockIds: [String]
    ) async throws -> ReadonlySessionManifest {
        let connection = try activeConnection()
        let manifest = try await client.deleteSessionBlocks(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            blockIds: blockIds
        )
        await loadCatalog(ready: connection.ready, token: connection.token)
        return manifest
    }

    func importSessionPdf(
        _ session: SessionCatalogItem,
        fileName: String,
        bytes: Data,
        baseRevision: String
    ) async throws -> ImportSessionPdfResponse {
        let connection = try activeConnection()
        return try await client.importSessionPdf(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            fileName: fileName,
            bytes: bytes,
            baseRevision: baseRevision
        )
    }

    func startRecognition(_ session: SessionCatalogItem, imageBlockId: String) async throws -> SessionRecognitionTask {
        let connection = try activeConnection()
        return try await client.startRecognition(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, imageBlockId: imageBlockId
        )
    }

    func rerunRecognition(_ session: SessionCatalogItem, transcriptBlockId: String) async throws -> SessionRecognitionTask {
        let connection = try activeConnection()
        return try await client.rerunRecognition(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId,
            transcriptBlockId: transcriptBlockId
        )
    }

    func previewSessionAssistant(
        _ session: SessionCatalogItem,
        input: SessionAssistantRequest
    ) async throws -> SessionAssistantPreview {
        let connection = try activeConnection()
        return try await client.previewSessionAssistant(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, input: input
        )
    }

    func runSessionAssistant(
        _ session: SessionCatalogItem,
        input: SessionAssistantRequest
    ) async throws -> SessionAssistantRemark {
        let connection = try activeConnection()
        return try await client.runSessionAssistant(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, input: input
        )
    }

    func startSessionAssistant(
        _ session: SessionCatalogItem,
        input: SessionAssistantRequest
    ) async throws -> SessionAssistantTask {
        let connection = try activeConnection()
        return try await client.startSessionAssistant(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, input: input
        )
    }

    func sessionAssistantEvents(
        _ session: SessionCatalogItem,
        taskId: String,
        afterSequence: Int
    ) async throws -> [SessionAssistantTaskEvent] {
        let connection = try activeConnection()
        return try await client.sessionAssistantEvents(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId,
            taskId: taskId, afterSequence: afterSequence
        )
    }

    func cancelSessionAssistant(
        _ session: SessionCatalogItem,
        taskId: String
    ) async throws -> SessionAssistantTask {
        let connection = try activeConnection()
        return try await client.cancelSessionAssistant(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, taskId: taskId
        )
    }

    func listSessionAssistant(_ session: SessionCatalogItem) async throws -> [SessionAssistantRemark] {
        let connection = try activeConnection()
        return try await client.listSessionAssistant(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId
        )
    }

    func deleteSessionAssistant(_ session: SessionCatalogItem, remarkId: String) async throws -> Bool {
        let connection = try activeConnection()
        return try await client.deleteSessionAssistant(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, remarkId: remarkId
        )
    }

    func promoteSessionAssistant(
        _ session: SessionCatalogItem,
        remarkId: String
    ) async throws -> SessionAssistantPromoteResponse {
        let connection = try activeConnection()
        return try await client.promoteSessionAssistant(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, remarkId: remarkId
        )
    }

    func recognitionTask(_ session: SessionCatalogItem, taskId: String) async throws -> SessionRecognitionTask {
        let connection = try activeConnection()
        return try await client.recognitionTask(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, taskId: taskId
        )
    }

    func recognitionTasks(_ session: SessionCatalogItem) async throws -> [SessionRecognitionTask] {
        let connection = try activeConnection()
        return try await client.recognitionTasks(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId
        )
    }

    func recognitionTaskSnapshot(
        _ session: SessionCatalogItem,
        afterActivitySequence: Int?,
        waitMilliseconds: Int
    ) async throws -> SessionRecognitionTasksResponse {
        let connection = try activeConnection()
        return try await client.recognitionTaskSnapshot(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId,
            afterActivitySequence: afterActivitySequence,
            waitMilliseconds: waitMilliseconds
        )
    }

    func companionUploadActivity(
        _ session: SessionCatalogItem
    ) async throws -> SessionCompanionUploadActivity? {
        let connection = try activeConnection()
        return try await client.companionUploadActivity(
            ready: connection.ready,
            token: connection.token,
            notebookId: session.notebookId,
            sessionId: session.sessionId
        )
    }

    func recognitionEvents(
        _ session: SessionCatalogItem, taskId: String, afterSequence: Int
    ) async throws -> [SessionRecognitionEvent] {
        let connection = try activeConnection()
        return try await client.recognitionEvents(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId,
            taskId: taskId, afterSequence: afterSequence
        )
    }

    func cancelRecognition(_ session: SessionCatalogItem, taskId: String) async throws -> SessionRecognitionTask {
        let connection = try activeConnection()
        return try await client.cancelRecognition(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, taskId: taskId
        )
    }

    func retryRecognition(_ session: SessionCatalogItem, taskId: String) async throws -> SessionRecognitionTask {
        let connection = try activeConnection()
        return try await client.retryRecognition(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId, taskId: taskId
        )
    }

    func createSessionExport(_ session: SessionCatalogItem, baseRevision: String) async throws -> SessionMarkdownExport {
        let connection = try activeConnection()
        return try await client.createSessionExport(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId,
            baseRevision: baseRevision
        )
    }

    func createCompanionPairingChallenge() async throws -> CompanionPairingChallenge {
        let connection = try activeConnection()
        let challenge = try await client.createCompanionPairingChallenge(
            ready: connection.ready,
            token: connection.token
        )
        companionPairingChallenge = challenge
        return challenge
    }

    func downloadSessionExport(_ session: SessionCatalogItem) async throws -> Data {
        let connection = try activeConnection()
        return try await client.downloadSessionExport(
            ready: connection.ready, token: connection.token,
            notebookId: session.notebookId, sessionId: session.sessionId
        )
    }

    func stop() {
        launchTask?.cancel()
        launchTask = nil
        companionServeTask?.cancel()
        companionServeTask = nil
        activeReady = nil
        activeToken = nil
        companionHost = nil
        companionHostToken = nil
        companionPairingChallenge = nil
        catalogState = .idle
        providerStatus = .unconfigured
        providerRestorationError = nil
        assistantProviderStatus = .unconfigured
        assistantProviderRestorationError = nil
        if let notesRootAccessURL {
            notesRootAccessURL.stopAccessingSecurityScopedResource()
            self.notesRootAccessURL = nil
        }
        guard let process else {
            if state != .starting { state = .idle }
            return
        }
        state = .stopping
        self.process = nil
        if process.isRunning { process.terminate() }
        state = .idle
    }

    private func reconcileCompanionServe() {
        companionServeTask?.cancel()
        tailscaleServeState = .checking
        companionServeTask = Task { [weak self] in
            guard let self else { return }
            do {
                let coordinator = try TailscaleServeCoordinator.locate()
                let origin = try await coordinator.ensureServing()
                _ = try CompanionHostAddressPreferences.save(origin)
                self.companionPublicOrigin = origin
                self.tailscaleServeState = .ready(origin: origin)
            } catch is CancellationError {
                self.tailscaleServeState = .idle
            } catch {
                self.tailscaleServeState = .failed(message: error.localizedDescription)
            }
        }
    }

    private func loadCatalog(ready: SidecarReadyMessage, token: String) async {
        catalogState = .loading
        do {
            let catalog = try await client.catalog(ready: ready, token: token)
            catalogState = .loaded(catalog.notebooks)
        } catch is CancellationError {
            catalogState = .idle
        } catch {
            catalogState = .failed(error.localizedDescription)
        }
    }

    private func restoreProviderConfiguration(ready: SidecarReadyMessage, token: String) async {
        await restoreProviderConfiguration(.recognition, ready: ready, token: token)
        await restoreProviderConfiguration(.assistant, ready: ready, token: token)
    }

    private func restoreProviderConfiguration(
        _ purpose: ProviderPurpose,
        ready: SidecarReadyMessage,
        token: String
    ) async {
        guard let record = ProviderPreferences.load(purpose) else {
            let status = (try? await client.providerStatus(ready: ready, token: token, purpose: purpose)) ?? .unconfigured
            applyRestoration(purpose, state: ProviderRestoration.resolve(
                hasSavedRecord: false,
                savedKeyAvailable: false,
                remoteStatus: status,
                restoreFailureMessage: nil
            ))
            return
        }
        let store = KeychainCredentialStore()
        var savedKey: String?
        var keychainFailed = false
        do {
            savedKey = try await Task.detached(operation: {
                let scoped = try store.read(account: purpose.keychainAccount(for: record.providerId))
                if scoped?.isEmpty == false { return scoped }
                return purpose == .recognition ? try store.read(account: record.providerId.rawValue) : nil
            }).value
        } catch {
            keychainFailed = true
        }
        let hasKey = !keychainFailed && savedKey?.isEmpty == false
        guard hasKey, let apiKey = savedKey else {
            applyRestoration(purpose, state: ProviderRestoration.resolve(
                hasSavedRecord: true,
                savedKeyAvailable: false,
                remoteStatus: .unconfigured,
                restoreFailureMessage: nil
            ))
            return
        }
        do {
            let status = try await client.configureProvider(
                ready: ready,
                token: token,
                providerId: record.providerId.rawValue,
                model: record.model,
                endpoint: record.endpoint,
                apiKey: apiKey,
                purpose: purpose
            )
            applyRestoration(purpose, state: ProviderRestoration.resolve(
                hasSavedRecord: true,
                savedKeyAvailable: true,
                remoteStatus: status,
                restoreFailureMessage: nil
            ))
        } catch {
            applyRestoration(purpose, state: ProviderRestoration.resolve(
                hasSavedRecord: true,
                savedKeyAvailable: true,
                remoteStatus: .unconfigured,
                restoreFailureMessage: error.localizedDescription
            ))
        }
    }

    private func applyRestoration(_ purpose: ProviderPurpose, state: ProviderRestoration.State) {
        if purpose == .recognition {
            providerStatus = state.status
            providerRestorationError = state.error
        } else {
            assistantProviderStatus = state.status
            assistantProviderRestorationError = state.error
        }
    }

    private func activeConnection() throws -> (ready: SidecarReadyMessage, token: String) {
        guard let activeReady, let activeToken else { throw SidecarProtocolError.unhealthyResponse }
        return (activeReady, activeToken)
    }

    private func waitUntilReady() async throws {
        for _ in 0..<100 {
            switch state {
            case .ready:
                return
            case let .failed(message):
                throw SidecarRestartError.failed(message)
            default:
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        throw SidecarRestartError.timedOut
    }

    private func launch(_ configuration: SidecarConfiguration) async throws -> SidecarReadyMessage {
        let process = Process()
        let stdout = Pipe()
        process.executableURL = configuration.executableURL
        process.arguments = configuration.arguments
        process.environment = configuration.environment
        process.standardOutput = stdout
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] terminated in
            Task { @MainActor in
                guard let self, self.process === terminated else { return }
                self.process = nil
                if case .stopping = self.state {
                    self.state = .idle
                } else if case .ready = self.state {
                    self.state = .failed("Sidecar 已意外退出，可点击重试。")
                }
            }
        }
        try process.run()
        self.process = process
        return try await Self.readReady(from: stdout.fileHandleForReading)
    }

    nonisolated static func readReady(from handle: FileHandle) async throws -> SidecarReadyMessage {
        let line = try await Task.detached {
            var data = Data()
            while data.count < 16_384 {
                guard let chunk = try handle.read(upToCount: 1), !chunk.isEmpty else { break }
                if chunk[0] == 0x0A { break }
                data.append(chunk)
            }
            guard !data.isEmpty else { throw SidecarProtocolError.invalidReadyJSON }
            return data
        }.value
        let ready = try JSONDecoder().decode(SidecarReadyMessage.self, from: line)
        try ready.validate()
        return ready
    }
}

private enum SidecarRestartError: LocalizedError {
    case failed(String)
    case timedOut

    var errorDescription: String? {
        switch self {
        case let .failed(message): "MathNotes 重新启动失败：\(message)"
        case .timedOut: "MathNotes 重新启动超时，已恢复原来的配置。"
        }
    }
}

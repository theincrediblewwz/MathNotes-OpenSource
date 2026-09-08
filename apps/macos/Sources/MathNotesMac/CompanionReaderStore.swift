import Combine
import Foundation

enum WorkspaceSourceMode: String, CaseIterable, Identifiable {
    case local
    case companion

    static let storageKey = "mathnotes.workspace.source.v1"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .local: "本机"
        case .companion: "远程"
        }
    }
}

enum CompanionReaderConnectionState: Equatable {
    case idle
    case loading
    case ready
    case failed(String)
}

struct CompanionRemoteDocument: Equatable, Sendable {
    let target: CompanionPairingTarget
    let manifest: CompanionSessionManifest
    let markdown: String
    let sourceHTML: String
    let html: String
    let missingAssetCount: Int
}

@MainActor
final class CompanionReaderStore: ObservableObject {
    @Published private(set) var state: CompanionReaderConnectionState = .idle
    @Published private(set) var catalogState: CatalogState = .idle

    @Published private(set) var hostProfiles: [RemoteHostProfile] = []
    @Published private(set) var activeHostID: String?
    @Published private(set) var replicaSupervisor: SidecarSupervisor?
    @Published private(set) var syncResult: ReplicaSyncResult?
    @Published private(set) var syncMessage: String?
    @Published private(set) var isSynchronizing = false
    @Published private(set) var hostUpgradeRequired = false
    private var replicaCatalogSubscription: AnyCancellable?
    private var mutationSubscription: AnyCancellable?
    private var synchronizeTask: Task<Void, Never>?
    private var refreshLoop: Task<Void, Never>?
    private var resynchronizeRequested = false
    private var replicaCredential: (origin: String, token: String)?
    private let client = CompanionConnectionClient()
    private var targetBySessionID: [String: CompanionPairingTarget] = [:]
    private var loadTask: Task<Void, Never>?
    private let credentialProvider: (() async throws -> (origin: String, token: String))?

    private let profileDefaults: UserDefaults
    private let replicaConfiguration: ((String) throws -> SidecarConfiguration)?
    private var replicasEnabled: Bool { credentialProvider == nil || replicaConfiguration != nil }

    init(credentialProvider: (() async throws -> (origin: String, token: String))? = nil,
         profileDefaults: UserDefaults = .standard,
         replicaConfiguration: ((String) throws -> SidecarConfiguration)? = nil) {
        self.credentialProvider = credentialProvider
        self.profileDefaults = profileDefaults
        self.replicaConfiguration = replicaConfiguration
        if credentialProvider == nil || replicaConfiguration != nil {
            hostProfiles = RemoteHostProfile.load(defaults: profileDefaults)
            activeHostID = profileDefaults.string(forKey: RemoteHostProfile.selectionKey)
        }
        mutationSubscription = NotificationCenter.default.publisher(for: .mathNotesWorkspaceChanged)
            .receive(on: RunLoop.main).sink { [weak self] notification in
                guard let self, notification.userInfo?["instanceId"] as? String == self.replicaSupervisor?.instanceID else { return }
                self.synchronizeNow()
            }
    }

    func reloadCatalog() {
        loadTask?.cancel()
        state = .loading
        if replicaSupervisor == nil { catalogState = .loading }
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let credential = try await self.credential()
                if self.replicasEnabled, await self.prepareReplica(credential) { return }
                let response = try await self.client.catalog(
                    origin: credential.origin,
                    token: credential.token
                )
                try Task.checkCancellation()
                let mapped = Self.mapCatalog(response.targets)
                self.targetBySessionID = Dictionary(
                    uniqueKeysWithValues: response.targets.map {
                        ("\($0.notebookId)/\($0.sessionId)", $0)
                    }
                )
                self.catalogState = .loaded(mapped)
                self.state = .ready
            } catch is CancellationError {
                return
            } catch {
                if self.replicasEnabled, let host = self.activeHost {
                    _ = await self.prepareReplica((origin: host.origin, token: ""))
                    self.syncMessage = "本地副本可继续编辑；请在连接设置中授权读取这台主机的令牌，再恢复同步。"
                    return
                }
                let message = Self.userMessage(error)
                self.catalogState = .failed(message)
                self.state = .failed(message)
            }
        }
    }

    func clear() {
        refreshLoop?.cancel()
        refreshLoop = nil
        synchronizeTask?.cancel()
        synchronizeTask = nil
        replicaCatalogSubscription = nil
        replicaSupervisor?.stop()
        replicaSupervisor = nil
        replicaCredential = nil
        isSynchronizing = false
        resynchronizeRequested = false
        syncResult = nil
        syncMessage = nil
        hostUpgradeRequired = false
        loadTask?.cancel()
        loadTask = nil
        targetBySessionID = [:]
        catalogState = .idle
        state = .idle
    }

    func loadDocument(_ session: SessionCatalogItem) async throws -> CompanionRemoteDocument {
        let credential = try await credential()
        let target = targetBySessionID[session.id] ?? CompanionPairingTarget(
            notebookId: session.notebookId,
            notebookTitle: nil,
            sessionId: session.sessionId,
            title: session.title
        )
        let manifest = try await client.manifest(
            origin: credential.origin,
            token: credential.token,
            target: target
        )
        async let htmlResponse = client.document(
            origin: credential.origin,
            token: credential.token,
            target: target,
            format: "html"
        )
        async let markdownResponse = client.document(
            origin: credential.origin,
            token: credential.token,
            target: target,
            format: "markdown"
        )
        let (html, markdown) = try await (htmlResponse, markdownResponse)
        guard html.revision == manifest.revision, markdown.revision == manifest.revision else {
            throw CompanionConnectionError.documentChanged
        }
        guard Data(html.text.utf8).count == manifest.htmlBytes,
              Data(markdown.text.utf8).count == manifest.markdownBytes else {
            throw CompanionConnectionError.documentLengthMismatch
        }
        return CompanionRemoteDocument(
            target: target,
            manifest: manifest,
            markdown: markdown.text,
            sourceHTML: html.text,
            html: Self.renderHTML(html.text, manifest: manifest, assetData: [:]),
            missingAssetCount: manifest.assets.count
        )
    }

    func loadAssets(for document: CompanionRemoteDocument) async -> CompanionRemoteDocument {
        guard !document.manifest.assets.isEmpty else { return document }
        guard let credential = try? await credential() else { return document }
        let client = self.client
        let target = document.target
        var pairs: [(String, Data?)] = []
        for startIndex in stride(from: 0, to: document.manifest.assets.count, by: 3) {
            let endIndex = min(startIndex + 3, document.manifest.assets.count)
            let batch = document.manifest.assets[startIndex..<endIndex]
            let batchPairs = await withTaskGroup(
                of: (String, Data?).self,
                returning: [(String, Data?)].self
            ) { group in
                for asset in batch {
                    group.addTask {
                        let data = try? await client.asset(
                            origin: credential.origin,
                            token: credential.token,
                            target: target,
                            path: asset.path
                        )
                        return (asset.id, data)
                    }
                }
                var output: [(String, Data?)] = []
                for await pair in group { output.append(pair) }
                return output
            }
            pairs.append(contentsOf: batchPairs)
        }
        let data = Dictionary(uniqueKeysWithValues: pairs.compactMap { id, bytes in
            bytes.map { (id, $0) }
        })
        return CompanionRemoteDocument(
            target: document.target,
            manifest: document.manifest,
            markdown: document.markdown,
            sourceHTML: document.sourceHTML,
            html: Self.renderHTML(
                document.sourceHTML,
                manifest: document.manifest,
                assetData: data
            ),
            missingAssetCount: max(0, document.manifest.assets.count - data.count)
        )
    }

    private func credential() async throws -> (origin: String, token: String) {
        if let credentialProvider { return try await credentialProvider() }
        if let profile = activeHost {
            guard let token = try await CompanionCredentialStore.shared.read(origin: profile.origin), !token.isEmpty else {
                throw CompanionConnectionError.missingToken
            }
            return (profile.origin, token)
        }
        guard let preference = CompanionConnectionPreferences.load() else { throw CompanionConnectionError.notConfigured }
        guard let token = try await CompanionCredentialStore.shared.read(), !token.isEmpty else { throw CompanionConnectionError.missingToken }
        return (preference.origin, token)
    }

    var activeHost: RemoteHostProfile? { hostProfiles.first { $0.id == activeHostID } }

    func reloadSavedConnection() {
        clear()
        activeHostID = nil
        reloadCatalog()
    }

    func selectHost(_ host: RemoteHostProfile) {
        guard host.id != activeHostID || replicaSupervisor == nil else { return }
        clear()
        activeHostID = host.id
        profileDefaults.set(host.id, forKey: RemoteHostProfile.selectionKey)
        reloadCatalog()
    }

    private func prepareReplica(_ credential: (origin: String, token: String)) async -> Bool {
        var profile = hostProfiles.first { $0.origin == credential.origin }
        do {
            let identity = try await client.workspaceIdentity(origin: credential.origin, token: credential.token)
            try Task.checkCancellation()
            profile = RemoteHostProfile(id: identity.hostId,
                name: URL(string: credential.origin)?.host ?? identity.name, origin: credential.origin)
            if let profile {
                hostProfiles.removeAll { $0.id == profile.id }
                hostProfiles.append(profile)
                RemoteHostProfile.save(hostProfiles, defaults: profileDefaults)
            }
            hostUpgradeRequired = false
        } catch {
            if Task.isCancelled { return true }
            guard profile != nil else {
                hostUpgradeRequired = true
                syncMessage = "主机更新后可启用可编辑副本；目前仍可阅读已有正文。"
                return false
            }
            syncMessage = "暂时连接不上主机，继续使用本地副本。"
        }
        guard let profile, !Task.isCancelled else { return true }
        do {
            if replicaSupervisor == nil || activeHostID != profile.id {
                replicaSupervisor?.stop()
                let configuration = try replicaConfiguration?(profile.id) ?? .replica(hostId: profile.id, directory: profile.directory)
                let replica = SidecarSupervisor(configuration: configuration)
                replicaSupervisor = replica
                activeHostID = profile.id
                profileDefaults.set(profile.id, forKey: RemoteHostProfile.selectionKey)
                replicaCatalogSubscription = replica.$catalogState.sink { [weak self] state in
                    guard let self else { return }
                    if case .loaded = state { self.catalogState = state }
                }
                replica.start()
                let deadline = ContinuousClock.now.advanced(by: .seconds(16))
                while replica.instanceID == nil, ContinuousClock.now < deadline {
                    if case let .failed(message) = replica.state { throw NSError(domain: "MathNotes.Replica", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
                    try await Task.sleep(for: .milliseconds(40))
                }
                guard replica.instanceID != nil else { throw SidecarProtocolError.unhealthyResponse }
            }
            if let replica = replicaSupervisor {
                let cached = try await replica.replicaStatus()
                guard !Task.isCancelled, replicaSupervisor === replica, activeHostID == profile.id else { return true }
                // Restore known capabilities even when credentials are temporarily
                // unavailable. Offline directory edits must remain available.
                if cached.hostId == profile.id { syncResult = cached }
            }
            replicaCredential = credential.token.isEmpty ? nil : credential
            state = .ready
            synchronizeNow()
            refreshLoop?.cancel()
            refreshLoop = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                    self?.synchronizeNow()
                }
            }
        } catch {
            if Task.isCancelled { return true }
            catalogState = .failed(error.localizedDescription)
            state = .failed(error.localizedDescription)
        }
        return true
    }

    func synchronizeNow() {
        guard let replica = replicaSupervisor, let host = activeHost, let credential = replicaCredential else { return }
        if synchronizeTask != nil { resynchronizeRequested = true; return }
        isSynchronizing = true
        synchronizeTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.replicaSupervisor === replica {
                    self.isSynchronizing = false
                    self.synchronizeTask = nil
                    if self.resynchronizeRequested {
                        self.resynchronizeRequested = false
                        self.synchronizeNow()
                    }
                }
            }
            do {
                let result = try await replica.synchronizeReplica(origin: credential.origin, hostToken: credential.token, hostId: host.id)
                guard !Task.isCancelled, self.replicaSupervisor === replica else { return }
                self.syncResult = result
                if result.conflictCount > 0 { self.syncMessage = "\(result.conflictCount) 项修改有冲突，两边内容均已保留" }
                else if result.pendingCount > 0 { self.syncMessage = "\(result.pendingCount) 项修改等待同步" }
                else if result.sessions.contains(where: { $0.status == "error" }) { self.syncMessage = "部分笔记同步失败，可重试；本地内容已保留" }
                else { self.syncMessage = "已与主机同步" }
            } catch {
                guard !Task.isCancelled, self.replicaSupervisor === replica else { return }
                self.syncResult = try? await replica.replicaStatus()
                self.syncMessage = "暂时无法同步；本地修改已保留，连接恢复后重试"
            }
        }
    }

    func resolveConflict(_ session: ReplicaSessionStatus, choice: String) async throws {
        guard let replica = replicaSupervisor else { throw SidecarProtocolError.unhealthyResponse }
        try await replica.resolveReplica(ReplicaResolveRequest(notebookId: session.notebookId, sessionId: session.sessionId, choice: choice))
        syncResult = try await replica.replicaStatus()
        synchronizeNow()
    }

    func resolveCatalogConflict(_ conflict: ReplicaCatalogConflict) async throws -> URL {
        guard let replica = replicaSupervisor, let host = activeHost else { throw SidecarProtocolError.unhealthyResponse }
        let result = try await replica.resolveReplicaCatalog(operationId: conflict.id)
        let parts = result.backupRelativePath.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == ".mathnotes-replica-backups", UUID(uuidString: String(parts[1])) != nil else {
            throw SidecarProtocolError.unhealthyResponse
        }
        syncResult = try await replica.replicaStatus()
        synchronizeNow()
        return host.directory.appending(path: "notes").appending(path: result.backupRelativePath)
    }

    private static func mapCatalog(_ targets: [CompanionPairingTarget]) -> [NotebookCatalogItem] {
        var order: [String] = []
        var grouped: [String: [CompanionPairingTarget]] = [:]
        for target in targets {
            if grouped[target.notebookId] == nil { order.append(target.notebookId) }
            grouped[target.notebookId, default: []].append(target)
        }
        return order.compactMap { notebookId in
            guard let targets = grouped[notebookId], let first = targets.first else { return nil }
            let notebookTitle = first.notebookTitle?.isEmpty == false
                ? first.notebookTitle ?? notebookId
                : notebookId
            let sessions = targets.map {
                SessionCatalogItem(
                    notebookId: $0.notebookId,
                    sessionId: $0.sessionId,
                    title: $0.title,
                    status: "只读",
                    createdAt: "",
                    updatedAt: ""
                )
            }
            return NotebookCatalogItem(
                notebookId: notebookId,
                title: notebookTitle,
                sessionCount: sessions.count,
                createdAt: "",
                updatedAt: "",
                sessions: sessions
            )
        }
    }

    private static func renderHTML(
        _ rawHTML: String?,
        manifest: CompanionSessionManifest,
        assetData: [String: Data]
    ) -> String {
        var html = rawHTML ?? ""
        var missing = 0
        for asset in manifest.assets {
            let source = "mathnotes-companion-asset://\(asset.id)"
            if let bytes = assetData[asset.id] {
                let dataURL = "data:\(asset.mimeType);base64,\(bytes.base64EncodedString())"
                html = html.replacingOccurrences(of: source, with: dataURL)
            } else {
                html = html.replacingOccurrences(of: source, with: "")
                missing += 1
            }
        }
        let policy = """
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
        """
        if let headRange = html.range(of: "<head>", options: .caseInsensitive) {
            html.insert(contentsOf: policy, at: headRange.upperBound)
        }
        if missing > 0 {
            let warning = "<aside class=\"asset-sync-warning\">\(missing) 个素材正在同步，正文已可阅读。</aside>"
            if let bodyEnd = html.range(of: "</body>", options: [.caseInsensitive, .backwards]) {
                html.insert(contentsOf: warning, at: bodyEnd.lowerBound)
            } else {
                html.append(warning)
            }
        }
        return html
    }

    private static func userMessage(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut:
                return "连接电脑超时，请确认电脑在线后重试。"
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost:
                return "暂时无法连接电脑，请检查远程地址或 Tailscale 状态。"
            default:
                return "远程连接失败：\(urlError.localizedDescription)"
            }
        }
        return error.localizedDescription
    }
}

extension Notification.Name {
    static let mathNotesReloadCatalog = Notification.Name("mathnotes.reload-catalog")
}

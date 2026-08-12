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

    private let client = CompanionConnectionClient()
    private var targetBySessionID: [String: CompanionPairingTarget] = [:]
    private var loadTask: Task<Void, Never>?

    func reloadCatalog() {
        loadTask?.cancel()
        state = .loading
        catalogState = .loading
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let credential = try await self.credential()
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
                let message = Self.userMessage(error)
                self.catalogState = .failed(message)
                self.state = .failed(message)
            }
        }
    }

    func clear() {
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
        guard let preference = CompanionConnectionPreferences.load() else {
            throw CompanionConnectionError.invalidAddress
        }
        let store = KeychainCredentialStore(service: CompanionConnectionCredential.service)
        guard let token = try await Task.detached(operation: {
            try store.read(account: CompanionConnectionCredential.account)
        }).value, !token.isEmpty else {
            throw CompanionConnectionError.missingToken
        }
        return (preference.origin, token)
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

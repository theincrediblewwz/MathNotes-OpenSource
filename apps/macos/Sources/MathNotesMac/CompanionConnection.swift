import Foundation

struct CompanionConnectionPreference: Codable, Equatable, Sendable {
    let origin: String
}

enum CompanionConnectionPreferences {
    static let key = "mathnotes.companion.connection.v1"

    static func load(defaults: UserDefaults = .standard) -> CompanionConnectionPreference? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(CompanionConnectionPreference.self, from: data)
    }

    static func save(_ preference: CompanionConnectionPreference, defaults: UserDefaults = .standard) throws {
        defaults.set(try JSONEncoder().encode(preference), forKey: key)
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}

struct CompanionHostAddressPreference: Codable, Equatable, Sendable {
    let origin: String
}

enum CompanionHostAddressPreferences {
    static let key = "mathnotes.companion.host-address.v1"

    static func load(defaults: UserDefaults = .standard) -> CompanionHostAddressPreference? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(CompanionHostAddressPreference.self, from: data)
    }

    static func normalize(_ rawValue: String) throws -> String {
        let origin = try CompanionConnectionClient().normalizeOrigin(rawValue)
        guard let host = URLComponents(string: origin)?.host?.lowercased(),
              host != "localhost",
              host != "127.0.0.1",
              host != "::1",
              host != "0.0.0.0",
              host != "::" else {
            throw CompanionConnectionError.localOnlyAddress
        }
        return origin
    }

    static func save(_ rawValue: String, defaults: UserDefaults = .standard) throws -> String {
        let origin = try normalize(rawValue)
        defaults.set(
            try JSONEncoder().encode(CompanionHostAddressPreference(origin: origin)),
            forKey: key
        )
        return origin
    }
}

enum CompanionConnectionError: LocalizedError {
    case invalidAddress
    case unsupportedScheme
    case addressContainsExtraParts
    case localOnlyAddress
    case missingToken
    case tokenRequiredForNewAddress
    case rejected(Int)
    case invalidResponse
    case documentChanged
    case documentLengthMismatch

    var errorDescription: String? {
        switch self {
        case .invalidAddress:
            "电脑地址格式不正确，请填写 https://主机名 或 IP:端口。"
        case .unsupportedScheme:
            "电脑地址只支持 HTTP 或 HTTPS。"
        case .addressContainsExtraParts:
            "电脑地址只填写服务根地址，不要包含账号、路径或参数。"
        case .localOnlyAddress:
            "这个地址只能在 Mac 本机访问。请填写手机可访问的局域网地址或 Tailscale HTTPS 地址。"
        case .missingToken:
            "请填写电脑端显示的配对令牌。"
        case .tokenRequiredForNewAddress:
            "电脑地址已经改变，请输入新电脑的配对令牌。"
        case let .rejected(status):
            status == 401 || status == 403
                ? "配对令牌无效或已失效，请在电脑端重新配对。"
                : "电脑暂时无法完成连接检查（HTTP \(status)）。"
        case .invalidResponse:
            "电脑返回了无法识别的连接信息。"
        case .documentChanged:
            "笔记在同步过程中发生了变化，请重新读取。"
        case .documentLengthMismatch:
            "收到的笔记内容不完整，请重新读取。"
        }
    }
}

struct CompanionConnectionCheck: Equatable, Sendable {
    let targetCount: Int
}

struct CompanionPairingTarget: Codable, Equatable, Hashable, Sendable {
    let notebookId: String
    let notebookTitle: String?
    let sessionId: String
    let title: String
}

struct CompanionCatalogResponse: Codable, Equatable, Sendable {
    let ok: Bool
    let version: Int
    let activeTarget: CompanionPairingTarget?
    let targets: [CompanionPairingTarget]
}

struct CompanionSessionAsset: Codable, Equatable, Hashable, Sendable {
    let id: String
    let path: String
    let mimeType: String
}

struct CompanionSessionManifest: Codable, Equatable, Sendable {
    let version: Int
    let notebookId: String
    let sessionId: String
    let title: String
    let revision: String
    let updatedAt: String
    let blockCount: Int
    let markdownBytes: Int
    let htmlBytes: Int
    let assets: [CompanionSessionAsset]
}

struct CompanionTextDocument: Equatable, Sendable {
    let revision: String
    let text: String
}

struct CompanionConnectionClient: Sendable {
    func normalizeOrigin(_ rawValue: String) throws -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw CompanionConnectionError.invalidAddress }
        let candidate = trimmed.range(
            of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#,
            options: .regularExpression
        ) == nil ? "http://\(trimmed)" : trimmed
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              let host = components.host,
              !host.isEmpty else {
            throw CompanionConnectionError.invalidAddress
        }
        guard scheme == "http" || scheme == "https" else {
            throw CompanionConnectionError.unsupportedScheme
        }
        guard components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            throw CompanionConnectionError.addressContainsExtraParts
        }
        var normalized = URLComponents()
        normalized.scheme = scheme
        normalized.host = host
        normalized.port = components.port
        guard let origin = normalized.url?.absoluteString else {
            throw CompanionConnectionError.invalidAddress
        }
        return origin.hasSuffix("/") ? String(origin.dropLast()) : origin
    }

    func verify(origin: String, token: String) async throws -> CompanionConnectionCheck {
        let catalog = try await catalog(origin: origin, token: token)
        return CompanionConnectionCheck(targetCount: catalog.targets.count)
    }

    func catalog(origin: String, token: String) async throws -> CompanionCatalogResponse {
        let request = try authenticatedRequest(
            origin: origin,
            token: token,
            path: "/api/v1/pairing/verify",
            accept: "application/json"
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        guard let body = try? JSONDecoder().decode(CompanionCatalogResponse.self, from: data),
              body.ok,
              body.version == 1 else {
            throw CompanionConnectionError.invalidResponse
        }
        return body
    }

    func manifest(
        origin: String,
        token: String,
        target: CompanionPairingTarget
    ) async throws -> CompanionSessionManifest {
        let request = try authenticatedRequest(
            origin: origin,
            token: token,
            path: "/api/v2/companion/session/manifest",
            queryItems: targetQuery(target),
            accept: "application/json"
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        guard let body = try? JSONDecoder().decode(CompanionSessionManifest.self, from: data),
              body.version == 2,
              body.notebookId == target.notebookId,
              body.sessionId == target.sessionId else {
            throw CompanionConnectionError.invalidResponse
        }
        return body
    }

    func document(
        origin: String,
        token: String,
        target: CompanionPairingTarget,
        format: String
    ) async throws -> CompanionTextDocument {
        guard format == "markdown" || format == "html" else {
            throw CompanionConnectionError.invalidResponse
        }
        var query = targetQuery(target)
        query.append(URLQueryItem(name: "format", value: format))
        let request = try authenticatedRequest(
            origin: origin,
            token: token,
            path: "/api/v2/companion/session/document",
            queryItems: query,
            accept: format == "html" ? "text/html" : "text/markdown"
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try validate(response)
        guard let revision = http.value(forHTTPHeaderField: "x-mathnotes-revision"),
              let text = String(data: data, encoding: .utf8) else {
            throw CompanionConnectionError.invalidResponse
        }
        return CompanionTextDocument(revision: revision, text: text)
    }

    func asset(
        origin: String,
        token: String,
        target: CompanionPairingTarget,
        path: String
    ) async throws -> Data {
        var query = targetQuery(target)
        query.append(URLQueryItem(name: "path", value: path))
        let request = try authenticatedRequest(
            origin: origin,
            token: token,
            path: "/api/v1/companion/asset",
            queryItems: query,
            accept: "application/octet-stream"
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        return data
    }

    private func authenticatedRequest(
        origin: String,
        token: String,
        path: String,
        queryItems: [URLQueryItem] = [],
        accept: String
    ) throws -> URLRequest {
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedToken.isEmpty else { throw CompanionConnectionError.missingToken }
        let normalizedOrigin = try normalizeOrigin(origin)
        guard var components = URLComponents(string: normalizedOrigin) else {
            throw CompanionConnectionError.invalidAddress
        }
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else { throw CompanionConnectionError.invalidAddress }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("Bearer \(trimmedToken)", forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        return request
    }

    @discardableResult
    private func validate(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw CompanionConnectionError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw CompanionConnectionError.rejected(http.statusCode)
        }
        return http
    }

    private func targetQuery(_ target: CompanionPairingTarget) -> [URLQueryItem] {
        [
            URLQueryItem(name: "notebookId", value: target.notebookId),
            URLQueryItem(name: "sessionId", value: target.sessionId)
        ]
    }
}

enum CompanionConnectionCredential {
    static let service = "com.mathnotes.companion-token"
    static let account = "active"
}

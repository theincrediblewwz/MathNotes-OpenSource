import Foundation

enum TailscaleServeState: Equatable, Sendable {
    case idle
    case checking
    case ready(origin: String)
    case failed(message: String)
}

enum TailscaleServeInspection: Equatable, Sendable {
    case unconfigured
    case ready(origin: String)
    case conflict

    static func inspect(_ data: Data, expectedProxy: String) throws -> Self {
        let trimmed = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == "null" { return .unconfigured }
        let object = try JSONSerialization.jsonObject(with: data)
        guard let root = object as? [String: Any] else {
            throw CompanionHostAutomationError.invalidServeStatus
        }
        let tcp = dictionary(root["TCP"])
        let web = dictionary(root["Web"])
        let foreground = dictionary(root["Foreground"])
        let allowFunnel = dictionary(root["AllowFunnel"])
        if allowFunnel.values.contains(where: { ($0 as? Bool) == true }) {
            return .conflict
        }

        let httpsEnabled = dictionary(tcp["443"])["HTTPS"] as? Bool == true
        if httpsEnabled {
            for hostPort in web.keys.sorted() {
                let server = dictionary(web[hostPort])
                let handlers = dictionary(server["Handlers"])
                let rootHandler = dictionary(handlers["/"])
                guard normalizedProxy(rootHandler["Proxy"] as? String) ==
                        normalizedProxy(expectedProxy) else {
                    continue
                }
                guard let origin = httpsOrigin(from: hostPort) else {
                    throw CompanionHostAutomationError.invalidServeStatus
                }
                return .ready(origin: origin)
            }
        }

        if tcp.isEmpty && web.isEmpty && foreground.isEmpty {
            return .unconfigured
        }
        return .conflict
    }

    private static func dictionary(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    private static func normalizedProxy(_ value: String?) -> String? {
        value?.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static func httpsOrigin(from hostPort: String) -> String? {
        guard var components = URLComponents(string: "https://\(hostPort)"),
              components.host != nil else {
            return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        if components.port == 443 { components.port = nil }
        guard let value = components.url?.absoluteString else { return nil }
        return value.hasSuffix("/") ? String(value.dropLast()) : value
    }
}

enum TailscaleIPv4Inspection {
    static func inspect(_ data: Data) throws -> String {
        let candidates = String(decoding: data, as: UTF8.self)
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
        guard let address = candidates.first,
              candidates.count == 1,
              isTailnetIPv4(address) else {
            throw CompanionHostAutomationError.invalidTailnetAddress
        }
        return address
    }

    static func isTailnetIPv4(_ address: String) -> Bool {
        let octets = address.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4,
              octets.allSatisfy({ (0...255).contains($0) }) else {
            return false
        }
        return octets[0] == 100 && (64...127).contains(octets[1])
    }
}

struct TailscaleServeCoordinator: Sendable {
    static let expectedProxy = "http://127.0.0.1:1051"
    let executableURL: URL

    static func locate(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) throws -> Self {
        let configured = environment["MATHNOTES_TAILSCALE_CLI"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let candidates = [
            configured,
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
        ].compactMap { $0 }
        guard let path = candidates.first(where: { fileManager.isExecutableFile(atPath: $0) }) else {
            throw CompanionHostAutomationError.tailscaleMissing
        }
        return Self(executableURL: URL(fileURLWithPath: path))
    }

    func inspectServing(expectedProxy: String) async throws -> String? {
        try await Task.detached {
            let status = try Self.run(executableURL, arguments: ["serve", "status", "--json"])
            guard status.exitCode == 0 else {
                throw CompanionHostAutomationError.commandFailed(Self.detail(from: status))
            }
            switch try TailscaleServeInspection.inspect(
                status.stdout,
                expectedProxy: expectedProxy
            ) {
            case let .ready(origin):
                return origin
            case .conflict:
                throw CompanionHostAutomationError.serveConflict
            case .unconfigured:
                return nil
            }
        }.value
    }

    func readIPv4Address() async throws -> String {
        try await Task.detached {
            let result = try Self.run(executableURL, arguments: ["ip", "-4"])
            guard result.exitCode == 0 else {
                throw CompanionHostAutomationError.commandFailed(Self.detail(from: result))
            }
            return try TailscaleIPv4Inspection.inspect(result.stdout)
        }.value
    }

    private static func run(_ executableURL: URL, arguments: [String]) throws -> CommandResult {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = executableURL
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["TAILSCALE_BE_CLI"] = "1"
        process.environment = environment
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()

        let deadline = Date().addingTimeInterval(20)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            throw CompanionHostAutomationError.commandTimedOut
        }
        return CommandResult(
            exitCode: process.terminationStatus,
            stdout: stdout.fileHandleForReading.readDataToEndOfFile(),
            stderr: stderr.fileHandleForReading.readDataToEndOfFile()
        )
    }

    private static func detail(from result: CommandResult) -> String {
        let data = result.stderr.isEmpty ? result.stdout : result.stderr
        let value = String(decoding: data.prefix(600), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "Tailscale 命令执行失败（\(result.exitCode)）。" : value
    }

    private struct CommandResult: Sendable {
        let exitCode: Int32
        let stdout: Data
        let stderr: Data
    }
}

enum CompanionHostTokenPolicy {
    static let minimumLength = 16
    static let maximumLength = 128
    private static let pattern = try! NSRegularExpression(pattern: #"^[A-Za-z0-9._~-]+$"#)

    static func validate(_ token: String, confirmation: String) throws -> String {
        let normalized = try normalize(token)
        let normalizedConfirmation = try normalize(confirmation)
        guard normalized == normalizedConfirmation else {
            throw CompanionHostAutomationError.tokenMismatch
        }
        return normalized
    }

    static func normalize(_ value: String) throws -> String {
        let token = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (minimumLength...maximumLength).contains(token.count) else {
            throw CompanionHostAutomationError.invalidTokenLength
        }
        let range = NSRange(token.startIndex..<token.endIndex, in: token)
        guard pattern.firstMatch(in: token, range: range)?.range == range else {
            throw CompanionHostAutomationError.invalidTokenCharacters
        }
        return token
    }

    static func generate() -> String {
        "\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
    }
}

enum CompanionHostAutomationError: LocalizedError {
    case tailscaleMissing
    case serveConflict
    case invalidServeStatus
    case invalidTailnetAddress
    case commandFailed(String)
    case commandTimedOut
    case invalidTokenLength
    case invalidTokenCharacters
    case tokenMismatch

    var errorDescription: String? {
        switch self {
        case .tailscaleMissing:
            "没有找到 Tailscale。请先安装并登录 Mac 版 Tailscale。"
        case .serveConflict:
            "Tailscale 443 端口已有其他 Serve 或 Funnel 配置；MathNotes 没有覆盖它。"
        case .invalidServeStatus:
            "Tailscale Serve 已运行，但返回了 MathNotes 无法确认的状态。"
        case .invalidTailnetAddress:
            "没有读取到可用的 Tailscale IPv4 地址。请确认 Mac 已登录并连接 Tailscale。"
        case let .commandFailed(detail):
            "Tailscale 命令执行失败：\(detail)"
        case .commandTimedOut:
            "Tailscale Serve 响应超时；MathNotes 没有继续修改网络。"
        case .invalidTokenLength:
            "配对令牌需要 16–128 个字符。"
        case .invalidTokenCharacters:
            "配对令牌只能包含英文字母、数字以及 . _ ~ -。"
        case .tokenMismatch:
            "两次输入的配对令牌不一致。"
        }
    }
}

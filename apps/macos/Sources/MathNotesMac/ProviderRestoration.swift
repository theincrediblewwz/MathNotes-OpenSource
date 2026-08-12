import Foundation

enum ProviderRestorationError: Equatable, Sendable {
    case missingCredential
    case rejected(sanitizedMessage: String)

    var errorDescription: String {
        switch self {
        case .missingCredential: "已保存的 API 密钥无法读取，请在 AI 服务设置中重新保存。"
        case let .rejected(sanitizedMessage): sanitizedMessage
        }
    }
}

enum ProviderRestoration {
    struct State: Equatable, Sendable {
        let status: RuntimeProviderStatus
        let error: ProviderRestorationError?
    }

    static func resolve(
        hasSavedRecord: Bool,
        savedKeyAvailable: Bool,
        remoteStatus: RuntimeProviderStatus,
        restoreFailureMessage: String?
    ) -> State {
        guard hasSavedRecord else {
            return State(status: remoteStatus, error: nil)
        }
        guard savedKeyAvailable else {
            return State(status: .unconfigured, error: .missingCredential)
        }
        if let restoreFailureMessage {
            return State(status: .unconfigured, error: .rejected(sanitizedMessage: restoreFailureMessage))
        }
        return State(status: remoteStatus, error: nil)
    }
}

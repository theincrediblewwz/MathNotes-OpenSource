import Foundation
import Security

enum KeychainCredentialError: LocalizedError {
    case invalidData
    case authorizationRequired
    case operationFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidData: "无法读取已保存的凭据。"
        case .authorizationRequired: "此版本尚未获准读取已保存的凭据。请在设置中主动授权读取，或重新输入凭据。"
        case let .operationFailed(status): "系统钥匙串操作失败（\(status)）。"
        }
    }
}

struct KeychainCredentialStore: Sendable {
    private static let interactionLock = NSLock()
    private let service: String

    init(service: String = "com.mathnotes.provider-api-key") {
        self.service = service
    }

    func read(account: String, allowInteraction: Bool = false) throws -> String? {
        try Self.withInteractionAllowed(allowInteraction) {
            try readItem(account: account, allowInteraction: allowInteraction)
        }
    }

    // kSecUseAuthenticationUI only covers modern access-control authentication;
    // the existing macOS login-keychain items also use legacy application ACLs.
    // This switch is process-local, serialized, and restored even after errors.
    // It never grants access: an ACL denial becomes an error in the app instead.
    static func withInteractionAllowed<T>(_ allowed: Bool, operation: () throws -> T) throws -> T {
        interactionLock.lock()
        defer { interactionLock.unlock() }
        var previous = DarwinBoolean(false)
        let getStatus = SecKeychainGetUserInteractionAllowed(&previous)
        guard getStatus == errSecSuccess else { throw KeychainCredentialError.operationFailed(getStatus) }
        let setStatus = SecKeychainSetUserInteractionAllowed(allowed)
        guard setStatus == errSecSuccess else { throw KeychainCredentialError.operationFailed(setStatus) }
        defer { SecKeychainSetUserInteractionAllowed(previous.boolValue) }
        return try operation()
    }

    private func readItem(account: String, allowInteraction: Bool) throws -> String? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            // Packaged development builds can have a different signing identity after
            // an update. Never turn a background read into a login-keychain prompt;
            // callers can instead ask the user to re-enter an unavailable secret.
            kSecUseAuthenticationUI as String: allowInteraction ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        if status == errSecInteractionNotAllowed || status == errSecAuthFailed {
            throw KeychainCredentialError.authorizationRequired
        }
        guard status == errSecSuccess else { throw KeychainCredentialError.operationFailed(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainCredentialError.invalidData
        }
        return value
    }

    func write(_ value: String, account: String) throws {
        try Self.withInteractionAllowed(true) { try writeItem(value, account: account) }
    }

    private func writeItem(_ value: String, account: String) throws {
        let data = Data(value.utf8)
        let query = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary
        let status = SecItemUpdate(query, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainCredentialError.operationFailed(status) }
        let addStatus = SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data
        ] as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainCredentialError.operationFailed(addStatus) }
    }

    func delete(account: String) throws {
        try Self.withInteractionAllowed(true) { try deleteItem(account: account) }
    }

    private func deleteItem(account: String) throws {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainCredentialError.operationFailed(status)
        }
    }
}

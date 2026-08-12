import Foundation
import Security

enum KeychainCredentialError: LocalizedError {
    case invalidData
    case operationFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidData: "无法读取已保存的识别服务密钥。"
        case let .operationFailed(status): "系统钥匙串操作失败（\(status)）。"
        }
    }
}

struct KeychainCredentialStore: Sendable {
    private let service: String

    init(service: String = "com.mathnotes.provider-api-key") {
        self.service = service
    }

    func read(account: String) throws -> String? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainCredentialError.operationFailed(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainCredentialError.invalidData
        }
        return value
    }

    func write(_ value: String, account: String) throws {
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

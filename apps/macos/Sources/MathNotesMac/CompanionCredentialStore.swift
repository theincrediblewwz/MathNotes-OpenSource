import CryptoKit
import Foundation

// Each saved host keeps its own Keychain item. The legacy item is bound to its
// original origin and is never repurposed when another host is added.
actor CompanionCredentialStore {
    static let shared = CompanionCredentialStore()
    private let keychain = KeychainCredentialStore(service: CompanionConnectionCredential.service)
    private var cachedToken: String?
    private var hostTokens: [String: String] = [:]
    private let legacyOriginKey = "mathnotes.companion.legacy-credential-origin.v1"

    func read(authorize: Bool = false) async throws -> String? {
        if let origin = CompanionConnectionPreferences.load()?.origin {
            return try await read(origin: origin, authorize: authorize)
        }
        if let cachedToken { return cachedToken }
        let keychain = keychain
        let token = try await Task.detached {
            try keychain.read(account: CompanionConnectionCredential.account, allowInteraction: authorize)
        }.value
        cachedToken = token
        return token
    }

    func read(origin: String, authorize: Bool = false) async throws -> String? {
        if let token = hostTokens[origin] { return token }
        let keychain = keychain
        let account = Self.account(origin)
        if let token = try await Task.detached(operation: {
            try keychain.read(account: account, allowInteraction: authorize)
        }).value {
            hostTokens[origin] = token
            return token
        }
        let legacyOrigin = UserDefaults.standard.string(forKey: legacyOriginKey)
            ?? CompanionConnectionPreferences.load()?.origin
        guard origin == legacyOrigin else { return nil }
        let token: String?
        if let cachedToken { token = cachedToken }
        else {
            token = try await Task.detached {
                try keychain.read(account: CompanionConnectionCredential.account, allowInteraction: authorize)
            }.value
        }
        if let token {
            cachedToken = token
            hostTokens[origin] = token
            UserDefaults.standard.set(origin, forKey: legacyOriginKey)
        }
        return token
    }

    func write(_ token: String, origin: String? = nil) async throws {
        let keychain = keychain
        if let origin {
            if UserDefaults.standard.string(forKey: legacyOriginKey) == nil,
               let previousOrigin = CompanionConnectionPreferences.load()?.origin {
                UserDefaults.standard.set(previousOrigin, forKey: legacyOriginKey)
            }
            let account = Self.account(origin)
            try await Task.detached { try keychain.write(token, account: account) }.value
            hostTokens[origin] = token
        } else {
            try await Task.detached { try keychain.write(token, account: CompanionConnectionCredential.account) }.value
            cachedToken = token
        }
    }

    func delete() async throws {
        let keychain = keychain
        if let origin = CompanionConnectionPreferences.load()?.origin {
            let account = Self.account(origin)
            try await Task.detached { try keychain.delete(account: account) }.value
            hostTokens[origin] = nil
            let legacyOrigin = UserDefaults.standard.string(forKey: legacyOriginKey) ?? origin
            guard origin == legacyOrigin else { return }
        }
        try await Task.detached { try keychain.delete(account: CompanionConnectionCredential.account) }.value
        cachedToken = nil
    }

    private static func account(_ origin: String) -> String {
        "host-" + SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

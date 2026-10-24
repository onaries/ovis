import CryptoKit
import Foundation
import Security

/// One phone's keys serve every PC; only the relay endpoint is PC-specific.
public struct PushKeys {
    public let privateKey: P256.KeyAgreement.PrivateKey
    public let auth: Data
    public var publicPoint: Data { privateKey.publicKey.x963Representation }

    public init(privateKey: P256.KeyAgreement.PrivateKey, auth: Data) {
        self.privateKey = privateKey
        self.auth = auth
    }

    public static func generate() throws -> PushKeys {
        var auth = Data(count: 16)
        let status = auth.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!)
        }
        guard status == errSecSuccess else { throw PushKeyStore.Failure.keychain(status) }
        return PushKeys(privateKey: P256.KeyAgreement.PrivateKey(), auth: auth)
    }
}

/// The extension can read after first unlock, but only the app creates keys.
public struct PushKeyStore {
    public enum Failure: Error {
        case keychain(OSStatus)
        case damaged
    }

    private let accessGroup: String

    public init(accessGroup: String) { self.accessGroup = accessGroup }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "sh.ovis.app.push",
            kSecAttrAccount as String: "keys",
            kSecAttrAccessGroup as String: accessGroup
        ]
    }

    public func read() throws -> PushKeys? {
        var query = query
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        guard let data = result as? Data, data.count == 48 else { throw Failure.damaged }
        return PushKeys(
            privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: data.prefix(32)),
            auth: Data(data.suffix(16))
        )
    }

    public func getOrCreate() throws -> PushKeys {
        if let keys = try read() { return keys }
        let keys = try PushKeys.generate()
        var query = query
        query[kSecValueData as String] = keys.privateKey.rawRepresentation + keys.auth
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem, let existing = try read() { return existing }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        return keys
    }
}

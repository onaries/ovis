import CryptoKit
import Foundation
import XCTest
@testable import OvisPushCore

final class WebPushDecryptTests: XCTestCase {
    private func b64(_ value: String) -> Data {
        let text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: text + String(repeating: "=", count: (4 - text.count % 4) % 4))!
    }

    private func keys() throws -> PushKeys {
        PushKeys(
            privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")),
            auth: b64("BTBZMqHH6r4Tts7J_aSIgg")
        )
    }

    private var message: Data {
        b64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")
        + b64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ")
    }

    func testOpensRFCExample() throws {
        let plain = try WebPushDecrypt.decrypt(message, keys: keys())
        XCTAssertEqual(String(data: plain, encoding: .utf8), "When I grow up, I want to be a watermelon")
    }

    func testRefusesChangedCiphertext() throws {
        var changed = message
        changed[changed.count - 1] ^= 1
        XCTAssertThrowsError(try WebPushDecrypt.decrypt(changed, keys: keys()))
    }

    func testRefusesOtherKeys() throws {
        let other = try PushKeys.generate()
        XCTAssertThrowsError(try WebPushDecrypt.decrypt(message, keys: other))
    }

    func testGeneratesMatchingHalves() throws {
        let a = try PushKeys.generate()
        let b = try PushKeys.generate()
        XCTAssertEqual(a.publicPoint.count, 65)
        XCTAssertEqual(a.auth.count, 16)
        let ab = try a.privateKey.sharedSecretFromKeyAgreement(with: b.privateKey.publicKey)
        let ba = try b.privateKey.sharedSecretFromKeyAgreement(with: a.privateKey.publicKey)
        XCTAssertEqual(ab, ba)
    }
}

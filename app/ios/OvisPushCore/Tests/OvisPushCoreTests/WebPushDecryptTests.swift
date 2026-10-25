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

    private func assertInvalid(_ message: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        let receiver = try keys()
        XCTAssertThrowsError(try WebPushDecrypt.decrypt(message, keys: receiver), file: file, line: line) {
            guard case WebPushDecrypt.Failure.invalidRecord = $0 else {
                return XCTFail("Expected record rejection, got \($0)", file: file, line: line)
            }
        }
    }

    func testRefusesTruncatedHeader() throws {
        let truncated = Data(message.prefix(20))
        try assertInvalid(truncated)
    }

    func testRefusesShortBody() throws {
        let truncated = Data(message.prefix(102))
        try assertInvalid(truncated)
    }

    func testRefusesWrongKeyIDLength() throws {
        var malformed = message
        malformed[20] = 64
        try assertInvalid(malformed)
    }

    func testRefusesCompressedPointMarker() throws {
        var malformed = message
        malformed[21] = 3
        try assertInvalid(malformed)
    }

    func testRefusesRecordLargerThanRS() throws {
        var malformed = message
        malformed.replaceSubrange(16..<20, with: [0, 0, 0, 18])
        try assertInvalid(malformed)
    }

    /// RFC 8291 appendix A's CEK and nonce let these fixtures authenticate successfully.
    private func sealed(_ padded: [UInt8], recordSize: UInt8 = 18) throws -> Data {
        let box = try AES.GCM.seal(Data(padded), using: SymmetricKey(data: b64("oIhVW04MRdy2XN9CiKLxTg")),
                                   nonce: AES.GCM.Nonce(data: b64("4h_95klXJ5E_qnoN")))
        var header = Data(message.prefix(86))
        header.replaceSubrange(16..<20, with: [0, 0, 0, recordSize])
        return header + box.ciphertext + box.tag
    }

    func testRefusesRSBelow18EvenForEmptyPayload() throws {
        let malformed = try sealed([2], recordSize: 17)
        try assertInvalid(malformed)
    }

    func testAcceptsMinimumRSAndZeroPadding() throws {
        let padded = try sealed([2, 0])
        XCTAssertEqual(try WebPushDecrypt.decrypt(padded, keys: keys()), Data())
    }

    func testRefusesNonFinalDelimiter() throws {
        let malformed = try sealed([1, 0])
        try assertInvalid(malformed)
    }

    func testRefusesMissingDelimiter() throws {
        let malformed = try sealed([0, 0])
        try assertInvalid(malformed)
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

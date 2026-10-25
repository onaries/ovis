package sh.ovis.push;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens a Web Push message (RFC 8291 over RFC 8188's aes128gcm), what a browser does with a push:
 * the PC encrypted it for this phone's keys, and the relay passed it on through FCM unread.
 */
final class WebPushDecrypt {
    /** salt (16), record size (4), key id length (1) and the sender's public key (65) */
    private static final int HEADER_BYTES = 86;
    private static final int TAG_BYTES = 16;

    private WebPushDecrypt() {}

    static byte[] decrypt(byte[] message, PushKeys keys) throws GeneralSecurityException {
        if (message.length < HEADER_BYTES + TAG_BYTES + 1) throw new GeneralSecurityException("too short for aes128gcm");
        ByteBuffer header = ByteBuffer.wrap(message);
        byte[] salt = new byte[16];
        header.get(salt);
        long recordSize = header.getInt() & 0xffffffffL;
        if (recordSize < 18) throw new GeneralSecurityException("record size must be at least 18");
        if ((header.get() & 0xff) != 65) throw new GeneralSecurityException("the key id is not a P-256 key");
        byte[] senderKey = new byte[65];
        header.get(senderKey);
        // server/push.ts sends one record (4096 bytes at most, the size it declares)
        if (message.length - HEADER_BYTES > recordSize) throw new GeneralSecurityException("more than one record");

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(keys.privateKey());
        agreement.doPhase(PushKeys.publicKey(senderKey), true);
        byte[] keyInfo = concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), keys.publicPoint, senderKey);
        byte[] ikm = expand(hmac(keys.auth, agreement.generateSecret()), keyInfo, 32);
        byte[] prk = hmac(salt, ikm);
        byte[] cek = expand(prk, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII), 16);
        byte[] nonce = expand(prk, "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII), 12);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(TAG_BYTES * 8, nonce));
        byte[] padded = cipher.doFinal(message, HEADER_BYTES, message.length - HEADER_BYTES);
        // the last record ends with the delimiter 2, then any zero padding
        int end = padded.length - 1;
        while (end >= 0 && padded[end] == 0) end--;
        if (end < 0 || padded[end] != 2) throw new GeneralSecurityException("not a final record");
        return Arrays.copyOf(padded, end);
    }

    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    /** HKDF-Expand (RFC 5869) for at most one block, which is all this needs. */
    private static byte[] expand(byte[] prk, byte[] info, int length) throws GeneralSecurityException {
        return Arrays.copyOf(hmac(prk, concat(info, new byte[] { 1 })), length);
    }

    private static byte[] concat(byte[]... parts) {
        int size = 0;
        for (byte[] part : parts) size += part.length;
        ByteBuffer joined = ByteBuffer.allocate(size);
        for (byte[] part : parts) joined.put(part);
        return joined.array();
    }
}

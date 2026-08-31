import { describe, it } from "node:test";
import assert from "node:assert";
import { encryptText, decryptText } from "../src/lib/crypto";

describe("AES-256-GCM Encryption at Rest", () => {
  it("should encrypt and decrypt plaintext correctly with correct passphrase", () => {
    const plain = "SuperSecretNoteContent123!@#";
    const passphrase = "my-strong-password";

    const encrypted = encryptText(plain, passphrase);

    assert.notStrictEqual(encrypted, plain);
    assert.strictEqual(encrypted.split(":").length, 4, "Payload format must be salt:iv:authTag:ciphertext");

    const decrypted = decryptText(encrypted, passphrase);
    assert.strictEqual(decrypted, plain);
  });

  it("should throw an error when decrypting with incorrect passphrase", () => {
    const plain = "Sensitive Information";
    const encrypted = encryptText(plain, "correct-pass");

    assert.throws(
      () => decryptText(encrypted, "wrong-pass"),
      (err: unknown) =>
        err instanceof Error &&
        "status" in err &&
        err.status === 400 &&
        err.message.includes("Decryption failed")
    );
  });

  it("should detect ciphertext tampering and fail authentication", () => {
    const plain = "Financial Report 2026";
    const encrypted = encryptText(plain, "master-key");
    const [salt, iv, authTag, ciphertext] = encrypted.split(":");

    // Tamper with one character of the ciphertext
    const tamperedCiphertext =
      ciphertext.slice(0, -2) + (ciphertext.endsWith("0") ? "1" : "0") + "a";
    const tamperedPayload = [salt, iv, authTag, tamperedCiphertext].join(":");

    assert.throws(
      () => decryptText(tamperedPayload, "master-key"),
      (err: unknown) =>
        err instanceof Error && "status" in err && err.status === 400
    );
  });
});

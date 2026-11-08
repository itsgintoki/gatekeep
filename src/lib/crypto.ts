// ============================================================================
// [Phase 2 — Core domain] src/lib/crypto.ts — NOTE ENCRYPTION
// See NAVIGATION.md Phase 2.2. WHAT: salt:iv:authTag:ciphertext (hex).
// WHY GCM: authTag fails closed on wrong key/tamper. WHY scrypt: memory-hard
// vs GPUs. DESIGN: random salt+IV per note; passphrase never stored.
// ----------------------------------------------------------------------------
// encryptText(plain, passphrase) -> "salt:iv:authTag:ciphertext" (hex).
// decryptText reverses it; wrong passphrase -> 400 (authTag check fails).
//
// CONCEPTS:
// - AES-256-GCM = authenticated encryption: the authTag proves the ciphertext
//   wasn't tampered with; tampering/wrong key fails at final() instead of
//   returning garbage.
// - scrypt(passphrase, random 16B salt) -> 32B key: a memory-hard KDF that
//   slows brute-force vs plain SHA-256. Random salt+IV per note means identical
//   plaintexts encrypt differently.
// - Server never stores the passphrase: if the user loses it, content is
//   unrecoverable (see decryptNote flow). The `salt:iv:tag:ct` string is all
//   that's persisted in notes.content with isEncrypted=true.
// ============================================================================
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const SALT_BYTES = 16; // scrypt salt: uniqueness per encryption.
const IV_BYTES = 12; // GCM nonce size (12B is the standard).
const KEY_BYTES = 32; // 256-bit key for AES-256.

export function encryptText(plainText: string, passphrase: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(passphrase, salt, KEY_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    salt.toString("hex"),
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

export function decryptText(payload: string, passphrase: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4) {
    throw Object.assign(new Error("Invalid encrypted payload format"), { status: 400 });
  }

  const [saltHex, ivHex, authTagHex, ciphertextHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const key = crypto.scryptSync(passphrase, salt, KEY_BYTES);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw Object.assign(new Error("Decryption failed. Invalid passphrase or corrupted data"), {
      status: 400,
    });
  }
}

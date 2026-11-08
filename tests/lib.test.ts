import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSlug, encodeBase62, decodeBase62 } from "../src/lib/base62";
import { encryptText, decryptText } from "../src/lib/crypto";
import { prepareNoteContent } from "../src/lib/noteContent";
import { validateRuntimeConfig } from "../src/lib/runtimeConfig";
import { parseUserAgent } from "../src/lib/userAgent";

describe("Base62 encoding and slug generation", () => {
  it("generates random alphanumeric 7-character slugs", () => {
    const slug1 = generateSlug(7);
    const slug2 = generateSlug(7);

    assert.strictEqual(slug1.length, 7);
    assert.strictEqual(slug2.length, 7);
    assert.notStrictEqual(slug1, slug2);
    assert.match(slug1, /^[0-9a-zA-Z]{7}$/);
  });

  it("bijectively encodes and decodes numbers without data loss", () => {
    const numbers = [0n, 1n, 61n, 62n, 123456789n, 9876543210123456789n];

    for (const num of numbers) {
      const encoded = encodeBase62(num);
      const decoded = decodeBase62(encoded);
      assert.strictEqual(decoded, num, `Failed roundtrip for ${num} -> ${encoded}`);
    }
  });
});

describe("AES-256-GCM encryption at rest", () => {
  it("encrypts and decrypts plaintext with the correct passphrase", () => {
    const plain = "SuperSecretNoteContent123!@#";
    const passphrase = "my-strong-password";

    const encrypted = encryptText(plain, passphrase);

    assert.notStrictEqual(encrypted, plain);
    assert.strictEqual(encrypted.split(":").length, 4, "Payload format must be salt:iv:authTag:ciphertext");

    const decrypted = decryptText(encrypted, passphrase);
    assert.strictEqual(decrypted, plain);
  });

  it("rejects the wrong passphrase", () => {
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

  it("detects ciphertext tampering and fails authentication", () => {
    const plain = "Financial Report 2026";
    const encrypted = encryptText(plain, "master-key");
    const [salt, iv, authTag, ciphertext] = encrypted.split(":");

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

describe("Note content encryption transitions", () => {
  it("updates metadata without re-encrypting existing ciphertext", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    const updated = prepareNoteContent(existing, {});

    assert.strictEqual(updated, existing);
    assert.strictEqual(decryptText(updated.content, "current-passphrase"), "secret");
  });

  it("rotates an encrypted note passphrase exactly once", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    const updated = prepareNoteContent(existing, {
      currentPassphrase: "current-passphrase",
      newPassphrase: "replacement-passphrase",
    });

    assert.strictEqual(updated.isEncrypted, true);
    assert.strictEqual(decryptText(updated.content, "replacement-passphrase"), "secret");
    assert.throws(() => decryptText(updated.content, "current-passphrase"));
  });

  it("can remove encryption after verifying the current passphrase", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    const updated = prepareNoteContent(existing, {
      currentPassphrase: "current-passphrase",
      newPassphrase: null,
    });

    assert.deepStrictEqual(updated, { content: "secret", isEncrypted: false });
  });

  it("requires the current passphrase before replacing encrypted content", () => {
    const existing = {
      content: encryptText("secret", "current-passphrase"),
      isEncrypted: true,
    };

    assert.throws(
      () => prepareNoteContent(existing, { content: "replacement" }),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 400
    );
  });

  it("can encrypt an existing plaintext note", () => {
    const updated = prepareNoteContent(
      { content: "plain", isEncrypted: false },
      { newPassphrase: "replacement-passphrase" }
    );

    assert.strictEqual(updated.isEncrypted, true);
    assert.strictEqual(decryptText(updated.content, "replacement-passphrase"), "plain");
  });
});

const CONFIG_KEYS = [
  "NODE_ENV",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "DATABASE_URL",
] as const;

function withRuntimeEnvironment(
  values: Partial<Record<(typeof CONFIG_KEYS)[number], string>>,
  assertion: () => void
): void {
  const previous = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, process.env[key]])
  );
  try {
    for (const key of CONFIG_KEYS) {
      const value = values[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    assertion();
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("Production runtime configuration", () => {
  it("rejects documented placeholder secrets", () => {
    withRuntimeEnvironment(
      {
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: "your_access_token_secret_here",
        JWT_REFRESH_SECRET: "your_refresh_token_secret_here",
        DATABASE_URL: "postgresql://app:random-password@database/app",
      },
      () => assert.throws(validateRuntimeConfig, /JWT_ACCESS_SECRET/)
    );
  });

  it("accepts strong production credentials", () => {
    withRuntimeEnvironment(
      {
        NODE_ENV: "production",
        JWT_ACCESS_SECRET: "a".repeat(48),
        JWT_REFRESH_SECRET: "b".repeat(48),
        DATABASE_URL: "postgresql://app:random-password@database/app",
      },
      () => assert.doesNotThrow(validateRuntimeConfig)
    );
  });
});

describe("User-agent parsing", () => {
  it("prioritizes Edge, Opera, Chrome, Mobile, and Bot tokens", () => {
    const edgeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    const edgeParsed = parseUserAgent(edgeUA);
    assert.strictEqual(edgeParsed.browser, "Microsoft Edge");
    assert.strictEqual(edgeParsed.os, "Windows 10/11");
    assert.strictEqual(edgeParsed.device, "desktop");

    const botUA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    const botParsed = parseUserAgent(botUA);
    assert.strictEqual(botParsed.device, "bot");
    assert.strictEqual(botParsed.browser, "Bot/Crawler");

    const iphoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const iphoneParsed = parseUserAgent(iphoneUA);
    assert.strictEqual(iphoneParsed.browser, "Apple Safari");
    assert.strictEqual(iphoneParsed.os, "iOS");
    assert.strictEqual(iphoneParsed.device, "mobile");
  });
});

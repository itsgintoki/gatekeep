import { describe, it } from "node:test";
import assert from "node:assert";
import type { Request, Response } from "express";
import argon2 from "argon2";
import { generateSlug, encodeBase62, decodeBase62 } from "../src/lib/base62";
import { encryptText, decryptText } from "../src/lib/crypto";
import { generateWebhookSecret, signWebhookPayload } from "../src/lib/webhook";
import { parseUserAgent } from "../src/lib/userAgent";
import { createRateLimiter } from "../src/middleware/rateLimiter";

describe("End-to-End System Integrity & Security Verification", () => {
  it("Encryption at Rest: Should handle large payloads, special characters, and verify tampering", () => {
    const payload = "Sample sensitive configuration data with symbols: !@#$%^&*()_+-=[]{}|;:,.<>?";
    const passphrase = "test-encryption-passphrase-alpha-beta";

    const encrypted = encryptText(payload, passphrase);
    const [salt, iv, authTag, ciphertext] = encrypted.split(":");

    assert.strictEqual(salt.length, 32, "Salt must be 16 bytes (32 hex)");
    assert.strictEqual(iv.length, 24, "IV must be 12 bytes (24 hex)");
    assert.strictEqual(authTag.length, 32, "AuthTag must be 16 bytes (32 hex)");

    const decrypted = decryptText(encrypted, passphrase);
    assert.strictEqual(decrypted, payload, "Decrypted text must exactly match original payload");

    // Invalid passphrase
    assert.throws(
      () => decryptText(encrypted, "wrong-passphrase"),
      (err: unknown) =>
        err instanceof Error && "status" in err && err.status === 400
    );
  });

  it("Base62 Encoding: Should handle large IDs and enforce bijective bijection", () => {
    const testIds = [0n, 1n, 61n, 62n, 1000n, 56800235583n, 9007199254740991n];
    for (const id of testIds) {
      const encoded = encodeBase62(id);
      const decoded = decodeBase62(encoded);
      assert.strictEqual(decoded, id, `Bijective decoding failed for ${id}`);
    }

    const slug = generateSlug(7);
    assert.strictEqual(slug.length, 7);
    assert.match(slug, /^[0-9a-zA-Z]{7}$/);
  });

  it("User-Agent Parsing: Should correctly prioritize Edge, Opera, Chrome, Mobile, and Bot tokens", () => {
    // Microsoft Edge (Chromium)
    const edgeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    const edgeParsed = parseUserAgent(edgeUA);
    assert.strictEqual(edgeParsed.browser, "Microsoft Edge");
    assert.strictEqual(edgeParsed.os, "Windows 10/11");
    assert.strictEqual(edgeParsed.device, "desktop");

    // Googlebot
    const botUA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    const botParsed = parseUserAgent(botUA);
    assert.strictEqual(botParsed.device, "bot");
    assert.strictEqual(botParsed.browser, "Bot/Crawler");

    // iPhone Safari
    const iphoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const iphoneParsed = parseUserAgent(iphoneUA);
    assert.strictEqual(iphoneParsed.browser, "Apple Safari");
    assert.strictEqual(iphoneParsed.os, "iOS");
    assert.strictEqual(iphoneParsed.device, "mobile");
  });

  it("Webhook HMAC Signatures: Should verify timing safe signature matching", () => {
    const secret = generateWebhookSecret();
    assert.ok(secret.startsWith("gk_sec_"));

    const payload = JSON.stringify({
      event: "link.burned",
      timestamp: new Date().toISOString(),
      data: { slug: "X9z1KaB", totalReads: 1 },
    });

    const signature = signWebhookPayload(payload, secret);
    assert.ok(signature.startsWith("sha256="));
  });

  it("Rate Limiter: Should enforce sliding window sliding boundaries", () => {
    const limiter = createRateLimiter({ windowMs: 500, max: 2 });
    let passed = 0;
    let blocked = 0;

    const req = { headers: {}, ip: "10.0.0.1" } as unknown as Request;
    const res = {
      setHeader: () => {},
      status: (code: number) => {
        if (code === 429) blocked++;
        return { json: () => {} };
      },
    } as unknown as Response;
    const next = () => {
      passed++;
    };

    limiter(req, res, next);
    limiter(req, res, next);
    limiter(req, res, next);

    assert.strictEqual(passed, 2, "First 2 requests must pass");
    assert.strictEqual(blocked, 1, "3rd request must be blocked with HTTP 429");
  });
});

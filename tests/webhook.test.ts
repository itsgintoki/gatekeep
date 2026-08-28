import { describe, it } from "node:test";
import assert from "node:assert";
import crypto from "crypto";
import { generateWebhookSecret, signWebhookPayload } from "../src/lib/webhook";

describe("Webhook HMAC-SHA256 Signatures", () => {
  it("should generate a 32-byte hex secret with whsec_ prefix", () => {
    const secret = generateWebhookSecret();
    assert.ok(secret.startsWith("whsec_"), "Secret must start with whsec_");
    assert.strictEqual(secret.length, 6 + 64, "Secret must be 6-char prefix + 64-char hex");
  });

  it("should generate valid sha256 signature format matching receiver expectations", () => {
    const secret = "whsec_testsecret1234567890abcdef1234567890abcdef";
    const payload = JSON.stringify({
      event: "link.accessed",
      timestamp: "2026-08-28T12:00:00.000Z",
      data: { slug: "aB3xK9z", readsCount: 1 },
    });

    const signatureHeader = signWebhookPayload(payload, secret);
    assert.ok(signatureHeader.startsWith("sha256="), "Signature must start with sha256=");

    // Verify manually
    const expectedHash = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    assert.strictEqual(signatureHeader, `sha256=${expectedHash}`);
  });
});

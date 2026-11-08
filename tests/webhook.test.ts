import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateWebhookSecret, signWebhookPayload } from "../src/lib/webhook";
import { assertSafeWebhookUrl } from "../src/lib/webhookHttp";

describe("Webhook HMAC-SHA256 signatures", () => {
  it("generates a 32-byte hex secret with the gk_sec_ prefix", () => {
    const secret = generateWebhookSecret();
    assert.ok(secret.startsWith("gk_sec_"), "Secret must start with gk_sec_");
    assert.strictEqual(secret.length, 7 + 64, "Secret must be 7-char prefix + 64-char hex");
  });

  it("generates a sha256 signature matching receiver expectations", () => {
    const secret = generateWebhookSecret();
    const payload = JSON.stringify({
      event: "link.accessed",
      timestamp: "2026-08-28T12:00:00.000Z",
      data: { slug: "aB3xK9z", readsCount: 1 },
    });

    const signatureHeader = signWebhookPayload(payload, secret);
    assert.ok(signatureHeader.startsWith("sha256="), "Signature must start with sha256=");

    const expectedHash = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    assert.strictEqual(signatureHeader, `sha256=${expectedHash}`);
  });
});

describe("Webhook destination validation", () => {
  it("requires HTTPS", async () => {
    await assert.rejects(
      assertSafeWebhookUrl("http://example.com/webhook"),
      /must use HTTPS/
    );
  });

  it("rejects loopback and cloud metadata destinations", async () => {
    await assert.rejects(
      assertSafeWebhookUrl("https://127.0.0.1/webhook"),
      /private or reserved/
    );
    await assert.rejects(
      assertSafeWebhookUrl("https://169.254.169.254/latest/meta-data"),
      /private or reserved/
    );
  });

  it("rejects embedded credentials", async () => {
    await assert.rejects(
      assertSafeWebhookUrl("https://user:password@example.com/webhook"),
      /cannot contain credentials/
    );
  });
});

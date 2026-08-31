import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSafeWebhookUrl } from "../src/lib/webhookHttp";

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

import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { webhooks } from "../db/schema";

export interface WebhookPayload {
  event: "link.accessed" | "link.burned";
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Generates a cryptographically secure 32-byte hex secret prefixed with 'whsec_'
 */
export function generateWebhookSecret(): string {
  return "whsec_" + crypto.randomBytes(32).toString("hex");
}

/**
 * Computes an HMAC-SHA256 signature for the given payload string and secret.
 * Format: sha256=<hex_digest> (industry standard matching Stripe / GitHub)
 */
export function signWebhookPayload(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Dispatches an outbound webhook event with HMAC-SHA256 signature and exponential backoff retry.
 * Non-blocking fire-and-forget execution.
 */
export async function dispatchWebhook(
  webhookId: string,
  event: "link.accessed" | "link.burned",
  data: Record<string, unknown>
): Promise<void> {
  try {
    const webhook = await db.query.webhooks.findFirst({
      where: eq(webhooks.id, webhookId),
    });

    if (!webhook) return;

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const payloadString = JSON.stringify(payload);
    const signature = signWebhookPayload(payloadString, webhook.secret);

    await sendWithRetry(webhook.url, payloadString, signature, event);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook] Dispatch failed for webhookId ${webhookId}:`, msg);
  }
}

/**
 * Helper to deliver the HTTP POST with up to 3 attempts (exponential backoff: 500ms, 1000ms).
 */
async function sendWithRetry(
  url: string,
  body: string,
  signature: string,
  event: string,
  maxAttempts: number = 3
): Promise<void> {
  let attempt = 1;
  let delayMs = 500;

  while (attempt <= maxAttempts) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GateKeep-Signature-256": signature,
          "X-GateKeep-Event": event,
          "User-Agent": "GateKeep-Webhook-Dispatcher/1.0",
        },
        body,
        signal: AbortSignal.timeout(5000), // 5-second timeout per attempt
      });

      if (response.ok) {
        return; // Success
      }

      console.warn(
        `[Webhook] Attempt ${attempt}/${maxAttempts} to ${url} returned HTTP ${response.status}`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Webhook] Attempt ${attempt}/${maxAttempts} to ${url} failed:`,
        msg
      );
    }

    if (attempt < maxAttempts) {
      await new Promise((res) => setTimeout(res, delayMs));
      delayMs *= 2; // Exponential backoff: 500ms -> 1000ms -> 2000ms
    }
    attempt++;
  }

  console.error(`[Webhook] Delivery permanently failed after ${maxAttempts} attempts for ${url}`);
}

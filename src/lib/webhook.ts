import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { webhookDeliveries, webhooks } from "../db/schema";
import { postWebhook } from "./webhookHttp";

export type WebhookEvent = "link.accessed" | "link.burned";

export interface WebhookPayload extends Record<string, unknown> {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, unknown>;
}

interface ClaimedDelivery extends Record<string, unknown> {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  payload: WebhookPayload;
  attempts: number;
}

const MAX_DELIVERY_ATTEMPTS = 5;

export function generateWebhookSecret(): string {
  return "gk_sec_" + crypto.randomBytes(32).toString("hex");
}

export function signWebhookPayload(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

async function claimWebhookDeliveries(limit: number): Promise<ClaimedDelivery[]> {
  const result = await db.execute<ClaimedDelivery>(sql`
    WITH candidates AS (
      SELECT id
      FROM webhook_deliveries
      WHERE delivered_at IS NULL
        AND failed_at IS NULL
        AND next_attempt_at <= NOW()
        AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '5 minutes')
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE webhook_deliveries AS deliveries
    SET locked_at = NOW(), attempts = deliveries.attempts + 1
    FROM candidates
    WHERE deliveries.id = candidates.id
    RETURNING
      deliveries.id,
      deliveries.webhook_id AS "webhookId",
      deliveries.event,
      deliveries.payload,
      deliveries.attempts
  `);
  return result.rows;
}

async function recordDeliveryFailure(delivery: ClaimedDelivery, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
    await db
      .update(webhookDeliveries)
      .set({ failedAt: new Date(), lockedAt: null, lastError: message })
      .where(eq(webhookDeliveries.id, delivery.id));
    return;
  }

  const retryDelayMs = Math.min(60_000, 500 * 2 ** (delivery.attempts - 1));
  await db
    .update(webhookDeliveries)
    .set({
      nextAttemptAt: new Date(Date.now() + retryDelayMs),
      lockedAt: null,
      lastError: message,
    })
    .where(eq(webhookDeliveries.id, delivery.id));
}

async function deliverClaimedWebhook(delivery: ClaimedDelivery): Promise<void> {
  try {
    const webhook = await db.query.webhooks.findFirst({
      where: eq(webhooks.id, delivery.webhookId),
      columns: { url: true, secret: true },
    });
    if (!webhook) {
      throw new Error("Webhook no longer exists");
    }

    const body = JSON.stringify(delivery.payload);
    const signature = signWebhookPayload(body, webhook.secret);
    const status = await postWebhook(webhook.url, body, {
      "Content-Type": "application/json",
      "X-GateKeep-Signature-256": signature,
      "X-GateKeep-Event": delivery.event,
      "User-Agent": "GateKeep-Webhook-Dispatcher/1.0",
    });
    if (status < 200 || status >= 300) {
      throw new Error(`Webhook returned HTTP ${status}`);
    }

    await db
      .update(webhookDeliveries)
      .set({ deliveredAt: new Date(), lockedAt: null, lastError: null })
      .where(eq(webhookDeliveries.id, delivery.id));
  } catch (error: unknown) {
    await recordDeliveryFailure(delivery, error);
  }
}

export async function processWebhookDeliveries(limit = 20): Promise<number> {
  const deliveries = await claimWebhookDeliveries(limit);
  await Promise.all(deliveries.map(deliverClaimedWebhook));
  return deliveries.length;
}

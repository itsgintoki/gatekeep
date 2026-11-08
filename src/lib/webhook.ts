// ============================================================================
// [Phase 3 — Hardening] src/lib/webhook.ts — OUTBOX DISPATCHER
// See NAVIGATION.md Phase 3.1. WHAT: claim (SKIP LOCKED) → HMAC POST → ack.
// WHY Postgres-as-queue: no extra infra, survives restarts. WHY backoff 5×:
// transient failures heal; dead-letter after 5 for audit. DESIGN: multi-worker
// safe via lockedAt + attempts++ in one CTE.
// ----------------------------------------------------------------------------
// Called every second from index.ts. Implements reliable delivery without
// a message queue (Postgres as queue):
//   claimWebhookDeliveries: single SQL CTE claims up to `limit` due rows
//     with FOR UPDATE SKIP LOCKED (multi-instance safe: two workers never
//     grab the same row; stale locks >5min are reclaimable after crash).
//     Claiming also does attempts++ atomically.
//   deliverClaimedWebhook: loads webhook url+secret, HMAC-signs JSON body
//     (X-GateKeep-Signature-256, verifiable by receiver), POSTs via
//     lib/webhookHttp.ts, marks deliveredAt on 2xx.
//   recordDeliveryFailure: exponential backoff 0.5s,1s,2s,4s,8s (capped 60s)
//     up to MAX_DELIVERY_ATTEMPTS=5, then failedAt (dead-letter, kept for audit).
// Queued from resolve.service.ts consumeLink (link.accessed / link.burned).
// ============================================================================
import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { webhookDeliveries, webhooks } from "../db/schema";
import { postWebhook } from "./webhookHttp";

// Events a receiver can subscribe to (stored in deliveries.event).
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

// How many POST attempts before giving up (then failedAt is set).
const MAX_DELIVERY_ATTEMPTS = 5;

// Prefix helps users recognise the secret in dashboards (like sk_/ghp_).
export function generateWebhookSecret(): string {
  return "gk_sec_" + crypto.randomBytes(32).toString("hex");
}

// HMAC-SHA256 over the exact JSON body. Receiver recomputes with the shared
// secret and compares (timing-safe) to prove GateKeep sent it untampered.
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

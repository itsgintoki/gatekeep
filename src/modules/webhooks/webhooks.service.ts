// ============================================================================
// [Phase 3 — Hardening] src/modules/webhooks/webhooks.service.ts — REGISTRY
// See NAVIGATION.md Phase 3.1. WHAT: SSRF-gate → mint gk_sec_ → store.
// WHY gate before insert: fail closed. WHY list omits secret: logs safe.
// DESIGN: delete SET NULLs links (links survive, go quiet).
// ----------------------------------------------------------------------------
// createWebhook: SSRF-gate (assertSafeWebhookUrl DNS-resolves + rejects
//   private IPs) BEFORE insert — fail closed, never store a dangerous URL.
//   Then mints a gk_sec_ secret (used for HMAC signing, see lib/webhook.ts).
// listWebhooks: deliberately OMITS secret (list responses get logged/cached;
//   fetch single webhook when you need the secret).
// get/delete: ownership-scoped (userId) -> 404 otherwise. Delete cascades to
//   deliveries but SET NULLs links.webhookId (links survive, just go quiet).
// ============================================================================
import { and, eq, desc } from "drizzle-orm";
import { db } from "../../db/index";
import { webhooks } from "../../db/schema";
import { generateWebhookSecret } from "../../lib/webhook";
import { assertSafeWebhookUrl } from "../../lib/webhookHttp";
import type { CreateWebhookInput } from "./webhooks.validation";

export async function createWebhook(userId: string, data: CreateWebhookInput) {
  await assertSafeWebhookUrl(data.url);
  const secret = generateWebhookSecret();

  const [webhook] = await db
    .insert(webhooks)
    .values({
      userId,
      url: data.url,
      secret,
    })
    .returning();

  return {
    id: webhook.id,
    url: webhook.url,
    secret: webhook.secret,
    createdAt: webhook.createdAt,
  };
}

export async function listWebhooks(userId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const rows = await db.query.webhooks.findMany({
    where: eq(webhooks.userId, userId),
    orderBy: desc(webhooks.createdAt),
    limit,
    offset,
    columns: {
      id: true,
      url: true,
      createdAt: true,
    },
  });

  return rows;
}

export async function getWebhook(webhookId: string, userId: string) {
  const webhook = await db.query.webhooks.findFirst({
    where: and(eq(webhooks.id, webhookId), eq(webhooks.userId, userId)),
  });

  if (!webhook) {
    throw Object.assign(new Error("Webhook not found"), { status: 404 });
  }

  return {
    id: webhook.id,
    url: webhook.url,
    secret: webhook.secret,
    createdAt: webhook.createdAt,
  };
}

export async function deleteWebhook(webhookId: string, userId: string) {
  const webhook = await db.query.webhooks.findFirst({
    where: and(eq(webhooks.id, webhookId), eq(webhooks.userId, userId)),
    columns: { id: true },
  });

  if (!webhook) {
    throw Object.assign(new Error("Webhook not found"), { status: 404 });
  }

  await db.delete(webhooks).where(eq(webhooks.id, webhookId));
}

// ============================================================================
// [Phase 2 — Core domain] src/modules/resolve/resolve.service.ts — BURN ENGINE
// See NAVIGATION.md Phase 2.4. WHAT: atomic read-count + burn + log + outbox.
// WHY conditional UPDATE...RETURNING: concurrent clicks → exactly one winner.
// WHY decrypt-before-consume: typo must not burn a 1-read link.
// DESIGN: GET probes free, POST spends; 404 unknown vs 410 gone.
// ----------------------------------------------------------------------------
// Read this file to understand GateKeep's core guarantee: a maxReads=1 link
// dies after exactly one successful view, even under concurrent clicks.
// How:
//  loadAvailableLink: fetches link+note, rejects burned (410), lazily burns
//    expired links (sets isBurned on first sighting after expiresAt).
//  resolveLink: (1) link passphrase via argon2.verify — missing -> return
//    {requiresPassphrase:true} WITHOUT spending a read; wrong -> 401.
//    (2) decrypt note content IN MEMORY first — a bad notePassphrase throws
//    BEFORE consumeLink, so typos never burn a one-read link. (3) sign
//    attachment URLs (4) consumeLink.
//  consumeLink (the critical transaction): ONE db.transaction does
//    UPDATE links SET readsCount+1, isBurned=CASE(reads>=maxReads) WHERE
//    not-burned AND not-expired AND reads<maxReads RETURNING — the WHERE
//    makes concurrent second clicks match 0 rows -> 410. Then INSERTs the
//    accessLogs row (with parsed UA + referrerHost) and queues
//    link.accessed (+ link.burned if it just died) into webhook_deliveries
//    for the background worker. All-or-nothing: a failed insert rolls back
//    the counter increment.
// Discriminated union ResolveResult (requiresPassphrase true/false) lets the
// frontend narrow types safely.
// ============================================================================
import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index";
import { accessLogs, links, webhookDeliveries, type Link } from "../../db/schema";
import { parseUserAgent } from "../../lib/userAgent";
import { decryptText } from "../../lib/crypto";
import { createSignedUrl } from "../../lib/storage";
import type { WebhookEvent, WebhookPayload } from "../../lib/webhook";

interface AccessContext {
  ip: string;
  userAgent?: string;
  referrer?: string;
}

interface LinkedNote {
  title: string;
  content: string;
  isEncrypted: boolean;
  deletedAt: Date | null;
  attachments: Array<{ id: string; storagePath: string; originalName: string; mimeType: string; sizeBytes: number }>;
}

interface AvailableLink extends Link {
  note: LinkedNote;
}

interface PassphraseChallenge {
  requiresPassphrase: true;
  slug: string;
}

interface ResolvedContent {
  requiresPassphrase: false;
  title: string;
  content: string;
  isEncrypted: boolean;
  isBurned: boolean;
  readsCount: number;
  maxReads: number | null;
  attachments: Array<{ id: string; url: string; originalName: string; mimeType: string; sizeBytes: number }>;
}

export interface LinkInspection {
  slug: string;
  requiresPassphrase: boolean;
  isEncrypted?: true;
}

export type ResolveResult = PassphraseChallenge | ResolvedContent;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

async function loadAvailableLink(slug: string): Promise<AvailableLink> {
  const link = await db.query.links.findFirst({
    where: eq(links.slug, slug),
    with: {
      note: {
        with: { attachments: { columns: { id: true, storagePath: true, originalName: true, mimeType: true, sizeBytes: true } } },
        columns: {
          title: true,
          content: true,
          isEncrypted: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!link || !link.note || link.note.deletedAt !== null) {
    throw httpError(404, "Link not found"); // Unknown slug OR soft-deleted note — same response.
  }
  if (link.isBurned) {
    throw httpError(410, "This link has been burned and is no longer accessible"); // 410 Gone: was valid, now dead.
  }
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    // Lazy expiry: flip to burned on first access after deadline (no cron needed).
    await db
      .update(links)
      .set({ isBurned: true })
      .where(and(eq(links.id, link.id), eq(links.isBurned, false)));
    throw httpError(410, "This link has expired");
  }

  return { ...link, note: link.note };
}

// Normalises Referer header to just the hostname for GROUP BY analytics
// (full URLs would fragment counts; unparsable values kept, truncated).
function extractReferrerHost(referrer: string | undefined): string | null {
  if (!referrer) {
    return null;
  }
  try {
    return new URL(referrer).hostname || referrer.slice(0, 255);
  } catch {
    return referrer.slice(0, 255);
  }
}

// Shapes the outbox payload: {event, timestamp, data}. The worker in
// lib/webhook.ts JSON-stringifies + HMAC-signs this exact object.
function createDelivery(
  webhookId: string,
  event: WebhookEvent,
  data: Record<string, unknown>
) {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  return { webhookId, event, payload };
}

async function consumeLink(link: AvailableLink, ctx: AccessContext) {
  const parsedUserAgent = parseUserAgent(ctx.userAgent); // Pre-parse for analytics columns.

  // ATOMIC SECTION: counter + burn flag + log + outbox succeed or all roll back.
  return db.transaction(async (tx) => {
    // Conditional UPDATE = compare-and-swap: only a live link matches; the
    // RETURNING row proves THIS request won the race. Losers get 0 rows -> 410.
    const [updatedLink] = await tx
      .update(links)
      .set({
        readsCount: sql`${links.readsCount} + 1`,
        isBurned: sql`
          CASE
            WHEN ${links.maxReads} IS NOT NULL
              AND ${links.readsCount} + 1 >= ${links.maxReads}
            THEN true
            ELSE ${links.isBurned}
          END
        `,
      })
      .where(
        and(
          eq(links.id, link.id),
          eq(links.isBurned, false),
          sql`(${links.expiresAt} IS NULL OR ${links.expiresAt} > NOW())`,
          sql`(${links.maxReads} IS NULL OR ${links.readsCount} < ${links.maxReads})`
        )
      )
      .returning();

    if (!updatedLink) {
      throw httpError(410, "This link is no longer accessible");
    }

    await tx.insert(accessLogs).values({
      linkId: link.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent ?? null,
      referrer: ctx.referrer ?? null,
      browser: parsedUserAgent.browser,
      os: parsedUserAgent.os,
      device: parsedUserAgent.device,
      referrerHost: extractReferrerHost(ctx.referrer),
    });

    if (link.webhookId) {
      const deliveries = [
        createDelivery(link.webhookId, "link.accessed", {
          linkId: link.id,
          slug: link.slug,
          readsCount: updatedLink.readsCount,
          maxReads: updatedLink.maxReads,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          referrer: ctx.referrer,
        }),
      ];
      if (updatedLink.isBurned) {
        deliveries.push(
          createDelivery(link.webhookId, "link.burned", {
            linkId: link.id,
            slug: link.slug,
            totalReads: updatedLink.readsCount,
          })
        );
      }
      await tx.insert(webhookDeliveries).values(deliveries);
    }

    return updatedLink;
  });
}

export async function inspectLink(slug: string): Promise<LinkInspection> {
  const link = await loadAvailableLink(slug);
  return {
    slug: link.slug,
    requiresPassphrase: Boolean(link.passphraseHash),
    ...(link.note.isEncrypted ? { isEncrypted: true as const } : {}),
  };
}

export async function resolveLink(
  slug: string,
  passphrase: string | undefined,
  ctx: AccessContext,
  notePassphrase?: string
): Promise<ResolveResult> {
  const link = await loadAvailableLink(slug);
  if (link.passphraseHash) {
    if (!passphrase) {
      return { requiresPassphrase: true, slug }; // Challenge, don't count a read.
    }
    if (!(await argon2.verify(link.passphraseHash, passphrase))) {
      throw httpError(401, "Invalid passphrase"); // Wrong secret: no read spent.
    }
  }

  // Verify decryption before spending a read, especially for one-read links.
  // If note is encrypted but no notePassphrase supplied, content stays
  // ciphertext (isEncrypted:true signals the UI to ask for it next).
  const decrypt = link.note.isEncrypted && notePassphrase !== undefined;
  const content = decrypt ? decryptText(link.note.content, notePassphrase) : link.note.content;
  const signedAttachments = await Promise.all(link.note.attachments.map(async ({ storagePath, ...attachment }) => ({
    ...attachment,
    url: await createSignedUrl(storagePath),
  })));
  const updatedLink = await consumeLink(link, ctx);
  return {
    requiresPassphrase: false,
    title: link.note.title,
    content,
    isEncrypted: link.note.isEncrypted && !decrypt,
    isBurned: updatedLink.isBurned,
    readsCount: updatedLink.readsCount,
    maxReads: updatedLink.maxReads,
    attachments: signedAttachments,
  };
}

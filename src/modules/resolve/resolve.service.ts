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
    throw httpError(404, "Link not found");
  }
  if (link.isBurned) {
    throw httpError(410, "This link has been burned and is no longer accessible");
  }
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    await db
      .update(links)
      .set({ isBurned: true })
      .where(and(eq(links.id, link.id), eq(links.isBurned, false)));
    throw httpError(410, "This link has expired");
  }

  return { ...link, note: link.note };
}

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
  const parsedUserAgent = parseUserAgent(ctx.userAgent);

  return db.transaction(async (tx) => {
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
      return { requiresPassphrase: true, slug };
    }
    if (!(await argon2.verify(link.passphraseHash, passphrase))) {
      throw httpError(401, "Invalid passphrase");
    }
  }

  // Verify decryption before spending a read, especially for one-read links.
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

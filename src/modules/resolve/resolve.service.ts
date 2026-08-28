import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index";
import { links, accessLogs } from "../../db/schema";
import { dispatchWebhook } from "../../lib/webhook";

interface AccessContext {
  ip: string;
  userAgent?: string;
  referrer?: string;
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
}

export type ResolveResult = PassphraseChallenge | ResolvedContent;

export async function resolveLink(
  slug: string,
  passphrase: string | undefined,
  ctx: AccessContext
): Promise<ResolveResult> {
  // Gate 1: Existence & Soft-Delete Check
  const link = await db.query.links.findFirst({
    where: eq(links.slug, slug),
    with: {
      note: {
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
    throw Object.assign(new Error("Link not found"), { status: 404 });
  }

  const note = link.note;

  // Gate 2: Burn Check
  if (link.isBurned) {
    throw Object.assign(
      new Error("This link has been burned and is no longer accessible"),
      { status: 410 }
    );
  }

  // Gate 3: Expiration Check & Lazy Cleanup
  if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
    await db
      .update(links)
      .set({ isBurned: true })
      .where(eq(links.id, link.id));

    throw Object.assign(new Error("This link has expired"), { status: 410 });
  }

  // Gate 4: Passphrase Verification
  if (link.passphraseHash) {
    if (!passphrase) {
      return { requiresPassphrase: true, slug };
    }

    const isValid = await argon2.verify(link.passphraseHash, passphrase);
    if (!isValid) {
      throw Object.assign(new Error("Invalid passphrase"), { status: 401 });
    }
  }

  // Gate 5: Atomic Read Increment + Auto-Burn
  const [updatedLink] = await db
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
        eq(links.isBurned, false)
      )
    )
    .returning();

  if (!updatedLink) {
    throw Object.assign(
      new Error("This link has been burned and is no longer accessible"),
      { status: 410 }
    );
  }

  // Access Logging (Fire-and-Forget)
  logAccess(link.id, ctx).catch((err) => {
    console.error("[resolve] Failed to log access:", err.message);
  });

  // Outbound Webhook Dispatch (Fire-and-Forget)
  if (link.webhookId) {
    const webhookId = link.webhookId;
    dispatchWebhook(webhookId, "link.accessed", {
      linkId: link.id,
      slug: link.slug,
      readsCount: updatedLink.readsCount,
      maxReads: updatedLink.maxReads,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      referrer: ctx.referrer,
    }).catch((err) => {
      console.error("[resolve] Failed to dispatch webhook:", err.message);
    });

    if (updatedLink.isBurned) {
      dispatchWebhook(webhookId, "link.burned", {
        linkId: link.id,
        slug: link.slug,
        totalReads: updatedLink.readsCount,
      }).catch((err) => {
        console.error("[resolve] Failed to dispatch burn webhook:", err.message);
      });
    }
  }

  return {
    requiresPassphrase: false,
    title: note.title,
    content: note.content,
    isEncrypted: note.isEncrypted,
    isBurned: updatedLink.isBurned,
    readsCount: updatedLink.readsCount,
    maxReads: updatedLink.maxReads,
  };
}

async function logAccess(linkId: string, ctx: AccessContext): Promise<void> {
  await db.insert(accessLogs).values({
    linkId,
    ip: ctx.ip,
    userAgent: ctx.userAgent ?? null,
    referrer: ctx.referrer ?? null,
  });
}

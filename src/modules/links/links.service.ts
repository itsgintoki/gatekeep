import argon2 from "argon2";
import { and, eq, isNull, desc, inArray } from "drizzle-orm";
import { db } from "../../db/index";
import { links, notes, accessLogs } from "../../db/schema";
import { generateSlug } from "../../lib/base62";
import { parseUserAgent } from "../../lib/userAgent";
import type { CreateLinkInput } from "./links.validation";

const ARGON2_OPTIONS = {
  type: 2 as const,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

export async function createLink(userId: string, data: CreateLinkInput) {
  const note = await db.query.notes.findFirst({
    where: and(
      eq(notes.id, data.noteId),
      eq(notes.userId, userId),
      isNull(notes.deletedAt)
    ),
    columns: { id: true },
  });

  if (!note) {
    throw Object.assign(new Error("Note not found"), { status: 404 });
  }

  let passphraseHash: string | null = null;
  if (data.passphrase) {
    passphraseHash = await argon2.hash(data.passphrase, ARGON2_OPTIONS);
  }

  let slug = "";
  let attempts = 0;
  while (attempts < 5) {
    slug = generateSlug(7);
    const existing = await db.query.links.findFirst({
      where: eq(links.slug, slug),
      columns: { id: true },
    });
    if (!existing) break;
    attempts++;
  }

  const [link] = await db
    .insert(links)
    .values({
      noteId: data.noteId,
      slug,
      passphraseHash,
      expiresAt: data.expiresAt ?? null,
      maxReads: data.maxReads ?? null,
      webhookId: data.webhookId ?? null,
    })
    .returning();

  return {
    id: link.id,
    noteId: link.noteId,
    slug: link.slug,
    hasPassphrase: Boolean(link.passphraseHash),
    expiresAt: link.expiresAt,
    maxReads: link.maxReads,
    readsCount: link.readsCount,
    isBurned: link.isBurned,
    webhookId: link.webhookId,
    createdAt: link.createdAt,
  };
}

export async function listLinks(userId: string, page: number, limit: number) {
  const offset = (page - 1) * limit;

  const userNotes = await db.query.notes.findMany({
    where: and(eq(notes.userId, userId), isNull(notes.deletedAt)),
    columns: { id: true, title: true },
  });

  if (userNotes.length === 0) {
    return [];
  }

  const noteIds = userNotes.map((n) => n.id);
  const noteTitleMap = new Map(userNotes.map((n) => [n.id, n.title]));

  const rows = await db.query.links.findMany({
    where: inArray(links.noteId, noteIds),
    orderBy: desc(links.createdAt),
    limit,
    offset,
  });

  return rows.map((l) => ({
    id: l.id,
    noteId: l.noteId,
    noteTitle: noteTitleMap.get(l.noteId),
    slug: l.slug,
    hasPassphrase: Boolean(l.passphraseHash),
    expiresAt: l.expiresAt,
    maxReads: l.maxReads,
    readsCount: l.readsCount,
    isBurned: l.isBurned,
    webhookId: l.webhookId,
    createdAt: l.createdAt,
  }));
}

export async function getLink(linkId: string, userId: string) {
  const link = await db.query.links.findFirst({
    where: eq(links.id, linkId),
    with: {
      note: {
        columns: { id: true, userId: true, title: true, isEncrypted: true, deletedAt: true },
      },
    },
  });

  if (!link || !link.note || link.note.userId !== userId || link.note.deletedAt !== null) {
    throw Object.assign(new Error("Link not found"), { status: 404 });
  }

  return {
    id: link.id,
    noteId: link.noteId,
    noteTitle: link.note.title,
    isNoteEncrypted: link.note.isEncrypted,
    slug: link.slug,
    hasPassphrase: Boolean(link.passphraseHash),
    expiresAt: link.expiresAt,
    maxReads: link.maxReads,
    readsCount: link.readsCount,
    isBurned: link.isBurned,
    webhookId: link.webhookId,
    createdAt: link.createdAt,
  };
}

export async function deleteLink(linkId: string, userId: string) {
  const link = await db.query.links.findFirst({
    where: eq(links.id, linkId),
    with: {
      note: {
        columns: { userId: true },
      },
    },
  });

  if (!link || !link.note || link.note.userId !== userId) {
    throw Object.assign(new Error("Link not found"), { status: 404 });
  }

  await db.delete(links).where(eq(links.id, linkId));
}

/**
 * Retrieve aggregated analytics for a specific link.
 * Leverages the compound index (link_id, accessed_at) for zero-sort retrieval.
 */
export async function getLinkAnalytics(linkId: string, userId: string) {
  // 1. Verify link exists and requester owns the parent note
  const link = await db.query.links.findFirst({
    where: eq(links.id, linkId),
    with: {
      note: {
        columns: { userId: true, title: true, deletedAt: true },
      },
    },
  });

  if (!link || !link.note || link.note.userId !== userId || link.note.deletedAt !== null) {
    throw Object.assign(new Error("Link not found"), { status: 404 });
  }

  // 2. Fetch all access logs for this link leveraging the compound index
  const logs = await db.query.accessLogs.findMany({
    where: eq(accessLogs.linkId, linkId),
    orderBy: desc(accessLogs.accessedAt),
  });

  // 3. Compute Aggregated Metrics
  const totalClicks = logs.length;
  const uniqueIPs = new Set(logs.map((l) => l.ip)).size;

  const clicksByDate: Record<string, number> = {};
  const browsers: Record<string, number> = {};
  const osList: Record<string, number> = {};
  const devices: Record<string, number> = {};
  const referrers: Record<string, number> = {};

  for (const log of logs) {
    // Group clicks by date (YYYY-MM-DD)
    const dateKey = log.accessedAt.toISOString().split("T")[0];
    clicksByDate[dateKey] = (clicksByDate[dateKey] || 0) + 1;

    // Parse User-Agent breakdown
    const parsed = parseUserAgent(log.userAgent);
    browsers[parsed.browser] = (browsers[parsed.browser] || 0) + 1;
    osList[parsed.os] = (osList[parsed.os] || 0) + 1;
    devices[parsed.device] = (devices[parsed.device] || 0) + 1;

    // Referrer breakdown
    let ref = "Direct / None";
    if (log.referrer) {
      try {
        ref = new URL(log.referrer).hostname || log.referrer;
      } catch {
        ref = log.referrer.slice(0, 50);
      }
    }
    referrers[ref] = (referrers[ref] || 0) + 1;
  }

  // 4. Return structured analytics payload
  return {
    linkId: link.id,
    slug: link.slug,
    noteTitle: link.note.title,
    summary: {
      totalClicks,
      uniqueVisitors: uniqueIPs,
      isBurned: link.isBurned,
      readsCount: link.readsCount,
      maxReads: link.maxReads,
    },
    breakdown: {
      clicksByDate,
      devices,
      browsers,
      operatingSystems: osList,
      topReferrers: referrers,
    },
    recentAccesses: logs.slice(0, 15).map((l) => ({
      ip: l.ip.includes(":") ? l.ip : l.ip.replace(/\.\d+$/, ".***"), // Anonymize IPv4 tail
      ...parseUserAgent(l.userAgent),
      referrer: l.referrer ?? "Direct",
      accessedAt: l.accessedAt,
    })),
  };
}

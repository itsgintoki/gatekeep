// ============================================================================
// [Phase 2 — Core domain] src/modules/links/links.service.ts — LINK LIFECYCLE
// See NAVIGATION.md Phase 2.3. WHAT: slug mint + passphrase hash + analytics.
// WHY hash (not encrypt) passphrase: verify-only. WHY 5× slug retry: 7-char
// collisions rare but possible. DESIGN: never return hash, only hasPassphrase.
// ----------------------------------------------------------------------------
// createLink: verifies note belongs to user -> verifies webhook belongs to
//   user (if any) -> argon2-hashes optional passphrase (same params as
//   passwords) -> generates collision-checked slug (5 tries) -> INSERT.
//   Response maps passphraseHash -> hasPassphrase (never leak the hash).
// listLinks: two-step (notes for titles, then links via inArray(noteIds))
//   because links carry no title themselves; noteTitleMap joins them in JS.
// getLink/deleteLink: ownership enforced by joining link.note and comparing
//   note.userId (404 if cross-user, avoiding user-enumeration).
// getLinkAnalytics: SEVEN parallel queries (Promise.all) over accessLogs:
//   totals + unique IPs, GROUP BYs for date/browser/os/device/referrer
//   (raw SQL fragments via drizzle sql`` for to_char/COALESCE), plus latest
//   15 logs. IPs partially masked (1.2.3.***), IPv6 shown fully (can't mask
//   the same way). toBreakdown() converts [{label,count}] -> {label:count}.
// ============================================================================
import argon2 from "argon2";
import { and, eq, isNull, desc, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index";
import { links, notes, accessLogs, webhooks } from "../../db/schema";
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
  if (data.webhookId) {
    const webhook = await db.query.webhooks.findFirst({
      where: and(
        eq(webhooks.id, data.webhookId),
        eq(webhooks.userId, userId)
      ),
      columns: { id: true },
    });
    if (!webhook) {
      throw Object.assign(new Error("Webhook not found"), { status: 404 });
    }
  }

  let passphraseHash: string | null = null;
  if (data.passphrase) {
    // Hash (not encrypt): verification only needs argon2.verify on unlock.
    passphraseHash = await argon2.hash(data.passphrase, ARGON2_OPTIONS);
  }

  // Short slugs can collide; retry with a fresh random value (5 attempts is
  // plenty at 7 chars / ~2T space). DB unique constraint is the final guard.
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
    hasPassphrase: Boolean(link.passphraseHash), // Don't expose the hash itself.
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

interface AggregationRow {
  label: string;
  count: number;
}

function toBreakdown(rows: AggregationRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.label, Number(row.count)]));
}

export async function getLinkAnalytics(linkId: string, userId: string) {
  const link = await db.query.links.findFirst({
    where: eq(links.id, linkId),
    with: {
      note: {
        columns: { userId: true, title: true, deletedAt: true },
      },
    },
  });

  // Same ownership guard as getLink: only the note owner sees analytics.
  if (!link || !link.note || link.note.userId !== userId || link.note.deletedAt !== null) {
    throw Object.assign(new Error("Link not found"), { status: 404 });
  }

  // SQL label expressions: COALESCE turns NULLs into "Unknown" buckets so
  // GROUP BY never drops rows; to_char buckets clicks per calendar day.
  const dateLabel = sql<string>`to_char(${accessLogs.accessedAt}, 'YYYY-MM-DD')`;
  const browserLabel = sql<string>`COALESCE(${accessLogs.browser}, 'Unknown')`;
  const osLabel = sql<string>`COALESCE(${accessLogs.os}, 'Unknown')`;
  const deviceLabel = sql<string>`COALESCE(${accessLogs.device}, 'unknown')`;
  const referrerLabel = sql<string>`COALESCE(${accessLogs.referrerHost}, 'Direct / None')`;
  const condition = eq(accessLogs.linkId, linkId);

  const [
    summaryRows,
    clicksByDateRows,
    browserRows,
    osRows,
    deviceRows,
    referrerRows,
    recentLogs,
  ] = await Promise.all([
    db
      .select({
        totalClicks: sql<number>`count(*)::int`,
        uniqueVisitors: sql<number>`count(DISTINCT ${accessLogs.ip})::int`,
      })
      .from(accessLogs)
      .where(condition),
    db
      .select({ label: dateLabel, count: sql<number>`count(*)::int` })
      .from(accessLogs)
      .where(condition)
      .groupBy(dateLabel),
    db
      .select({ label: browserLabel, count: sql<number>`count(*)::int` })
      .from(accessLogs)
      .where(condition)
      .groupBy(browserLabel),
    db
      .select({ label: osLabel, count: sql<number>`count(*)::int` })
      .from(accessLogs)
      .where(condition)
      .groupBy(osLabel),
    db
      .select({ label: deviceLabel, count: sql<number>`count(*)::int` })
      .from(accessLogs)
      .where(condition)
      .groupBy(deviceLabel),
    db
      .select({ label: referrerLabel, count: sql<number>`count(*)::int` })
      .from(accessLogs)
      .where(condition)
      .groupBy(referrerLabel),
    db.query.accessLogs.findMany({
      where: condition,
      orderBy: desc(accessLogs.accessedAt),
      limit: 15,
    }),
  ]);

  const summary = summaryRows[0] ?? { totalClicks: 0, uniqueVisitors: 0 }; // No views yet -> zeros.
  return {
    linkId: link.id,
    slug: link.slug,
    noteTitle: link.note.title,
    summary: {
      totalClicks: Number(summary.totalClicks), // pg count() returns string; coerce.
      uniqueVisitors: Number(summary.uniqueVisitors), // DISTINCT ip count.
      isBurned: link.isBurned,
      readsCount: link.readsCount,
      maxReads: link.maxReads,
    },
    breakdown: {
      clicksByDate: toBreakdown(clicksByDateRows),
      devices: toBreakdown(deviceRows),
      browsers: toBreakdown(browserRows),
      operatingSystems: toBreakdown(osRows),
      topReferrers: toBreakdown(referrerRows),
    },
    recentAccesses: recentLogs.map((log) => {
      const parsed = parseUserAgent(log.userAgent); // Backfill if row predates parsing.
      return {
        ip: log.ip.includes(":") ? log.ip : log.ip.replace(/\.\d+$/, ".***"), // Mask last IPv4 octet (privacy).
        browser: log.browser ?? parsed.browser,
        os: log.os ?? parsed.os,
        device: log.device ?? parsed.device,
        referrer: log.referrer ?? "Direct",
        accessedAt: log.accessedAt,
      };
    }),
  };
}

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

  if (!link || !link.note || link.note.userId !== userId || link.note.deletedAt !== null) {
    throw Object.assign(new Error("Link not found"), { status: 404 });
  }

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

  const summary = summaryRows[0] ?? { totalClicks: 0, uniqueVisitors: 0 };
  return {
    linkId: link.id,
    slug: link.slug,
    noteTitle: link.note.title,
    summary: {
      totalClicks: Number(summary.totalClicks),
      uniqueVisitors: Number(summary.uniqueVisitors),
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
      const parsed = parseUserAgent(log.userAgent);
      return {
        ip: log.ip.includes(":") ? log.ip : log.ip.replace(/\.\d+$/, ".***"),
        browser: log.browser ?? parsed.browser,
        os: log.os ?? parsed.os,
        device: log.device ?? parsed.device,
        referrer: log.referrer ?? "Direct",
        accessedAt: log.accessedAt,
      };
    }),
  };
}

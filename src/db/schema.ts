// ============================================================================
// [Phase 1 — Foundation] src/db/schema.ts — SINGLE SOURCE OF TRUTH
// See NAVIGATION.md Phase 1.3. WHAT: 8 tables, graph users→notes→links.
// WHY one file: one mental model, typed queries everywhere.
// DESIGN: soft-delete preserves history; links.* columns = burn engine;
// webhook_deliveries = outbox queue, not a log.
// ----------------------------------------------------------------------------
// Uses Drizzle ORM `pgTable` (code-first schema -> generates SQL migrations
// in /drizzle via `npm run db:generate`). Tables form this graph:
//
//   users 1───* notes 1───* attachments
//     │            │
//     │            └───* links *───* accessLogs (one row per view)
//     │                    │
//     └──* webhooks ───────┘ (optional: link.webhookId -> notify on view)
//     └──* refreshTokens (hashed JWT refresh tokens, revocable sessions)
//
// KEY PATTERNS:
// - Soft delete: notes.deletedAt (never hard-deleted, preserves link history).
// - Burn-on-read: links.isBurned + readsCount/maxReads + expiresAt (see
//   resolve.service.ts consumeLink for the atomic increment).
// - Webhook outbox: webhook_deliveries holds queued events until the worker
//   in lib/webhook.ts marks them delivered/failed.
// - Relations bottom + $inferSelect types: give you typed db.query.* access.
// ============================================================================
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// users: one row per account. Passwords NEVER stored raw — see auth.service.ts (argon2).
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 255 }).default("").notNull(),
  lastName: varchar("last_name", { length: 255 }).default("").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// refresh_tokens: server-side session store. Only SHA-256 hash of the JWT is
// saved (see lib/jwt.ts hashToken) so a DB leak doesn't yield usable tokens.
// isRevoked enables logout + logout-all without waiting for expiry.
export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// webhooks: user-registered HTTPS endpoints to notify on link events.
// secret is used for HMAC signing (X-GateKeep-Signature-256 header).
export const webhooks = pgTable("webhooks", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// notes: the core content. content may be plaintext OR AES-256-GCM ciphertext
// (see lib/crypto.ts). isEncrypted tells the UI to prompt for a passphrase.
// deletedAt = soft delete; queries always filter isNull(deletedAt).
export const notes = pgTable("notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  isEncrypted: boolean("is_encrypted").default(false).notNull(),
  isPinned: boolean("is_pinned").default(false).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// attachments: file metadata; actual bytes live in Supabase Storage.
// storagePath = "<userId>/<noteId>/<uuid>" key inside the bucket.
export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  noteId: uuid("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  storagePath: text("storage_path").notNull(),
  originalName: text("original_name").default("Attachment").notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// links: public share URLs (/share/:slug). slug is a short base62 id (unique).
// passphraseHash (argon2, nullable) gates access; expiresAt/maxReads/isBurned
// implement burn-after-reading; readsCount is atomically incremented.
// webhookId (nullable, SET NULL on delete) optionally fires notifications.
export const links = pgTable("links", {
  id: uuid("id").defaultRandom().primaryKey(),
  noteId: uuid("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  slug: varchar("slug", { length: 20 }).notNull().unique(),
  passphraseHash: text("passphrase_hash"),
  expiresAt: timestamp("expires_at"),
  maxReads: integer("max_reads"),
  readsCount: integer("reads_count").default(0).notNull(),
  isBurned: boolean("is_burned").default(false).notNull(),
  webhookId: uuid("webhook_id").references(() => webhooks.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// accessLogs: analytics row per successful link view (IP, UA, referrer +
// pre-parsed browser/os/device). Indexed on (linkId, accessedAt) for the
// dashboard queries in links.service.ts getLinkAnalytics.
export const accessLogs = pgTable(
  "access_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => links.id, { onDelete: "cascade" }),
    ip: varchar("ip", { length: 45 }).notNull(),
    userAgent: text("user_agent"),
    referrer: text("referrer"),
    browser: varchar("browser", { length: 100 }),
    os: varchar("os", { length: 100 }),
    device: varchar("device", { length: 20 }),
    referrerHost: text("referrer_host"),
    accessedAt: timestamp("accessed_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_access_logs_link_accessed").on(table.linkId, table.accessedAt),
  ]
);

// webhook_deliveries: durable outbox queue. Flow:
// INSERT (pending, nextAttemptAt=now) -> worker CLAIMS (lockedAt, attempts++)
// -> POST -> deliveredAt OR reschedule with exponential backoff, up to 5 tries
// then failedAt. Index on (deliveredAt, failedAt, nextAttemptAt) finds due rows.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 50 })
      .$type<"link.accessed" | "link.burned">()
      .notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    deliveredAt: timestamp("delivered_at"),
    failedAt: timestamp("failed_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_webhook_deliveries_due").on(
      table.deliveredAt,
      table.failedAt,
      table.nextAttemptAt
    ),
  ]
);

// --- Drizzle relations: enable typed joins via db.query.<table>.findMany({ with }) ---
export const usersRelations = relations(users, ({ many }) => ({
  notes: many(notes),
  webhooks: many(webhooks),
  refreshTokens: many(refreshTokens),
}));

export const notesRelations = relations(notes, ({ one, many }) => ({
  user: one(users, { fields: [notes.userId], references: [users.id] }),
  links: many(links),
  attachments: many(attachments),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  note: one(notes, { fields: [attachments.noteId], references: [notes.id] }),
}));

export const linksRelations = relations(links, ({ one, many }) => ({
  note: one(notes, { fields: [links.noteId], references: [notes.id] }),
  accessLogs: many(accessLogs),
  webhook: one(webhooks, { fields: [links.webhookId], references: [webhooks.id] }),
}));

export const accessLogsRelations = relations(accessLogs, ({ one }) => ({
  link: one(links, { fields: [accessLogs.linkId], references: [links.id] }),
}));

export const webhooksRelations = relations(webhooks, ({ one, many }) => ({
  user: one(users, { fields: [webhooks.userId], references: [users.id] }),
  links: many(links),
  deliveries: many(webhookDeliveries),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  webhook: one(webhooks, {
    fields: [webhookDeliveries.webhookId],
    references: [webhooks.id],
  }),
}));

// --- Type helpers: $inferSelect = row shape, $inferInsert = insert shape ---
// Import these in services instead of re-declaring interfaces.
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
export type AccessLog = typeof accessLogs.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

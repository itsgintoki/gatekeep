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

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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

export const webhooks = pgTable("webhooks", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notes = pgTable("notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  isEncrypted: boolean("is_encrypted").default(false).notNull(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  noteId: uuid("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  cloudinaryPublicId: text("cloudinary_public_id").notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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

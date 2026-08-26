import { z } from "zod";

export const createLinkSchema = z.object({
  noteId: z.string().uuid("Invalid note ID"),
  passphrase: z.string().min(4, "Link passphrase must be at least 4 characters").max(128).optional(),
  expiresAt: z.coerce.date().optional().refine(
    (date) => !date || date.getTime() > Date.now(),
    { message: "Expiration date must be in the future" }
  ),
  maxReads: z.number().int().min(1, "Max reads must be at least 1").max(1_000_000).optional(),
  webhookId: z.string().uuid("Invalid webhook ID").optional(),
});

export const listLinksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateLinkInput = z.infer<typeof createLinkSchema>;

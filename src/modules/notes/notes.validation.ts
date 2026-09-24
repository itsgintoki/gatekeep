import { z } from "zod";

export const createNoteSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(255),
  content: z.string().trim().min(1, "Content is required").max(50000),
  passphrase: z.string().min(4, "Passphrase must be at least 4 characters").max(128).optional(),
});

export const updateNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    content: z.string().trim().min(1).max(50000).optional(),
    isPinned: z.boolean().optional(),
    currentPassphrase: z.string().min(1).max(128).optional(),
    newPassphrase: z
      .string()
      .min(4, "New passphrase must be at least 4 characters")
      .max(128)
      .nullable()
      .optional(),
  })
  .refine(
    (data) =>
      data.title !== undefined ||
      data.content !== undefined ||
      data.newPassphrase !== undefined || data.isPinned !== undefined,
    { message: "At least one update must be provided" }
  );

export const decryptNoteSchema = z.object({
  passphrase: z.string().min(1, "Passphrase is required"),
});

export const listNotesQuerySchema = z.object({
  search: z.string().trim().max(255).default(""),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type DecryptNoteInput = z.infer<typeof decryptNoteSchema>;

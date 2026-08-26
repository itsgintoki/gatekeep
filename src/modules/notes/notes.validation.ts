import { z } from "zod";

export const createNoteSchema = z.object({
  title: z.string().min(1, "Title is required").max(255).trim(),
  content: z.string().min(1, "Content is required").trim(),
  passphrase: z.string().min(4, "Passphrase must be at least 4 characters").max(128).optional(),
});

export const updateNoteSchema = z
  .object({
    title: z.string().min(1).max(255).trim().optional(),
    content: z.string().min(1).trim().optional(),
    passphrase: z.string().min(4, "Passphrase must be at least 4 characters").max(128).optional(),
  })
  .refine((d) => d.title !== undefined || d.content !== undefined || d.passphrase !== undefined, {
    message: "At least one of title, content, or passphrase must be provided",
  });

export const decryptNoteSchema = z.object({
  passphrase: z.string().min(1, "Passphrase is required"),
});

export const listNotesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type DecryptNoteInput = z.infer<typeof decryptNoteSchema>;

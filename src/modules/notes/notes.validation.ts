import { z } from "zod";

export const createNoteSchema = z.object({
  title: z.string().min(1, "Title is required").max(255).trim(),
  content: z.string().min(1, "Content is required").trim(),
});

export const updateNoteSchema = z
  .object({
    title: z.string().min(1).max(255).trim().optional(),
    content: z.string().min(1).trim().optional(),
  })
  .refine((d) => d.title !== undefined || d.content !== undefined, {
    message: "At least one of title or content must be provided",
  });

export const listNotesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

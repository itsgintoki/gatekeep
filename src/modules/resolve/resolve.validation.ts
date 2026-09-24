import { z } from "zod";

export const accessLinkSchema = z.object({
  passphrase: z.string().min(1, "Passphrase cannot be empty").max(128).optional(),
  notePassphrase: z.string().min(1, "Note passphrase cannot be empty").max(128).optional(),
});

export type AccessLinkInput = z.infer<typeof accessLinkSchema>;

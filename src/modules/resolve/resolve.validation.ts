// Both fields optional: unprotected links send {}. notePassphrase is SEPARATE
// from the link gate — a note can be end-to-end encrypted AND shared behind
// its own link passphrase (two passwords, two layers).
import { z } from "zod";

export const accessLinkSchema = z.object({
  passphrase: z.string().min(1, "Passphrase cannot be empty").max(128).optional(),
  notePassphrase: z.string().min(1, "Note passphrase cannot be empty").max(128).optional(),
});

export type AccessLinkInput = z.infer<typeof accessLinkSchema>;
